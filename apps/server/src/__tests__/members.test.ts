import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOSE_REMOVED, CLOSE_ROLE_CHANGED } from "@untie/api";
import { callWorker, env, loginAs, resetDb, userIdOf } from "./helpers";
import { closeAllClients } from "./roomClient";
import { closedCode, createFile, join, share, tick } from "./shareHelpers";

beforeEach(resetDb);
afterEach(closeAllClients);

const roleOf = async (fileId: string, userId: string) =>
  (await env.DB.prepare("select role from file_members where file_id = ? and user_id = ?").bind(fileId, userId).first<{ role: string }>())?.role ?? null;

describe("PUT /api/files/:id/members/:userId", () => {
  it("owner が editor を足せる。応答はそのメンバー", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const hanako = await loginAs("hanako@example.com", "花子");
    const id = await createFile(taro);
    const userId = await userIdOf(hanako);
    const { status, body } = await taro.json(`/api/files/${id}/members/${userId}`, { method: "PUT", json: { role: "editor" } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ userId, email: "hanako@example.com", name: "花子", role: "editor", addedAt: expect.any(Number) });
    expect(await roleOf(id, userId)).toBe("editor");
    // 足された人から見えて、メンバー数も増える
    expect((await hanako.json(`/api/files/${id}`)).body).toMatchObject({ role: "editor", memberCount: 2 });
    expect((await hanako.json(`/api/files`)).body.shared).toHaveLength(1);
  });

  it("役割を変えると、その人の接続が 4001 で切れる。他の人は切れない", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const jiro = await loginAs("jiro@example.com");
    const id = await createFile(taro);
    const hanakoId = await share(taro, id, hanako, "editor");
    await share(taro, id, jiro, "editor");
    const owner = await join(taro, id);
    const editor = await join(hanako, id);
    const other = await join(jiro, id);
    // 変えると切れる。つなぎ直したチケットは新しい役割
    expect((await taro.json(`/api/files/${id}/members/${hanakoId}`, { method: "PUT", json: { role: "viewer" } })).status).toBe(200);
    expect(await closedCode(editor)).toBe(CLOSE_ROLE_CHANGED);
    expect(owner.closed).toBeNull();
    expect(other.closed).toBeNull();
    await tick();
    expect((await hanako.json(`/api/files/${id}/ticket`, { method: "POST" })).body.role).toBe("viewer");
  });

  it("行があれば同じ役割の PUT でも切る (前の kick が失敗していても、再試行で切れる)。新しく足しただけなら切るものが無い", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const hanakoId = await share(taro, id, hanako, "editor");
    const editor = await join(hanako, id);
    await tick();
    expect((await taro.json(`/api/files/${id}/members/${hanakoId}`, { method: "PUT", json: { role: "editor" } })).status).toBe(200);
    expect(await closedCode(editor)).toBe(CLOSE_ROLE_CHANGED);
  });

  it("editor / viewer は足せない (403)。メンバーでない人には 404", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const jiro = await loginAs("jiro@example.com");
    const saburo = await loginAs("saburo@example.com");
    const id = await createFile(taro);
    await share(taro, id, hanako, "editor");
    const jiroId = await userIdOf(jiro);
    expect((await hanako.json(`/api/files/${id}/members/${jiroId}`, { method: "PUT", json: { role: "viewer" } })).status).toBe(403);
    expect((await saburo.json(`/api/files/${id}/members/${jiroId}`, { method: "PUT", json: { role: "viewer" } })).status).toBe(404);
    expect(await roleOf(id, jiroId)).toBeNull();
  });

  it("相手がユーザーでなければ 404 (user_not_found)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { status, body } = await taro.json(`/api/files/${id}/members/usr_nobody`, { method: "PUT", json: { role: "viewer" } });
    expect(status).toBe(404);
    expect(body.error.code).toBe("user_not_found");
  });

  it("owner 自身の役割は変えられない (409)。owner への昇格もできない (400)", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const taroId = await userIdOf(taro);
    const { status, body } = await taro.json(`/api/files/${id}/members/${taroId}`, { method: "PUT", json: { role: "viewer" } });
    expect(status).toBe(409);
    expect(body.error.code).toBe("owner_role_fixed");
    expect(await roleOf(id, taroId)).toBe("owner");
    expect((await taro.json(`/api/files/${id}/members/${await userIdOf(hanako)}`, { method: "PUT", json: { role: "owner" } })).status).toBe(400);
  });

  it("本文が JSON でない・役割が無い、は 400", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const userId = await userIdOf(hanako);
    expect((await taro.json(`/api/files/${id}/members/${userId}`, { method: "PUT", json: {} })).status).toBe(400);
    expect((await taro.json(`/api/files/${id}/members/${userId}`, { method: "PUT", body: "x" })).status).toBe(400);
  });
});

