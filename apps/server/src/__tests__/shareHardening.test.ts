// 共有 API のレビュー指摘への対応 (kick の失敗・再試行、並行安全、ゴミ箱、リンクからの複製、Bearer など)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../auth/crypto";
import { transferOwner } from "../db/members";
import { callWorker, env, loginAs, resetDb, userIdOf } from "./helpers";
import type { Client } from "./helpers";
import { closeAllClients } from "./roomClient";
import { createFile, share, tok, tokenOf } from "./shareHelpers";

beforeEach(resetDb);
afterEach(() => {
  closeAllClients();
  vi.restoreAllMocks();
});

const roleOf = async (fileId: string, userId: string) =>
  (await env.DB.prepare("select role from file_members where file_id = ? and user_id = ?").bind(fileId, userId).first<{ role: string }>())?.role ?? null;

/** kick を記録し、fail なら例外にする偽のルーム名前空間。同じユーザーでログインし直して、このルームで API を呼ぶ */
function fakeRooms(fail: boolean) {
  const kicks: unknown[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      setName: async () => {},
      kick: async (target: unknown) => {
        kicks.push(target);
        if (fail) throw new Error("kick に失敗");
        return 0;
      },
    }),
  };
  return { kicks, namespace: namespace as never };
}

async function enableLink(owner: Client, fileId: string) {
  const { body } = await owner.json(`/api/files/${fileId}/link`, { method: "PUT", json: {} });
  return tokenOf(body.url, "link");
}

describe("kick の失敗と再試行", () => {
  it("kick が失敗しても D1 は変わっていて、2xx を返す (ログに出すだけ)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const jiro = await loginAs("jiro@example.com");
    const id = await createFile(taro);
    const hanakoId = await share(taro, id, hanako, "editor");
    const jiroId = await share(taro, id, jiro, "viewer");
    const { kicks, namespace } = fakeRooms(true);
    const owner = await loginAs("taro@example.com", "", { UntieRoom: namespace });

    expect((await owner.json(`/api/files/${id}/members/${hanakoId}`, { method: "PUT", json: { role: "viewer" } })).status).toBe(200);
    expect(await roleOf(id, hanakoId)).toBe("viewer");
    expect((await owner.json(`/api/files/${id}/invitations`, { method: "POST", json: { email: "jiro@example.com", role: "editor" } })).status).toBe(200);
    expect(await roleOf(id, jiroId)).toBe("editor");
    expect((await owner.json(`/api/files/${id}/link`, { method: "PUT", json: { regenerate: true } })).status).toBe(200);
    expect((await owner.fetch(`/api/files/${id}/link`, { method: "DELETE" })).status).toBe(204);
    expect((await owner.fetch(`/api/files/${id}/members/${jiroId}`, { method: "DELETE" })).status).toBe(204);
    expect(await roleOf(id, jiroId)).toBeNull();
    expect((await owner.json(`/api/files/${id}/transfer`, { method: "POST", json: { userId: hanakoId } })).status).toBe(200);
    expect(await roleOf(id, hanakoId)).toBe("owner");

    expect(kicks).toEqual([
      { userId: hanakoId, reason: "roleChanged" },
      { userId: jiroId, reason: "roleChanged" },
      { via: "link" },
      { via: "link" },
      { userId: jiroId, reason: "removed" },
      { userId: hanakoId, reason: "roleChanged" },
      { userId: await userIdOf(taro), reason: "roleChanged" },
    ]);
    // 失敗はログに出る (メッセージだけ)
    expect(error).toHaveBeenCalledTimes(kicks.length);
    expect(String(error.mock.calls[0][1])).toBe("kick に失敗");
  });

  it("再試行でも kick する: 外し済みの人への DELETE は kick してから 404、同じ役割への PUT も kick する", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const hanakoId = await share(taro, id, hanako, "editor");
    const { kicks, namespace } = fakeRooms(false);
    const owner = await loginAs("taro@example.com", "", { UntieRoom: namespace });

    expect((await owner.json(`/api/files/${id}/members/${hanakoId}`, { method: "PUT", json: { role: "editor" } })).status).toBe(200);
    expect(kicks).toEqual([{ userId: hanakoId, reason: "roleChanged" }]);

    expect((await owner.fetch(`/api/files/${id}/members/${hanakoId}`, { method: "DELETE" })).status).toBe(204);
    const again = await owner.json(`/api/files/${id}/members/${hanakoId}`, { method: "DELETE" });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("member_not_found");
    expect(kicks.slice(1)).toEqual([
      { userId: hanakoId, reason: "removed" },
      { userId: hanakoId, reason: "removed" },
    ]);

    // 新しく足しただけなら切るものが無い
    kicks.length = 0;
    expect((await owner.json(`/api/files/${id}/members/${hanakoId}`, { method: "PUT", json: { role: "viewer" } })).status).toBe(200);
    expect(kicks).toEqual([]);
  });
});

