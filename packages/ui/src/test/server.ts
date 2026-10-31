// テスト用の偽のサーバー: globalThis.fetch を差し替え、7.4 の API の一部をメモリの上で動かす。
// 呼ばれたリクエストは calls に残るので、呼び出し先と本文を確かめられる。
import { vi } from "vitest";
import { can, type FileDetail, type PresenceEntry, type FileSummary, type Invitation, type InviteRole, type Member, type Role, type User } from "@untie/api";
import { emptyModel } from "@untie/core/model/types";
import { serializeModel } from "../io/document";

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export const user: User = { id: "u1", email: "me@example.com", name: "テスト太郎" };

export function summary(overrides: Partial<FileSummary> & { id: string }): FileSummary {
  return {
    name: overrides.id,
    ownerId: "u1",
    ownerName: "テスト太郎",
    role: "owner",
    memberCount: 1,
    updatedAt: Date.now() - 3 * 60_000,
    createdAt: Date.now() - 86_400_000,
    ...overrides,
  };
}

/** ファイルごとの共有の状態 (owner だけが見る members / invitations / link) */
export interface FakeShare {
  members: Member[];
  invitations: Invitation[];
  /** リンク閲覧のトークン。null なら無効 */
  linkToken: string | null;
}

/** 偽サーバーが覚えている招待 (トークンで引く) */
export interface FakeInvitation {
  fileId: string;
  fileName: string;
  email: string;
  role: InviteRole;
  inviterName: string;
  expiresAt: number;
  /** 共有の状態の invitations に載っている id (API で作った招待だけ) */
  invitationId?: string;
  /** 受け終わったか。受けたあとも info は 200 で、まだメンバーなら accept も 200 (冪等)。外されていれば accept は 410 invitation_used */
  accepted?: boolean;
}

export const member = (userId: string, name: string, role: Member["role"], email = `${userId}@example.com`): Member => ({
  userId,
  email,
  name,
  role,
  addedAt: Date.now() - 86_400_000,
});