describe("DELETE /api/files/:id/members/:userId", () => {
  it("owner が外せる。外された人の接続は 4003 で切れ、ファイルが見えなくなる", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const hanakoId = await share(taro, id, hanako, "editor");
    const owner = await join(taro, id);
    const editor = await join(hanako, id);
    expect((await taro.fetch(`/api/files/${id}/members/${hanakoId}`, { method: "DELETE" })).status).toBe(204);
    expect(await closedCode(editor)).toBe(CLOSE_REMOVED);
    expect(owner.closed).toBeNull();
    expect(await roleOf(id, hanakoId)).toBeNull();
    expect((await hanako.json(`/api/files/${id}`)).status).toBe(404);
    await tick();
    expect((await hanako.json(`/api/files/${id}/ticket`, { method: "POST" })).status).toBe(404);
  });

  it("owner が外す相手がメンバーでなければ 404", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const { status, body } = await taro.json(`/api/files/${id}/members/${await userIdOf(hanako)}`, { method: "DELETE" });
    expect(status).toBe(404);
    expect(body.error.code).toBe("member_not_found");
  });

  it("viewer は自分を外せる (共有をやめる)。editor も", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const jiro = await loginAs("jiro@example.com");
    const id = await createFile(taro);
    const hanakoId = await share(taro, id, hanako, "viewer");
    const jiroId = await share(taro, id, jiro, "editor");
    const viewer = await join(hanako, id);
    expect((await hanako.fetch(`/api/files/${id}/members/${hanakoId}`, { method: "DELETE" })).status).toBe(204);
    expect(await closedCode(viewer)).toBe(CLOSE_REMOVED);
    expect((await jiro.fetch(`/api/files/${id}/members/${jiroId}`, { method: "DELETE" })).status).toBe(204);
    expect((await taro.json(`/api/files/${id}`)).body.memberCount).toBe(1);
  });

  it("editor / viewer は他人を外せない (403)", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const jiro = await loginAs("jiro@example.com");
    const id = await createFile(taro);
    await share(taro, id, hanako, "editor");
    const jiroId = await share(taro, id, jiro, "viewer");
    expect((await hanako.json(`/api/files/${id}/members/${jiroId}`, { method: "DELETE" })).status).toBe(403);
    // owner を外そうともできない
    expect((await jiro.json(`/api/files/${id}/members/${await userIdOf(taro)}`, { method: "DELETE" })).status).toBe(403);
    expect(await roleOf(id, jiroId)).toBe("viewer");
  });

  it("owner は自分を外せない (409 transfer_first)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { status, body } = await taro.json(`/api/files/${id}/members/${await userIdOf(taro)}`, { method: "DELETE" });
    expect(status).toBe(409);
    expect(body.error.code).toBe("transfer_first");
    expect((await taro.json(`/api/files/${id}`)).body.role).toBe("owner");
  });
});

describe("GET /api/files/:id の members", () => {
  it("members・invitations・link は owner だけに出る", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const hanako = await loginAs("hanako@example.com", "花子");
    const jiro = await loginAs("jiro@example.com", "次郎");
    const id = await createFile(taro);
    await share(taro, id, hanako, "editor");
    await share(taro, id, jiro, "viewer");
    const owner = (await taro.json(`/api/files/${id}`)).body;
    expect(owner.members.map((m: any) => [m.email, m.role])).toEqual([
      ["taro@example.com", "owner"],
      ["hanako@example.com", "editor"],
      ["jiro@example.com", "viewer"],
    ]);
    expect(owner.members[0].addedAt).toEqual(expect.any(Number));
    expect(owner.invitations).toEqual([]);
    expect(owner.link).toEqual({ enabled: false });
    for (const client of [hanako, jiro]) {
      const detail = (await client.json(`/api/files/${id}`)).body;
      expect(detail.members).toBeUndefined();
      expect(detail.invitations).toBeUndefined();
      expect(detail.link).toBeUndefined();
    }
  });
});