describe("譲渡の並行安全", () => {
  it("transferOwner は相手が抜けていれば何も書かず false。成功すれば true で、再度は false", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const taroId = await userIdOf(taro);
    const hanakoId = await share(taro, id, hanako, "editor");
    // 相手がメンバーでなければ書かれない
    expect(await transferOwner(env.DB, id, taroId, "usr_nobody")).toBe(false);
    expect((await env.DB.prepare("select owner_id from files where id = ?").bind(id).first<{ owner_id: string }>())!.owner_id).toBe(taroId);
    expect(await roleOf(id, taroId)).toBe("owner");
    // from がもう owner でなければ書かれない
    expect(await transferOwner(env.DB, id, hanakoId, taroId)).toBe(false);
    expect(await roleOf(id, hanakoId)).toBe("editor");
    expect(await transferOwner(env.DB, id, taroId, hanakoId)).toBe(true);
    expect([await roleOf(id, taroId), await roleOf(id, hanakoId)]).toEqual(["editor", "owner"]);
    expect(await transferOwner(env.DB, id, taroId, hanakoId)).toBe(false);
    expect([await roleOf(id, taroId), await roleOf(id, hanakoId)]).toEqual(["editor", "owner"]);
  });

  it("確かめた直後に相手が抜けたら 409 conflict。D1 は変わらず、kick もしない", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const hanakoId = await share(taro, id, hanako, "editor");
    const { kicks, namespace } = fakeRooms(false);
    // batch の直前に相手を抜けさせる DB (確認と更新の間に別の操作が入った状況)
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target.prepare("delete from file_members where file_id = ? and user_id = ?").bind(id, hanakoId).run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const owner = await loginAs("taro@example.com", "", { UntieRoom: namespace });
    const response = await callWorker(
      `/api/files/${id}/transfer`,
      { method: "POST", headers: { Cookie: owner.cookie, "X-Requested-With": "untie", "Content-Type": "application/json" }, body: JSON.stringify({ userId: hanakoId }) },
      { UntieRoom: namespace, DB: racing as never },
    );
    expect(response.status).toBe(409);
    expect((await response.json<any>()).error.code).toBe("conflict");
    expect(await roleOf(id, await userIdOf(taro))).toBe("owner");
    expect((await env.DB.prepare("select owner_id from files where id = ?").bind(id).first<{ owner_id: string }>())!.owner_id).toBe(await userIdOf(taro));
    expect(kicks).toEqual([]);
  });
});

describe("ゴミ箱の中のファイルでは共有を変えられない", () => {
  it("members の PUT/DELETE、transfer、invitations の POST/DELETE、link の PUT/DELETE は 409 in_trash", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const hanakoId = await share(taro, id, hanako, "editor");
    const base = `/api/files/${id}`;
    await taro.fetch(base, { method: "DELETE" });
    const calls: [string, string, unknown?][] = [
      ["PUT", `${base}/members/${hanakoId}`, { role: "viewer" }],
      ["DELETE", `${base}/members/${hanakoId}`],
      ["POST", `${base}/transfer`, { userId: hanakoId }],
      ["POST", `${base}/invitations`, { email: "new@example.com", role: "viewer" }],
      ["DELETE", `${base}/invitations/abc`],
      ["PUT", `${base}/link`, {}],
      ["DELETE", `${base}/link`],
    ];
    for (const [method, path, json] of calls) {
      const result = await taro.json(path, { method, ...(json !== undefined ? { json } : {}) });
      expect([method, path, result.status, result.body?.error?.code]).toEqual([method, path, 409, "in_trash"]);
    }
    // 何も変わっていない
    expect(await roleOf(id, hanakoId)).toBe("editor");
    expect((await env.DB.prepare("select link_token from files where id = ?").bind(id).first<any>())!.link_token).toBeNull();
    expect((await env.DB.prepare("select count(*) as n from invitations").first<{ n: number }>())!.n).toBe(0);
    // メンバーにはもともと 404。戻せば変えられる
    expect((await hanako.json(`${base}/members/${hanakoId}`, { method: "DELETE" })).status).toBe(404);
    await taro.fetch(`${base}/restore`, { method: "POST" });
    expect((await taro.json(`${base}/members/${hanakoId}`, { method: "PUT", json: { role: "viewer" } })).status).toBe(200);
  });
});

