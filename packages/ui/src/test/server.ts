// テスト用の偽のサーバー: globalThis.fetch を差し替え、7.4 の API の一部をメモリの上で動かす。
// 呼ばれたリクエストは calls に残るので、呼び出し先と本文を確かめられる。
import { vi } from "vitest";
import type { FileSummary, User } from "@untie/api";
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

export interface FakeServer {
  calls: FakeCall[];
  mine: FileSummary[];
  shared: FileSummary[];
  trash: FileSummary[];
  /** 未ログイン (GET /api/me を 401 にする) */
  signedIn: boolean;
  providers: string[];
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
    signedIn: true,
    providers: ["dev"],
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

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    s.calls.push({ method, path, body, headers: (init.headers ?? {}) as Record<string, string> });

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
    if (!s.signedIn && path.startsWith("/api/")) return unauthorized();

    if (method === "GET" && path === "/api/files") return json({ mine: s.mine, shared: s.shared });
    if (method === "GET" && path === "/api/files/trash") return json({ files: s.trash });
    if (method === "POST" && path === "/api/files") {
      const name = (body as { name?: string; model?: { meta?: { name?: string } } }).name ?? (body as { model: { meta: { name: string } } }).model.meta.name;
      const file = summary({ id: `new${++seq}`, name });
      s.mine = [file, ...s.mine];
      return json(file, 201);
    }
    const m = /^\/api\/files\/([^/]+)(?:\/(duplicate|restore|purge|export))?$/.exec(path);
    if (m) {
      const [, id, action] = m;
      const all = [...s.mine, ...s.shared];
      const file = all.find((f) => f.id === id) ?? s.trash.find((f) => f.id === id);
      if (!file) return apiError(404, "file_not_found", "ファイルが見つかりません");
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