export interface FakeServer {
  calls: FakeCall[];
  mine: FileSummary[];
  shared: FileSummary[];
  trash: FileSummary[];
  /** 自分のファイルでも共有されたファイルでもない、他人のファイル (リンクだけで開ける) */
  others: FileSummary[];
  /** ファイル id ごとの共有の状態。無いファイルは「所有者 1 人・招待なし・リンクなし」 */
  shares: Record<string, FakeShare>;
  /** 登録済みのユーザー (招待したときにその場でメンバーになる人) */
  users: User[];
  /** 招待のトークン → 中身 */
  inviteTokens: Record<string, FakeInvitation>;
  /** ファイル id → いまルームにつながっている人 (GET /presence の答え)。無ければ空 */
  presence: Record<string, PresenceEntry[]>;
  /** 未ログイン (GET /api/me を 401 にする) */
  signedIn: boolean;
  providers: string[];
  /** 招待・リンクの URL の元になるオリジン */
  appOrigin: string;
  /** 401 に載せる code ("unauthenticated" か、セッション切れの "session_expired") */
  unauthorizedCode: "unauthenticated" | "session_expired";
  /** パスごとの上書き。返した Response をそのまま使う (失敗のテスト用)。"METHOD /path" で指す */
  overrides: Record<string, () => Response | Promise<Response>>;
  /** fetch を元に戻す */
  restore: () => void;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const apiError = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

export function fakeServer(initial: Partial<Pick<FakeServer, "mine" | "shared" | "trash" | "signedIn" | "providers">> = {}): FakeServer {
  const original = globalThis.fetch;
  let seq = 0;
  const s: FakeServer = {
    calls: [],
    mine: [],
    shared: [],
    trash: [],
    others: [],
    shares: {},
    users: [],
    inviteTokens: {},
    presence: {},
    signedIn: true,
    providers: ["dev"],
    appOrigin: "http://test",
    unauthorizedCode: "unauthenticated",
    overrides: {},
    restore: () => {
      globalThis.fetch = original;
    },
    ...initial,
  };

  const unauthorized = () =>
    apiError(401, s.unauthorizedCode, s.unauthorizedCode === "session_expired" ? "ログインの有効期限が切れました" : "ログインしてください");
  const forbidden = () => apiError(403, "forbidden", "この操作をする権限がありません");

  const noContent = () => new Response(null, { status: 204 });
  const findFile = (id: string) => [...s.mine, ...s.shared].find((f) => f.id === id);
  /** 共有の状態。無ければ所有者だけの状態を作る */
  const shareOf = (file: FileSummary): FakeShare => {
    s.shares[file.id] ??= {
      members: [member(file.ownerId, file.ownerName, "owner", file.ownerId === user.id ? user.email : undefined)],
      invitations: [],
      linkToken: null,
    };
    return s.shares[file.id]!;
  };
  /** 一覧の memberCount と自分の役割を、共有の状態に合わせる */
  const syncCount = (file: FileSummary) => {
    const count = shareOf(file).members.length;
    const update = (f: FileSummary) => (f.id === file.id ? { ...f, memberCount: count } : f);
    s.mine = s.mine.map(update);
    s.shared = s.shared.map(update);
  };
  const detailOf = (file: FileSummary): FileDetail => {
    if (!can(file.role, "manageMembers")) return file;
    const sh = shareOf(file);
    return { ...file, members: sh.members, invitations: sh.invitations, link: { enabled: sh.linkToken !== null } };
  };
  const makeInvite = (kind: "invitation") => `${kind}${++seq}`;

  /** 共有まわり (7.4): メンバー・譲渡・招待・リンク。ゴミ箱の中は owner でも 409 */
  const handleShare = (method: string, file: FileSummary, rest: string, body: unknown): Response | null => {
    const inTrash = s.trash.some((f) => f.id === file.id);
    const sh = shareOf(file);
    const owner = can(file.role, "manageMembers");
    let m: RegExpExecArray | null;
    if ((m = /^members\/([^/]+)$/.exec(rest))) {
      const userId = decodeURIComponent(m[1]!);
      if (method === "DELETE") {
        const self = userId === user.id;
        if (!(owner || (self && can(file.role, "leave")))) return forbidden();
        if (inTrash) return apiError(409, "in_trash", "ゴミ箱の中のファイルです");
        const target = sh.members.find((x) => x.userId === userId);
        if (!target) return apiError(404, "member_not_found", "メンバーが見つかりません");
        if (target.role === "owner") return apiError(409, "transfer_first", "所有者を外すには、先に所有者を譲ってください");
        sh.members = sh.members.filter((x) => x.userId !== userId);
        if (self) s.shared = s.shared.filter((f) => f.id !== file.id);
        else syncCount(file);
        return noContent();
      }
      if (method === "PUT") {
        if (!owner) return forbidden();
        if (inTrash) return apiError(409, "in_trash", "ゴミ箱の中のファイルです");
        const role = (body as { role: InviteRole }).role;
        const existing = sh.members.find((x) => x.userId === userId);
        if (existing?.role === "owner") return apiError(409, "owner_role_fixed", "所有者の役割は変えられません");
        const registered = s.users.find((u) => u.id === userId);
        if (!existing && !registered) return apiError(404, "user_not_found", "ユーザーが見つかりません");
        const next = existing ? { ...existing, role } : member(userId, registered!.name, role, registered!.email);
        sh.members = existing ? sh.members.map((x) => (x.userId === userId ? next : x)) : [...sh.members, next];
        syncCount(file);
        return json(next);
      }
    }
    if (method === "POST" && rest === "transfer") {
      if (!owner) return forbidden();
      if (inTrash) return apiError(409, "in_trash", "ゴミ箱の中のファイルです");
      const userId = (body as { userId: string }).userId;
      if (userId === user.id) return apiError(409, "already_owner", "すでに所有者です");
      const target = sh.members.find((x) => x.userId === userId);
      if (!target) return apiError(404, "member_not_found", "メンバーが見つかりません");
      sh.members = sh.members.map((x) => (x.userId === userId ? { ...x, role: "owner" } : x.userId === user.id ? { ...x, role: "editor" } : x));
      const moved: FileSummary = { ...file, ownerId: target.userId, ownerName: target.name, role: "editor" };
      s.mine = s.mine.filter((f) => f.id !== file.id);
      s.shared = [moved, ...s.shared];
      return json(moved);
    }
    if ((m = /^invitations(?:\/([^/]+))?$/.exec(rest))) {
      if (!owner) return forbidden();
      if (inTrash) return apiError(409, "in_trash", "ゴミ箱の中のファイルです");
      if (method === "DELETE" && m[1]) {
        const id = decodeURIComponent(m[1]);
        if (!sh.invitations.some((i) => i.id === id)) return apiError(404, "invitation_not_found", "招待が見つかりません");
        sh.invitations = sh.invitations.filter((i) => i.id !== id);
        for (const [token, inv] of Object.entries(s.inviteTokens)) if (inv.invitationId === id) delete s.inviteTokens[token];
        return noContent();
      }
      if (method === "POST" && !m[1]) {
        const { email, role } = body as { email: string; role: InviteRole };
        const address = email.trim().toLowerCase();
        if (address === user.email) return apiError(409, "already_owner", "自分は所有者です");
        const registered = s.users.find((u) => u.email === address);
        if (registered) {
          // そのメール宛の未承諾の招待は消す (すでにメンバーになったので)
          for (const old of sh.invitations.filter((i) => i.email === address)) {
            for (const [t, inv] of Object.entries(s.inviteTokens)) if (inv.invitationId === old.id) delete s.inviteTokens[t];
          }
          sh.invitations = sh.invitations.filter((i) => i.email !== address);
          const existing = sh.members.find((x) => x.userId === registered.id);
          sh.members = existing
            ? sh.members.map((x) => (x.userId === registered.id ? { ...x, role } : x))
            : [...sh.members, member(registered.id, registered.name, role, registered.email)];
          syncCount(file);
          return json({ kind: "member", userId: registered.id });
        }
        const id = makeInvite("invitation");
        const token = `tok-${id}`;
        // 同じメールの未承諾の招待は置き換える
        for (const old of sh.invitations.filter((i) => i.email === address)) {
          for (const [t, inv] of Object.entries(s.inviteTokens)) if (inv.invitationId === old.id) delete s.inviteTokens[t];
        }
        sh.invitations = [...sh.invitations.filter((i) => i.email !== address), { id, email: address, role, createdAt: Date.now(), expiresAt: Date.now() + 14 * 86_400_000 }];
        s.inviteTokens[token] = { fileId: file.id, fileName: file.name, email: address, role, inviterName: user.name, expiresAt: Date.now() + 14 * 86_400_000, invitationId: id };
        return json({ kind: "invitation", invitationId: id, url: `${s.appOrigin}/#/invite/${token}` }, 201);
      }
    }
    if (rest === "link") {
      if (!owner) return forbidden();
      if (inTrash) return apiError(409, "in_trash", "ゴミ箱の中のファイルです");
      if (method === "PUT") {
        const regenerate = (body as { regenerate?: boolean } | undefined)?.regenerate === true;
        if (sh.linkToken && !regenerate) return json({ enabled: true });
        sh.linkToken = `link-${++seq}`;
        return json({ enabled: true, url: `${s.appOrigin}/#/link/${sh.linkToken}` });
      }
      if (method === "DELETE") {
        sh.linkToken = null;
        return noContent();
      }
    }
    return null;
  };

  /** リンク・招待のトークンを運ぶヘッダー (X-Untie-Token) */
  const tokenOf = (headers: Record<string, string>) => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "x-untie-token");
    return key ? headers[key]!.trim() : "";
  };

  /** /api/links/*: セッションが無くても通る (ゲスト)。複製だけはログインが要る */
  const handleLink = (method: string, path: string, token: string): Response => {
    // 複製だけはセッションが要る。トークンの検めより先に 401
    if (method === "POST" && path === "/api/links/duplicate" && !s.signedIn) return unauthorized();
    const found = Object.entries(s.shares).find(([, sh]) => token !== "" && sh.linkToken === token);
    const file = found ? [...s.mine, ...s.shared, ...s.others].find((f) => f.id === found[0]) : undefined;
    if (!file) return apiError(404, "link_not_found", "リンクが見つかりません");
    // メンバーならその役割、それ以外 (未ログイン・メンバーでない) は guest
    const mine = s.signedIn ? findFile(file.id) : undefined;
    const role: Role = mine ? mine.role : "guest";
    if (method === "GET" && path === "/api/links/info") return json({ fileId: file.id, name: file.name, role });
    if (method === "POST" && path === "/api/links/ticket") return json({ ticket: `ticket-link-${file.id}`, role, expiresAt: Date.now() + 60_000 });
    if (method === "GET" && path === "/api/links/export") {
      const model = emptyModel();
      model.meta.name = file.name;
      return new Response(serializeModel(model), {
        headers: { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}.json` },
      });
    }
    if (method === "GET" && path === "/api/links/presence") return json({ presence: s.presence[file.id] ?? [] });
    if (method === "POST" && path === "/api/links/duplicate") {
      const copy = summary({ id: `new${++seq}`, name: `${file.name} のコピー` });
      s.mine = [copy, ...s.mine];
      return json(copy, 201);
    }
    return apiError(404, "not_found", "見つかりません");
  };

  /** /api/invitations/*: ログインが要る。メールが違えば 403 */
  const handleInvitation = (method: string, path: string, token: string): Response => {
    const inv = s.inviteTokens[token];
    if (!inv) return apiError(404, "invitation_not_found", "招待が見つかりません");
    if (inv.email !== user.email) return apiError(403, "email_mismatch", "この招待は別のメールアドレス宛です");
    const expired = inv.expiresAt <= Date.now();
    if (method === "GET" && path === "/api/invitations/info") {
      return json({ fileName: inv.fileName, role: inv.role, email: inv.email, inviterName: inv.inviterName, expired });
    }
    if (method === "POST" && path === "/api/invitations/accept") {
      const existing = findFile(inv.fileId);
      // 受け終わったあと: まだメンバーなら同じ結果 (冪等)、外されていれば 410 invitation_used
      if (inv.accepted) {
        return existing ? json({ fileId: inv.fileId }) : apiError(410, "invitation_used", "この招待はすでに使われています");
      }
      if (expired) return apiError(410, "invitation_expired", "招待の期限が切れています");
      if (!existing) {
        s.shared = [summary({ id: inv.fileId, name: inv.fileName, ownerId: "u9", ownerName: inv.inviterName, role: inv.role, memberCount: 2 }), ...s.shared];
      }
      inv.accepted = true;
      return json({ fileId: inv.fileId });
    }
    return apiError(404, "not_found", "見つかりません");
  };

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    s.calls.push({ method, path, body, headers });

    const override = s.overrides[`${method} ${path}`];
    if (override) return override();

    if (method === "GET" && path === "/auth/providers") return json({ providers: s.providers });
    if (method === "GET" && path === "/api/me") return s.signedIn ? json(user) : unauthorized();
    if (method === "POST" && path === "/auth/logout") {
      s.signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/auth/logout-all") {
      // logout-all だけはセッションが要る (logout はセッションが無くても 204)
      if (!s.signedIn) return unauthorized();
      s.signedIn = false;
      return new Response(null, { status: 204 });
    }
    // リンク閲覧はセッションが無くても通る
    if (path.startsWith("/api/links/")) return handleLink(method, path, tokenOf(headers));
    if (!s.signedIn && path.startsWith("/api/")) return unauthorized();
    if (path.startsWith("/api/invitations/")) return handleInvitation(method, path, tokenOf(headers));

    if (method === "GET" && path === "/api/files") return json({ mine: s.mine, shared: s.shared });
    if (method === "GET" && path === "/api/files/trash") return json({ files: s.trash });
    if (method === "POST" && path === "/api/files") {
      const name = (body as { name?: string; model?: { meta?: { name?: string } } }).name ?? (body as { model: { meta: { name: string } } }).model.meta.name;
      const file = summary({ id: `new${++seq}`, name });
      s.mine = [file, ...s.mine];
      return json(file, 201);
    }
    const shareMatch = /^\/api\/files\/([^/]+)\/(members\/[^/]+|transfer|invitations(?:\/[^/]+)?|link)$/.exec(path);
    if (shareMatch) {
      const file = [...s.mine, ...s.shared, ...s.trash].find((f) => f.id === decodeURIComponent(shareMatch[1]!));
      if (!file) return apiError(404, "file_not_found", "ファイルが見つかりません");
      return handleShare(method, file, shareMatch[2]!, body) ?? apiError(404, "not_found", "見つかりません");
    }
    const m = /^\/api\/files\/([^/]+)(?:\/(duplicate|restore|purge|export|ticket|presence))?$/.exec(path);
    if (m) {
      const [, id, action] = m;
      const all = [...s.mine, ...s.shared];
      const file = all.find((f) => f.id === id) ?? s.trash.find((f) => f.id === id);
      if (!file) return apiError(404, "file_not_found", "ファイルが見つかりません");
      // ルームに接続するチケット。ゴミ箱の中のファイルは owner にも 409 (戻せば開ける)
      if (method === "POST" && action === "ticket") {
        if (s.trash.some((f) => f.id === id)) return apiError(409, "in_trash", "ゴミ箱の中のファイルです");
        return json({ ticket: `ticket-${id}`, role: file.role, expiresAt: Date.now() + 60_000 });
      }
      if (method === "GET" && action === "presence") {
        if (s.trash.some((f) => f.id === id)) return apiError(409, "in_trash", "ゴミ箱の中のファイルです");
        return json({ presence: s.presence[file.id] ?? [] });
      }
      // 1 件の情報。owner にだけ members / invitations / link が付く
      if (method === "GET" && !action) return json(detailOf(file));
      // 役割の規則は本物と同じ (名前変更は editor 以上、ゴミ箱の操作は owner だけ)
      if (method === "PATCH" && file.role !== "owner" && file.role !== "editor") return forbidden();
      if (((method === "DELETE" && !action) || action === "restore" || action === "purge") && file.role !== "owner") return forbidden();
      if (method === "PATCH") {
        const renamed = { ...file, name: (body as { name: string }).name };
        s.mine = s.mine.map((f) => (f.id === id ? renamed : f));
        s.shared = s.shared.map((f) => (f.id === id ? renamed : f));
        return json(renamed);
      }
      if (method === "DELETE" && !action) {
        s.mine = s.mine.filter((f) => f.id !== id);
        s.trash = [{ ...file, deletedAt: Date.now() }, ...s.trash];
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && action === "restore") {
        s.trash = s.trash.filter((f) => f.id !== id);
        s.mine = [{ ...file, deletedAt: undefined }, ...s.mine];
        const { deletedAt: _deletedAt, ...restored } = file;
        return json(restored);
      }
      if (method === "DELETE" && action === "purge") {
        s.trash = s.trash.filter((f) => f.id !== id);
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && action === "duplicate") {
        const copy = summary({ id: `new${++seq}`, name: `${file.name} のコピー` });
        s.mine = [copy, ...s.mine];
        return json(copy, 201);
      }
      if (method === "GET" && action === "export") {
        const model = emptyModel();
        model.meta.name = file.name;
        return new Response(serializeModel(model), {
          headers: { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}.json` },
        });
      }
    }
    return apiError(404, "not_found", "見つかりません");
  }) as unknown as typeof fetch;

  return s;
}