describe("viewer は共有を変えられない", () => {
  it("譲渡・PUT・外す・招待・リンクは 403", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const jiro = await loginAs("jiro@example.com");
    const id = await createFile(taro);
    const hanakoId = await share(taro, id, hanako, "viewer");
    const jiroId = await share(taro, id, jiro, "editor");
    const base = `/api/files/${id}`;
    expect((await hanako.json(`${base}/transfer`, { method: "POST", json: { userId: hanakoId } })).status).toBe(403);
    expect((await hanako.json(`${base}/members/${jiroId}`, { method: "PUT", json: { role: "viewer" } })).status).toBe(403);
    expect((await hanako.json(`${base}/members/${hanakoId}`, { method: "PUT", json: { role: "editor" } })).status).toBe(403);
    expect((await hanako.json(`${base}/members/${jiroId}`, { method: "DELETE" })).status).toBe(403);
    expect((await hanako.json(`${base}/invitations`, { method: "POST", json: { email: "n@example.com", role: "viewer" } })).status).toBe(403);
    expect((await hanako.json(`${base}/link`, { method: "PUT", json: {} })).status).toBe(403);
    expect(await roleOf(id, hanakoId)).toBe("viewer");
    expect(await roleOf(id, jiroId)).toBe("editor");
  });
});

describe("POST /api/links/duplicate", () => {
  it("メンバーでないログイン済みの人 (ゲスト) が複製して、自分の owner のファイルにできる", async () => {
    const taro = await loginAs("taro@example.com");
    const guest = await loginAs("guest@example.com", "客");
    const id = await createFile(taro, "宿泊の業務");
    const token = await enableLink(taro, id);
    const { status, body } = await guest.json("/api/links/duplicate", { method: "POST", headers: tok(token) });
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: "宿泊の業務 のコピー", role: "owner", ownerId: await userIdOf(guest), memberCount: 1 });
    expect(body.id).not.toBe(id);
    expect((await guest.json("/api/files")).body.mine.map((f: any) => f.id)).toEqual([body.id]);
    // 元のファイルのメンバーにはならない
    expect(await roleOf(id, await userIdOf(guest))).toBeNull();
  });

  it("未ログインは 401。トークンが無効なら 404、ゴミ箱の中も 404", async () => {
    const taro = await loginAs("taro@example.com");
    const guest = await loginAs("guest@example.com");
    const id = await createFile(taro);
    const token = await enableLink(taro, id);
    const anonymous = await callWorker("/api/links/duplicate", { method: "POST", headers: tok(token) });
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json<any>()).error.code).toBe("unauthenticated");
    expect((await guest.json("/api/links/duplicate", { method: "POST", headers: tok("bogus") })).status).toBe(404);
    expect((await guest.json("/api/links/duplicate", { method: "POST" })).status).toBe(404);
    await taro.fetch(`/api/files/${id}`, { method: "DELETE" });
    expect((await guest.json("/api/links/duplicate", { method: "POST", headers: tok(token) })).status).toBe(404);
    // 何も作られていない
    expect((await guest.json("/api/files")).body.mine).toEqual([]);
  });
});

describe("リンクの有効化の並行", () => {
  it("同時に有効にしても、先に通った 1 つのトークンだけが残り、負けた側は url を返さない", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const results = await Promise.all([1, 2, 3].map(() => taro.json(`/api/files/${id}/link`, { method: "PUT", json: {} })));
    const urls = results.map((r) => r.body.url).filter(Boolean);
    expect(results.every((r) => r.status === 200 && r.body.enabled === true)).toBe(true);
    expect(urls).toHaveLength(1);
    const row = (await env.DB.prepare("select link_token from files where id = ?").bind(id).first<{ link_token: string }>())!;
    expect(row.link_token).toBe(await sha256Hex(tokenOf(urls[0], "link")));
  });

  it("PUT /link は 2 MB を超える本文を 413 にする", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const huge = JSON.stringify({ regenerate: true, pad: "x".repeat(3 * 1024 * 1024) });
    const response = await taro.json(`/api/files/${id}/link`, { method: "PUT", body: huge, headers: { "Content-Type": "application/json", "Content-Length": String(huge.length) } });
    expect(response.status).toBe(413);
  });
});

