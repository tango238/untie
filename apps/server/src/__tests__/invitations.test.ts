import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOSE_ROLE_CHANGED } from "@untie/api";
import { sha256Hex } from "../auth/crypto";
import { callWorker, env, loginAs, resetDb, userIdOf } from "./helpers";
import { closeAllClients } from "./roomClient";
import { closedCode, createFile, join, share, tok, tokenOf } from "./shareHelpers";

beforeEach(resetDb);
afterEach(closeAllClients);

const invite = (owner: Awaited<ReturnType<typeof loginAs>>, fileId: string, email: string, role: "editor" | "viewer" = "viewer") =>
  owner.json(`/api/files/${fileId}/invitations`, { method: "POST", json: { email, role } });

const roleOf = async (fileId: string, userId: string) =>
  (await env.DB.prepare("select role from file_members where file_id = ? and user_id = ?").bind(fileId, userId).first<{ role: string }>())?.role ?? null;

describe("POST /api/files/:id/invitations", () => {
  it("すでにユーザーならその場でメンバーになる (メールは大文字小文字を区別しない)", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const { status, body } = await invite(taro, id, "  Hanako@Example.COM ", "editor");
    expect(status).toBe(200);
    expect(body).toEqual({ kind: "member", userId: await userIdOf(hanako) });
    expect(await roleOf(id, await userIdOf(hanako))).toBe("editor");
    expect((await taro.json(`/api/files/${id}`)).body.invitations).toEqual([]);
  });

  it("すでにメンバーなら役割を更新し、変わったときは接続が 4001 で切れる", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await share(taro, id, hanako, "editor");
    const editor = await join(hanako, id);
    expect((await invite(taro, id, "hanako@example.com", "viewer")).body.kind).toBe("member");
    expect(await roleOf(id, await userIdOf(hanako))).toBe("viewer");
    expect(await closedCode(editor)).toBe(CLOSE_ROLE_CHANGED);
  });

  it("ユーザーでなければ招待を作り、URL (/#/invite/<トークン>) を返す。D1 にはトークンの SHA-256 だけ", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { status, body } = await invite(taro, id, "Newcomer@Example.com", "editor");
    expect(status).toBe(201);
    expect(body.kind).toBe("invitation");
    expect(body.url).toMatch(/^http:\/\/localhost\/#\/invite\/[\w-]{43}$/);
    const token = tokenOf(body.url, "invite");
    expect(body.invitationId).toBe(await sha256Hex(token));
    const row = (await env.DB.prepare("select * from invitations where file_id = ?").bind(id).first<any>())!;
    expect(row).toMatchObject({ id: body.invitationId, email: "newcomer@example.com", role: "editor", accepted_at: null });
    expect(row.expires_at - row.created_at).toBe(14 * 24 * 60 * 60 * 1000);
    expect(JSON.stringify(row)).not.toContain(token);
    // owner の詳細に出る
    expect((await taro.json(`/api/files/${id}`)).body.invitations).toEqual([
      { id: body.invitationId, email: "newcomer@example.com", role: "editor", createdAt: row.created_at, expiresAt: row.expires_at },
    ]);
  });

  it("URL のオリジンは APP_ORIGIN があればそれ (末尾の / は落とす)", async () => {
    const taro = await loginAs("taro@example.com", "", { APP_ORIGIN: "https://untie.example.com/" });
    const id = await createFile(taro);
    const { body } = await invite(taro, id, "newcomer@example.com");
    expect(body.url).toMatch(/^https:\/\/untie\.example\.com\/#\/invite\//);
  });

  it("同じメールへの再招待は置き換える (古いトークンは使えなくなる)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const first = (await invite(taro, id, "newcomer@example.com", "viewer")).body;
    const second = (await invite(taro, id, "newcomer@example.com", "editor")).body;
    expect(second.invitationId).not.toBe(first.invitationId);
    const rows = await env.DB.prepare("select id, role from invitations where file_id = ?").bind(id).all<any>();
    expect(rows.results).toEqual([{ id: second.invitationId, role: "editor" }]);
    const newcomer = await loginAs("newcomer@example.com");
    expect((await newcomer.json("/api/invitations/info", { headers: tok(tokenOf(first.url, "invite")) })).status).toBe(404);
    expect((await newcomer.json("/api/invitations/info", { headers: tok(tokenOf(second.url, "invite")) })).body.role).toBe("editor");
  });

  it("owner 自身のメールは 409", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { status, body } = await invite(taro, id, "TARO@example.com");
    expect(status).toBe(409);
    expect(body.error.code).toBe("already_owner");
    expect((await env.DB.prepare("select count(*) as n from invitations").first<{ n: number }>())!.n).toBe(0);
  });

  it("メールの形が違う・役割が owner は 400。editor / viewer は招待できない (403)", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    expect((await invite(taro, id, "not-an-email")).status).toBe(400);
    expect((await taro.json(`/api/files/${id}/invitations`, { method: "POST", json: { email: "a@b.com", role: "owner" } })).status).toBe(400);
    await share(taro, id, hanako, "editor");
    expect((await invite(hanako, id, "newcomer@example.com")).status).toBe(403);
  });

  it("招待後にそのユーザーが現れても、受ける前に直接足されれば招待は消える", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    await invite(taro, id, "hanako@example.com");
    await loginAs("hanako@example.com");
    expect((await invite(taro, id, "hanako@example.com", "editor")).body.kind).toBe("member");
    expect((await env.DB.prepare("select count(*) as n from invitations").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("DELETE /api/files/:id/invitations/:invitationId", () => {
  it("取り消すと、そのトークンは 404 になる", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { body } = await invite(taro, id, "newcomer@example.com");
    const newcomer = await loginAs("newcomer@example.com");
    const token = tokenOf(body.url, "invite");
    expect((await taro.fetch(`/api/files/${id}/invitations/${body.invitationId}`, { method: "DELETE" })).status).toBe(204);
    expect((await newcomer.json("/api/invitations/info", { headers: tok(token) })).status).toBe(404);
    expect((await newcomer.json("/api/invitations/accept", { method: "POST", headers: tok(token) })).status).toBe(404);
    expect((await taro.json(`/api/files/${id}`)).body.invitations).toEqual([]);
    // もう一度は 404
    const again = await taro.json(`/api/files/${id}/invitations/${body.invitationId}`, { method: "DELETE" });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("invitation_not_found");
  });

  it("owner だけ。別のファイルの招待 id では消せない", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const other = await createFile(taro, "別");
    const { body } = await invite(taro, id, "newcomer@example.com");
    await share(taro, id, hanako, "editor");
    expect((await hanako.json(`/api/files/${id}/invitations/${body.invitationId}`, { method: "DELETE" })).status).toBe(403);
    expect((await taro.json(`/api/files/${other}/invitations/${body.invitationId}`, { method: "DELETE" })).status).toBe(404);
    expect((await env.DB.prepare("select count(*) as n from invitations").first<{ n: number }>())!.n).toBe(1);
  });
});

describe("GET /api/invitations/info (トークンは X-Untie-Token ヘッダー)", () => {
  it("招待の中身 { fileName, role, email, inviterName, expired }", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const id = await createFile(taro, "宿泊の業務");
    const { body } = await invite(taro, id, "newcomer@example.com", "editor");
    const newcomer = await loginAs("newcomer@example.com");
    const info = await newcomer.json("/api/invitations/info", { headers: tok(tokenOf(body.url, "invite")) });
    expect(info.status).toBe(200);
    expect(info.body).toEqual({ fileName: "宿泊の業務", role: "editor", email: "newcomer@example.com", inviterName: "太郎", expired: false });
    // 見ただけではメンバーにならない
    expect(await roleOf(id, await userIdOf(newcomer))).toBeNull();
  });

  it("メールが違えば 403 (email_mismatch)。ない・でたらめなトークンは 404", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { body } = await invite(taro, id, "newcomer@example.com");
    const token = tokenOf(body.url, "invite");
    const mallory = await loginAs("mallory@example.com");
    const mismatch = await mallory.json("/api/invitations/info", { headers: tok(token) });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe("email_mismatch");
    expect((await mallory.json("/api/invitations/accept", { method: "POST", headers: tok(token) })).status).toBe(403);
    expect(await roleOf(id, await userIdOf(mallory))).toBeNull();
    expect((await mallory.json("/api/invitations/info", { headers: tok("bogus") })).status).toBe(404);
    expect((await mallory.json("/api/invitations/info")).status).toBe(404);
    expect((await mallory.json("/api/invitations/info", { headers: tok(await sha256Hex(token)) })).status).toBe(404);
  });

  it("期限が切れていれば expired: true", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { body } = await invite(taro, id, "newcomer@example.com");
    await env.DB.prepare("update invitations set expires_at = ? where id = ?").bind(Date.now() - 1, body.invitationId).run();
    const newcomer = await loginAs("newcomer@example.com");
    expect((await newcomer.json("/api/invitations/info", { headers: tok(tokenOf(body.url, "invite")) })).body.expired).toBe(true);
  });

  it("ゴミ箱の中のファイルの招待は 404", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { body } = await invite(taro, id, "newcomer@example.com");
    await taro.fetch(`/api/files/${id}`, { method: "DELETE" });
    const newcomer = await loginAs("newcomer@example.com");
    expect((await newcomer.json("/api/invitations/info", { headers: tok(tokenOf(body.url, "invite")) })).status).toBe(404);
  });

  it("ログインしていないと 401", async () => {
    expect((await callWorker("/api/invitations/info", { headers: tok("abc") })).status).toBe(401);
    expect((await callWorker("/api/invitations/accept", { method: "POST", headers: tok("abc") })).status).toBe(401);
  });
});

