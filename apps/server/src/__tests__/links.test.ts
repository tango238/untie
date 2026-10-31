import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOSE_LINK_DISABLED } from "@untie/api";
import { sha256Hex } from "../auth/crypto";
import { getRoom } from "../rooms";
import { callWorker, env, loginAs, resetDb, userIdOf } from "./helpers";
import type { Client } from "./helpers";
import { closeAllClients, connectRoom, expectClient } from "./roomClient";
import { closedCode, createFile, join, share, tick, tok, tokenOf } from "./shareHelpers";

beforeEach(resetDb);
afterEach(closeAllClients);

/** リンクを有効にして { id, token, url } を返す */
async function enableLink(owner: Client, fileId: string, regenerate = false) {
  const { status, body } = await owner.json(`/api/files/${fileId}/link`, { method: "PUT", json: regenerate ? { regenerate: true } : {} });
  if (status !== 200) throw new Error(`リンクを有効にできません: ${status}`);
  return { url: body.url as string, token: tokenOf(body.url, "link") };
}

/** セッション無し (ゲスト) で呼ぶ */
const asGuest = (path: string, init?: RequestInit) => callWorker(path, init);
const guestJson = async (path: string, init?: RequestInit) => {
  const response = await asGuest(path, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, response, text };
};

async function guestJoin(token: string, fileId: string) {
  const { body } = await guestJson("/api/links/ticket", { method: "POST", headers: tok(token) });
  const room = expectClient(await connectRoom(fileId, body.ticket));
  await room.sync();
  return room;
}

describe("PUT /api/files/:id/link", () => {
  it("有効にすると URL (/#/link/<トークン>) が返り、D1 にはハッシュだけ。GET の link は enabled だけ", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { status, body } = await taro.json(`/api/files/${id}/link`, { method: "PUT", json: {} });
    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.url).toMatch(/^http:\/\/localhost\/#\/link\/[\w-]{43}$/);
    const token = tokenOf(body.url, "link");
    const row = (await env.DB.prepare("select link_token from files where id = ?").bind(id).first<{ link_token: string }>())!;
    expect(row.link_token).toBe(await sha256Hex(token));
    expect(row.link_token).not.toContain(token);
    expect((await taro.json(`/api/files/${id}`)).body.link).toEqual({ enabled: true });
  });

  it("本文が無くてもよい。APP_ORIGIN があればそれを使う", async () => {
    const taro = await loginAs("taro@example.com", "", { APP_ORIGIN: "https://untie.example.com" });
    const id = await createFile(taro);
    const response = await taro.fetch(`/api/files/${id}/link`, { method: "PUT" });
    expect(response.status).toBe(200);
    expect((await response.json<any>()).url).toMatch(/^https:\/\/untie\.example\.com\/#\/link\//);
  });

  it("すでに有効で regenerate でなければ、何も変えず url も返さない", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { token } = await enableLink(taro, id);
    const again = await taro.json(`/api/files/${id}/link`, { method: "PUT", json: {} });
    expect(again.body).toEqual({ enabled: true });
    expect((await guestJson("/api/links/info", { headers: tok(token) })).status).toBe(200);
  });

  it("owner だけ (editor は 403、メンバーでなければ 404)", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const stranger = await loginAs("stranger@example.com");
    const id = await createFile(taro);
    await share(taro, id, hanako, "editor");
    expect((await hanako.json(`/api/files/${id}/link`, { method: "PUT", json: {} })).status).toBe(403);
    expect((await hanako.json(`/api/files/${id}/link`, { method: "DELETE" })).status).toBe(403);
    expect((await stranger.json(`/api/files/${id}/link`, { method: "PUT", json: {} })).status).toBe(404);
    expect((await env.DB.prepare("select link_token from files where id = ?").bind(id).first<any>())!.link_token).toBeNull();
  });

  it("regenerate の型が違えば 400", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    expect((await taro.json(`/api/files/${id}/link`, { method: "PUT", json: { regenerate: "yes" } })).status).toBe(400);
  });
});