describe("招待のメールの制限", () => {
  it("ALLOWED_EMAIL_DOMAINS に無いドメインは 400 email_not_allowed。許されるドメインは通る", async () => {
    const overrides = { ALLOWED_EMAIL_DOMAINS: "example.com" };
    const taro = await loginAs("taro@example.com", "", overrides);
    const id = await createFile(taro);
    const bad = await taro.json(`/api/files/${id}/invitations`, { method: "POST", json: { email: "x@other.org", role: "viewer" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("email_not_allowed");
    expect((await taro.json(`/api/files/${id}/invitations`, { method: "POST", json: { email: "Y@Example.com", role: "viewer" } })).status).toBe(201);
    expect((await env.DB.prepare("select count(*) as n from invitations").first<{ n: number }>())!.n).toBe(1);
  });

  it("Unicode のメールアドレスは受けない (400)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    for (const email of ["太郎@example.com", "taro@例え.jp", "tar‮o@example.com"]) {
      const result = await taro.json(`/api/files/${id}/invitations`, { method: "POST", json: { email, role: "viewer" } });
      expect([email, result.status]).toEqual([email, 400]);
    }
  });
});

describe("書き出しのファイル名", () => {
  it("DEL と方向制御文字は _ に置き換える", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const name = "a\u007fb‎c‏d‪e‮f⁦g⁩h";
    expect((await taro.json(`/api/files/${id}`, { method: "PATCH", json: { name } })).status).toBe(200);
    const response = await taro.fetch(`/api/files/${id}/export`);
    const disposition = response.headers.get("Content-Disposition")!;
    expect(disposition).toContain(encodeURIComponent("a_b_c_d_e_f_g_h.json"));
    for (const code of ["%7F", "%E2%80%8E", "%E2%80%8F", "%E2%80%AA", "%E2%80%AE", "%E2%81%A6", "%E2%81%A9"]) expect(disposition).not.toContain(code);
  });
});

describe("マイグレーション", () => {
  it("0001 と 0002 が当たり、invitations(file_id, accepted_at) の index がある", async () => {
    expect(env.TEST_MIGRATIONS.map((m) => m.name)).toEqual(["0001_init.sql", "0002_invitations_index.sql"]);
    const { results } = await env.DB.prepare("pragma index_list(invitations)").all<{ name: string }>();
    expect(results.map((r) => r.name)).toContain("invitations_file");
    const columns = await env.DB.prepare("pragma index_info(invitations_file)").all<{ name: string }>();
    expect(columns.results.map((r) => r.name)).toEqual(["file_id", "accepted_at"]);
  });
});

describe("リンクの応答とセッションの読み方", () => {
  it("404 の応答にも Cache-Control: no-store が付く", async () => {
    const info = await callWorker("/api/links/info", { headers: tok("bogus") });
    expect(info.status).toBe(404);
    expect(info.headers.get("Cache-Control")).toBe("no-store");
    const ticket = await callWorker("/api/links/ticket", { method: "POST", headers: tok("bogus") });
    expect(ticket.status).toBe(404);
    expect(ticket.headers.get("Cache-Control")).toBe("no-store");
    expect((await callWorker("/api/links/export", { headers: tok("bogus") })).headers.get("Cache-Control")).toBe("no-store");
  });

  it("Bearer: desktop のセッションならメンバーとして扱う。web の Cookie の値を Bearer で送っても guest", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await share(taro, id, hanako, "editor");
    const token = await enableLink(taro, id);
    // desktop のセッションを D1 に直接作る (トークンは SHA-256 で持つ)
    const desktopToken = "desktop-token-0123456789abcdef";
    const now = Date.now();
    await env.DB.prepare("insert into sessions (id, user_id, kind, created_at, expires_at, last_seen_at) values (?, ?, 'desktop', ?, ?, ?)")
      .bind(await sha256Hex(desktopToken), await userIdOf(hanako), now, now + 100000, now)
      .run();
    const asDesktop = await callWorker("/api/links/info", { headers: { ...tok(token), Authorization: `Bearer ${desktopToken}` } });
    expect(asDesktop.status).toBe(200);
    expect((await asDesktop.json<any>()).role).toBe("editor");
    const ticket = await callWorker("/api/links/ticket", { method: "POST", headers: { ...tok(token), Authorization: `Bearer ${desktopToken}` } });
    expect((await ticket.json<any>()).role).toBe("editor");
    // web のセッションの値を Bearer で送っても、種類が違うので guest (エラーにはしない)
    const webValue = hanako.cookie.split("=")[1];
    const asWebBearer = await callWorker("/api/links/info", { headers: { ...tok(token), Authorization: `Bearer ${webValue}` } });
    expect(asWebBearer.status).toBe(200);
    expect((await asWebBearer.json<any>()).role).toBe("guest");
    // 逆に desktop の値を Cookie で送っても guest
    const asDesktopCookie = await callWorker("/api/links/info", { headers: { ...tok(token), Cookie: `untie_session=${desktopToken}` } });
    expect((await asDesktopCookie.json<any>()).role).toBe("guest");
  });
});