describe("POST /api/files/:id/transfer", () => {
  it("owner → editor。元の owner は editor になり、両者の接続が 4001 で切れる", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const jiro = await loginAs("jiro@example.com");
    const id = await createFile(taro);
    const taroId = await userIdOf(taro);
    const hanakoId = await share(taro, id, hanako, "editor");
    await share(taro, id, jiro, "viewer");
    const a = await join(taro, id);
    const b = await join(hanako, id);
    const c = await join(jiro, id);
    const { status, body } = await taro.json(`/api/files/${id}/transfer`, { method: "POST", json: { userId: hanakoId } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id, ownerId: hanakoId, role: "editor" });
    expect(await closedCode(a)).toBe(CLOSE_ROLE_CHANGED);
    expect(await closedCode(b)).toBe(CLOSE_ROLE_CHANGED);
    expect(c.closed).toBeNull();
    // D1: files.owner_id と file_members の両方が入れ替わる
    expect((await env.DB.prepare("select owner_id from files where id = ?").bind(id).first<{ owner_id: string }>())!.owner_id).toBe(hanakoId);
    expect(await roleOf(id, hanakoId)).toBe("owner");
    expect(await roleOf(id, taroId)).toBe("editor");
    // 一覧: 新しい owner の mine に入り、元の owner の shared に移る
    expect((await hanako.json("/api/files")).body.mine.map((f: any) => f.id)).toEqual([id]);
    expect((await taro.json("/api/files")).body.shared.map((f: any) => f.id)).toEqual([id]);
    // 新しい owner だけが管理できる
    expect((await taro.json(`/api/files/${id}/members/${await userIdOf(jiro)}`, { method: "DELETE" })).status).toBe(403);
    expect((await hanako.json(`/api/files/${id}/members/${await userIdOf(jiro)}`, { method: "DELETE" })).status).toBe(204);
    // つなぎ直したチケットは新しい役割
    await tick();
    expect((await taro.json(`/api/files/${id}/ticket`, { method: "POST" })).body.role).toBe("editor");
    expect((await hanako.json(`/api/files/${id}/ticket`, { method: "POST" })).body.role).toBe("owner");
  });

  it("viewer にも譲れる (元の owner は editor)", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const hanakoId = await share(taro, id, hanako, "viewer");
    expect((await taro.json(`/api/files/${id}/transfer`, { method: "POST", json: { userId: hanakoId } })).status).toBe(200);
    expect(await roleOf(id, hanakoId)).toBe("owner");
    expect(await roleOf(id, await userIdOf(taro))).toBe("editor");
  });

  it("メンバーでない人・存在しない人には 404。自分には 409", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const stranger = await taro.json(`/api/files/${id}/transfer`, { method: "POST", json: { userId: await userIdOf(hanako) } });
    expect(stranger.status).toBe(404);
    expect(stranger.body.error.code).toBe("member_not_found");
    expect((await taro.json(`/api/files/${id}/transfer`, { method: "POST", json: { userId: "usr_nobody" } })).status).toBe(404);
    const self = await taro.json(`/api/files/${id}/transfer`, { method: "POST", json: { userId: await userIdOf(taro) } });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe("already_owner");
    expect(await roleOf(id, await userIdOf(taro))).toBe("owner");
  });

  it("editor は譲れない (403)", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const hanakoId = await share(taro, id, hanako, "editor");
    expect((await hanako.json(`/api/files/${id}/transfer`, { method: "POST", json: { userId: hanakoId } })).status).toBe(403);
    expect(await roleOf(id, await userIdOf(taro))).toBe("owner");
  });

  it("ログインしていないと 401", async () => {
    expect((await callWorker("/api/files/x/transfer", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await callWorker("/api/files/x/members/y", { method: "DELETE" })).status).toBe(401);
  });
});