describe("GET /api/links/info (セッション不要。トークンは X-Untie-Token ヘッダー)", () => {
  it("セッション無しなら guest。ファイルの名前と id を返す", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro, "宿泊の業務");
    const { token } = await enableLink(taro, id);
    const { status, body, response } = await guestJson("/api/links/info", { headers: tok(token) });
    expect(status).toBe(200);
    expect(body).toEqual({ fileId: id, name: "宿泊の業務", role: "guest" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("メンバーのセッションならその役割。メンバーでないログイン済みの人は guest", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const jiro = await loginAs("jiro@example.com");
    const stranger = await loginAs("stranger@example.com");
    const id = await createFile(taro);
    await share(taro, id, hanako, "editor");
    await share(taro, id, jiro, "viewer");
    const { token } = await enableLink(taro, id);
    const roles = [];
    for (const client of [taro, hanako, jiro, stranger]) roles.push((await client.json("/api/links/info", { headers: tok(token) })).body.role);
    expect(roles).toEqual(["owner", "editor", "viewer", "guest"]);
  });

  it("無効なセッションの Cookie が付いていても guest として通る", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { token } = await enableLink(taro, id);
    const response = await asGuest("/api/links/info", { headers: { ...tok(token), Cookie: "untie_session=bogus" } });
    expect(response.status).toBe(200);
    expect((await response.json<any>()).role).toBe("guest");
  });

  it("不正なトークン・ハッシュそのもの・空に近いものは 404 (link_not_found)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { token } = await enableLink(taro, id);
    for (const bad of ["x", "A".repeat(43), await sha256Hex(token)]) {
      const { status, body } = await guestJson("/api/links/info", { headers: tok(bad) });
      expect(status).toBe(404);
      expect(body.error.code).toBe("link_not_found");
    }
    expect((await guestJson("/api/links/ticket", { method: "POST", headers: tok("x") })).status).toBe(404);
    expect((await guestJson("/api/links/export", { headers: tok("x") })).status).toBe(404);
    // ヘッダーが無い・パスにトークンを置いた形も 404
    expect((await guestJson("/api/links/info")).status).toBe(404);
    expect((await guestJson(`/api/links/${token}`)).status).toBe(401);
  });

  it("ゴミ箱の中のファイルは 404。戻せばまた開ける", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { token } = await enableLink(taro, id);
    await taro.fetch(`/api/files/${id}`, { method: "DELETE" });
    expect((await guestJson("/api/links/info", { headers: tok(token) })).status).toBe(404);
    expect((await taro.json("/api/links/info", { headers: tok(token) })).status).toBe(404);
    expect((await guestJson("/api/links/ticket", { method: "POST", headers: tok(token) })).status).toBe(404);
    expect((await guestJson("/api/links/export", { headers: tok(token) })).status).toBe(404);
    await taro.fetch(`/api/files/${id}/restore`, { method: "POST" });
    expect((await guestJson("/api/links/info", { headers: tok(token) })).status).toBe(200);
  });
});

describe("POST /api/links/ticket と接続", () => {
  it("セッション無しで guest のチケットが出る。接続すると presence に「ゲスト 1」", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { token } = await enableLink(taro, id);
    const { status, body } = await guestJson("/api/links/ticket", { method: "POST", headers: tok(token) });
    expect(status).toBe(200);
    expect(body).toMatchObject({ role: "guest", expiresAt: expect.any(Number) });
    const room = await guestJoin(token, id);
    expect(room.closed).toBeNull();
    expect(await (await getRoom(env, id)).presence()).toEqual([{ userId: null, name: "ゲスト 1", role: "guest" }]);
  });

  it("メンバーのセッションなら、その役割と userId のチケット (editor がリンクから開いても編集できる)", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const hanako = await loginAs("hanako@example.com", "花子");
    const id = await createFile(taro);
    await share(taro, id, hanako, "editor");
    const { token } = await enableLink(taro, id);
    const { status, body } = await hanako.json("/api/links/ticket", { method: "POST", headers: tok(token) });
    expect(status).toBe(200);
    expect(body.role).toBe("editor");
    const room = expectClient(await connectRoom(id, body.ticket));
    await room.sync();
    expect(await (await getRoom(env, id)).presence()).toEqual([{ userId: expect.stringMatching(/^usr_/), name: "花子", role: "editor" }]);
  });

  it("ゲストは書き込めない (viewer 相当)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { token } = await enableLink(taro, id);
    const owner = await join(taro, id);
    const guest = await guestJoin(token, id);
    guest.doc.getMap("meta").set("name", "ゲストの書き込み");
    await guest.sync();
    await owner.sync();
    expect(owner.doc.getMap("meta").get("name")).not.toBe("ゲストの書き込み");
  });
});

describe("GET /api/links/export", () => {
  it("セッション無しで JSON を書き出せる", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro, "宿泊の業務");
    const { token } = await enableLink(taro, id);
    const { status, body, response } = await guestJson("/api/links/export", { headers: tok(token) });
    expect(status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Content-Disposition")).toContain(encodeURIComponent("宿泊の業務"));
    expect(body.meta.name).toBe("宿泊の業務");
    expect(body.version).toBe(1);
  });
});