describe("POST /api/invitations/accept", () => {
  it("メンバーになり、accepted_at が付き、{ fileId } を返す。owner の詳細から招待が消える", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { body } = await invite(taro, id, "newcomer@example.com", "editor");
    const newcomer = await loginAs("newcomer@example.com");
    const accepted = await newcomer.json("/api/invitations/accept", { method: "POST", headers: tok(tokenOf(body.url, "invite")) });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ fileId: id });
    const userId = await userIdOf(newcomer);
    expect(await roleOf(id, userId)).toBe("editor");
    const member = await env.DB.prepare("select added_by from file_members where file_id = ? and user_id = ?").bind(id, userId).first<{ added_by: string }>();
    expect(member!.added_by).toBe(await userIdOf(taro));
    expect((await env.DB.prepare("select accepted_at from invitations where id = ?").bind(body.invitationId).first<any>())!.accepted_at).toBeGreaterThan(0);
    const detail = (await taro.json(`/api/files/${id}`)).body;
    expect(detail.invitations).toEqual([]);
    expect(detail.members.map((m: any) => m.email)).toContain("newcomer@example.com");
    expect((await newcomer.json(`/api/files/${id}`)).body.role).toBe("editor");
  });

  it("再度の accept は冪等 (同じ { fileId })。役割は変わらない", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { body } = await invite(taro, id, "newcomer@example.com", "viewer");
    const newcomer = await loginAs("newcomer@example.com");
    const accept = { method: "POST", headers: tok(tokenOf(body.url, "invite")) };
    expect((await newcomer.json("/api/invitations/accept", accept)).body).toEqual({ fileId: id });
    expect((await newcomer.json("/api/invitations/accept", accept)).body).toEqual({ fileId: id });
    expect(await roleOf(id, await userIdOf(newcomer))).toBe("viewer");
  });

  it("受けたあとに外された人は、古い招待で戻れない (410)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { body } = await invite(taro, id, "newcomer@example.com", "editor");
    const newcomer = await loginAs("newcomer@example.com");
    const accept = { method: "POST", headers: tok(tokenOf(body.url, "invite")) };
    await newcomer.json("/api/invitations/accept", accept);
    await taro.fetch(`/api/files/${id}/members/${await userIdOf(newcomer)}`, { method: "DELETE" });
    const again = await newcomer.json("/api/invitations/accept", accept);
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe("invitation_used");
    expect(await roleOf(id, await userIdOf(newcomer))).toBeNull();
  });

  it("PUT でメンバーにされると、そのメール宛の未承諾の招待は消える。外したあとに古い招待で戻れない (404)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { body } = await invite(taro, id, "newcomer@example.com", "viewer");
    const newcomer = await loginAs("newcomer@example.com");
    const userId = await userIdOf(newcomer);
    const accept = { method: "POST", headers: tok(tokenOf(body.url, "invite")) };
    // 招待を受ける前に、owner が PUT で足した
    expect((await taro.json(`/api/files/${id}/members/${userId}`, { method: "PUT", json: { role: "editor" } })).status).toBe(200);
    expect((await env.DB.prepare("select count(*) as n from invitations").first<{ n: number }>())!.n).toBe(0);
    // 外す
    expect((await taro.fetch(`/api/files/${id}/members/${userId}`, { method: "DELETE" })).status).toBe(204);
    // 古い招待のトークンでは戻れない
    expect((await newcomer.json("/api/invitations/accept", accept)).status).toBe(404);
    expect(await roleOf(id, userId)).toBeNull();
  });

  it("メンバーを外すと、そのメール宛の未承諾の招待も消える (同じ batch)", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    const userId = await share(taro, id, hanako, "editor");
    // 競合などで招待の行が残っていた状況を直接作る
    await env.DB.prepare("insert into invitations (id, file_id, email, role, created_by, created_at, expires_at) values ('h1', ?, 'hanako@example.com', 'viewer', ?, 1, ?)")
      .bind(id, await userIdOf(taro), Date.now() + 100000)
      .run();
    await taro.fetch(`/api/files/${id}/members/${userId}`, { method: "DELETE" });
    expect((await env.DB.prepare("select count(*) as n from invitations").first<{ n: number }>())!.n).toBe(0);
  });

  it("期限切れは 410 (invitation_expired)。メンバーにならない", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { body } = await invite(taro, id, "newcomer@example.com");
    await env.DB.prepare("update invitations set expires_at = ? where id = ?").bind(Date.now() - 1, body.invitationId).run();
    const newcomer = await loginAs("newcomer@example.com");
    const result = await newcomer.json("/api/invitations/accept", { method: "POST", headers: tok(tokenOf(body.url, "invite")) });
    expect(result.status).toBe(410);
    expect(result.body.error.code).toBe("invitation_expired");
    expect(await roleOf(id, await userIdOf(newcomer))).toBeNull();
  });

  it("ログインしただけでは招待は受理されない (受ける画面で明示的に受ける)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    await invite(taro, id, "newcomer@example.com");
    const newcomer = await loginAs("newcomer@example.com");
    expect(await roleOf(id, await userIdOf(newcomer))).toBeNull();
    expect((await env.DB.prepare("select accepted_at from invitations").first<any>())!.accepted_at).toBeNull();
  });
});