describe("無効化と作り直し", () => {
  it("無効にすると 204、リンクは 404 になり、ゲストは 4004 で切れる。メンバーの通常の接続は残る", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { token } = await enableLink(taro, id);
    const owner = await join(taro, id);
    const guest = await guestJoin(token, id);
    expect((await taro.fetch(`/api/files/${id}/link`, { method: "DELETE" })).status).toBe(204);
    expect(await closedCode(guest)).toBe(CLOSE_LINK_DISABLED);
    expect(owner.closed).toBeNull();
    expect((await env.DB.prepare("select link_token from files where id = ?").bind(id).first<any>())!.link_token).toBeNull();
    expect((await guestJson("/api/links/info", { headers: tok(token) })).status).toBe(404);
    expect((await guestJson("/api/links/ticket", { method: "POST", headers: tok(token) })).status).toBe(404);
    expect((await guestJson("/api/links/export", { headers: tok(token) })).status).toBe(404);
    expect((await taro.json(`/api/files/${id}`)).body.link).toEqual({ enabled: false });
  });

  it("リンクから開いたメンバーも切れる。つなぎ直しは 404", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await share(taro, id, hanako, "viewer");
    const { token } = await enableLink(taro, id);
    const ticket = (await hanako.json("/api/links/ticket", { method: "POST", headers: tok(token) })).body.ticket;
    const viaLink = expectClient(await connectRoom(id, ticket));
    await viaLink.sync();
    const viaMember = await join(hanako, id);
    await tick();
    await taro.fetch(`/api/files/${id}/link`, { method: "DELETE" });
    expect(await closedCode(viaLink)).toBe(CLOSE_LINK_DISABLED);
    expect(viaMember.closed).toBeNull();
    expect((await hanako.json("/api/links/ticket", { method: "POST", headers: tok(token) })).status).toBe(404);
  });

  it("作り直すと古いトークンは 404、新しいトークンは通る。古いリンクのゲストは 4004 で切れる", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const old = await enableLink(taro, id);
    const guest = await guestJoin(old.token, id);
    await tick();
    const fresh = await enableLink(taro, id, true);
    expect(fresh.token).not.toBe(old.token);
    expect(await closedCode(guest)).toBe(CLOSE_LINK_DISABLED);
    expect((await guestJson("/api/links/info", { headers: tok(old.token) })).status).toBe(404);
    expect((await guestJson("/api/links/info", { headers: tok(fresh.token) })).body.role).toBe("guest");
    // 新しいリンクのゲストは切れていない
    const again = await guestJoin(fresh.token, id);
    expect(again.closed).toBeNull();
  });

  it("最初の有効化では接続を切らない", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const owner = await join(taro, id);
    await enableLink(taro, id);
    await tick();
    expect(owner.closed).toBeNull();
  });
});

describe("GET /api/files/:id/presence と GET /api/links/presence", () => {
  it("メンバーは、いまつながっている人 (チケットから決めた userId・名前・役割) を読める。ゲストは userId なしの「ゲスト N」", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const hanako = await loginAs("hanako@example.com", "花子");
    const id = await createFile(taro);
    await share(taro, id, hanako, "editor");
    const { token } = await enableLink(taro, id);
    const hanakoId = await userIdOf(hanako);
    const empty = await hanako.json(`/api/files/${id}/presence`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ presence: [] });
    await join(hanako, id);
    await guestJoin(token, id);
    const viaFile = await hanako.json(`/api/files/${id}/presence`);
    expect(viaFile.body.presence).toHaveLength(2);
    expect(viaFile.body.presence).toEqual(
      expect.arrayContaining([
        { userId: hanakoId, name: "花子", role: "editor" },
        { userId: null, name: "ゲスト 1", role: "guest" },
      ]),
    );
    // リンクのトークンでも (ゲストでも) 同じ一覧が読める。レスポンスはキャッシュさせない
    const viaLink = await guestJson("/api/links/presence", { headers: tok(token) });
    expect(viaLink.status).toBe(200);
    expect(viaLink.body.presence).toHaveLength(2);
    expect(viaLink.response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("メンバーでない人は 404、未ログインは 401。リンクのトークンが無効・ヘッダー無しは 404。ゴミ箱の中は owner に 409", async () => {
    const taro = await loginAs("taro@example.com");
    const stranger = await loginAs("stranger@example.com");
    const id = await createFile(taro);
    const { token } = await enableLink(taro, id);
    expect((await stranger.json(`/api/files/${id}/presence`)).status).toBe(404);
    expect((await guestJson(`/api/files/${id}/presence`)).status).toBe(401);
    expect((await guestJson("/api/links/presence", { headers: tok("nothing") })).status).toBe(404);
    expect((await guestJson("/api/links/presence")).status).toBe(404);
    await taro.fetch(`/api/files/${id}`, { method: "DELETE" });
    expect((await taro.json(`/api/files/${id}/presence`)).status).toBe(409);
    expect((await guestJson("/api/links/presence", { headers: tok(token) })).status).toBe(404);
  });
});
