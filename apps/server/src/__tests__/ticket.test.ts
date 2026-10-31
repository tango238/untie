import { beforeEach, describe, expect, it, vi } from "vitest";
import { TICKET_TTL_MS, createApi } from "@untie/api";
import { issueTicket, verifyTicket } from "../auth/ticket";
import type { TicketClaims } from "../auth/ticket";
import { callWorker, env, loginAs, resetDb, userIdOf } from "./helpers";
import type { Client } from "./helpers";

const claims: TicketClaims = { fileId: "file_a", userId: "usr_a", name: "太郎", role: "editor", via: "member" };
const secretEnv = { TICKET_SECRET: "test-ticket-secret-0123456789abcdef" };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const textB64url = (text: string) => b64url(new TextEncoder().encode(text));

/** 本物と同じ header・HMAC で署名した、本文が自由な JWT (本文の形の検査を試すため) */
async function forge(payload: Record<string, unknown>, secret = secretEnv.TICKET_SECRET): Promise<string> {
  const input = `${textB64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${textB64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${input}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))))}`;
}

const goodPayload = (now = Date.now()) => ({ ...claims, iat: now, exp: Math.floor(now / 1000) + 60 });

/** 署名はそのままに、本文だけ差し替えた偽物 */
function withPayload(token: string, change: (payload: Record<string, unknown>) => void): string {
  const [header, body, signature] = token.split(".");
  const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  change(payload);
  const forged = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${header}.${forged}.${signature}`;
}

describe("チケットの署名と検証", () => {
  it("発行したチケットを検証すると中身が戻る。JWT の形 (HS256) で、exp は 60 秒後", async () => {
    const now = 1_700_000_000_000;
    const { ticket, expiresAt } = await issueTicket(secretEnv, claims, now);
    expect(expiresAt).toBe(now + TICKET_TTL_MS);
    const [header, body] = ticket.split(".");
    const decode = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    expect(decode(header)).toEqual({ alg: "HS256", typ: "JWT" });
    // iat はミリ秒 (kick との前後を秒の丸めで曖昧にしない)、exp は JWT の決まりどおり秒
    expect(decode(body)).toMatchObject({ iat: now, exp: now / 1000 + 60 });
    expect(await verifyTicket(secretEnv, ticket, now + 1000)).toEqual({ ...claims, iat: now });
  });

  it("ゲスト (userId が null) のチケットも通る", async () => {
    const guest: TicketClaims = { fileId: "file_a", userId: null, name: "ゲスト", role: "guest", via: "link" };
    const { ticket } = await issueTicket(secretEnv, guest);
    expect(await verifyTicket(secretEnv, ticket)).toMatchObject(guest);
  });

  it("期限切れは null (60 秒ちょうどからは通らない)", async () => {
    const now = 1_700_000_000_000;
    const { ticket } = await issueTicket(secretEnv, claims, now);
    expect(await verifyTicket(secretEnv, ticket, now + 59_000)).not.toBeNull();
    expect(await verifyTicket(secretEnv, ticket, now + 60_000)).toBeNull();
    expect(await verifyTicket(secretEnv, ticket, now + 3_600_000)).toBeNull();
  });

  it("本文の改ざん (役割を editor → owner に書き換える) は署名が合わず null", async () => {
    const { ticket } = await issueTicket(secretEnv, { ...claims, role: "viewer" });
    expect(await verifyTicket(secretEnv, ticket)).not.toBeNull();
    expect(await verifyTicket(secretEnv, withPayload(ticket, (p) => (p.role = "owner")))).toBeNull();
  });

  it("署名の改ざん・欠落は null", async () => {
    const { ticket } = await issueTicket(secretEnv, claims);
    const flipped = ticket.slice(0, -2) + (ticket.endsWith("AA") ? "BB" : "AA");
    expect(await verifyTicket(secretEnv, flipped)).toBeNull();
    expect(await verifyTicket(secretEnv, ticket.split(".").slice(0, 2).join(".") + ".")).toBeNull();
  });

  it("別の secret で署名したチケットは null", async () => {
    const { ticket } = await issueTicket({ TICKET_SECRET: "other-secret-0123456789abcdef0123456789" }, claims);
    expect(await verifyTicket(secretEnv, ticket)).toBeNull();
  });

  it("alg を差し替えたもの (none) は null", async () => {
    const { ticket } = await issueTicket(secretEnv, claims);
    const [, body] = ticket.split(".");
    const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=+$/, "");
    expect(await verifyTicket(secretEnv, `${header}.${body}.`)).toBeNull();
    expect(await verifyTicket(secretEnv, `${header}.${body}.${ticket.split(".")[2]}`)).toBeNull();
  });

  it("形の壊れた文字列は null (例外にならない)", async () => {
    for (const bad of ["", "abc", "a.b", "a.b.c", "a.b.c.d", "...", "あ.い.う", "%%%.%%%.%%%"]) {
      expect(await verifyTicket(secretEnv, bad)).toBeNull();
    }
  });

  it("署名が正しくても中身の形が違えば null (知らない役割・fileId が無い・メンバーなのに userId が null・via が link でない guest)", async () => {
    const now = Date.now();
    expect(await verifyTicket(secretEnv, await forge(goodPayload(now)), now)).not.toBeNull();
    const { fileId: _omit, ...withoutFileId } = goodPayload(now);
    for (const bad of [
      { ...goodPayload(now), role: "admin" },
      withoutFileId,
      { ...goodPayload(now), via: "member", userId: null },
      { ...goodPayload(now), role: "guest", via: "member" },
      { ...goodPayload(now), userId: "" },
      { ...goodPayload(now), iat: "now" },
    ]) {
      expect(await verifyTicket(secretEnv, await forge(bad), now)).toBeNull();
    }
    // guest + link + userId null は通る
    expect(await verifyTicket(secretEnv, await forge({ ...goodPayload(now), role: "guest", via: "link", userId: null }), now)).not.toBeNull();
  });

  it("TICKET_SECRET が 32 文字未満なら、発行は例外 (console.error に記録)、検証は null", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const short = { TICKET_SECRET: "x".repeat(31) };
      await expect(issueTicket(short, claims)).rejects.toThrow("短すぎます");
      expect(error).toHaveBeenCalled();
      // 短い鍵で署名された (本物と同じ形の) チケットも、短い鍵では検証しない
      const forged = await forge(goodPayload(), short.TICKET_SECRET);
      expect(await verifyTicket(short, forged)).toBeNull();
      expect(await verifyTicket({ TICKET_SECRET: "" }, forged)).toBeNull();
      expect(await verifyTicket({ TICKET_SECRET: "x".repeat(32) }, await forge(goodPayload(), "x".repeat(32)))).not.toBeNull();
    } finally {
      error.mockRestore();
    }
  });
});

beforeEach(resetDb);

/** メンバー行を D1 に直接足す */
async function addMember(fileId: string, userId: string, role: "editor" | "viewer") {
  await env.DB.prepare("insert into file_members (file_id, user_id, role, added_by, added_at) values (?, ?, ?, ?, ?)")
    .bind(fileId, userId, role, null, Date.now())
    .run();
}

async function createFile(client: Client): Promise<string> {
  return (await client.json("/api/files", { method: "POST", json: { name: "チケット" } })).body.id;
}

const postTicket = (client: Client, id: string) => client.json(`/api/files/${id}/ticket`, { method: "POST" });

describe("POST /api/files/:id/ticket", () => {
  it("owner には owner のチケットが出る。名前はユーザーの表示名", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const id = await createFile(taro);
    const { status, body } = await postTicket(taro, id);
    expect(status).toBe(200);
    expect(body.role).toBe("owner");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + TICKET_TTL_MS);
    expect(await verifyTicket(env, body.ticket)).toMatchObject({ fileId: id, userId: await userIdOf(taro), name: "太郎", role: "owner", via: "member" });
  });

  it("member の役割に合ったチケットが出る (editor・viewer)", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const hanako = await loginAs("hanako@example.com", "花子");
    const jiro = await loginAs("jiro@example.com", "次郎");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "editor");
    await addMember(id, await userIdOf(jiro), "viewer");
    for (const [client, role] of [[hanako, "editor"], [jiro, "viewer"]] as const) {
      const { status, body } = await postTicket(client, id);
      expect(status).toBe(200);
      expect(body.role).toBe(role);
      expect((await verifyTicket(env, body.ticket))?.role).toBe(role);
    }
  });

  it("member でなければ 404。ファイルが無くても 404", async () => {
    const taro = await loginAs("taro@example.com");
    const stranger = await loginAs("stranger@example.com");
    const id = await createFile(taro);
    const { status, body } = await postTicket(stranger, id);
    expect(status).toBe(404);
    expect(body.error.code).toBe("file_not_found");
    expect((await postTicket(taro, "no-such-file")).status).toBe(404);
  });

  it("ゴミ箱の中のファイルは owner 以外は 404", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "editor");
    expect((await postTicket(hanako, id)).status).toBe(200);
    expect((await taro.fetch(`/api/files/${id}`, { method: "DELETE" })).status).toBe(204);
    const { status, body } = await postTicket(hanako, id);
    expect(status).toBe(404);
    expect(body.error.code).toBe("file_not_found");
  });

  it("ゴミ箱の中のファイルは owner にもチケットを出さない (409 in_trash)。戻せば出る", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    expect((await taro.fetch(`/api/files/${id}`, { method: "DELETE" })).status).toBe(204);
    const { status, body } = await postTicket(taro, id);
    expect(status).toBe(409);
    expect(body.error.code).toBe("in_trash");
    expect((await taro.fetch(`/api/files/${id}/restore`, { method: "POST", headers: { "X-Requested-With": "untie" } })).status).toBe(200);
    expect((await postTicket(taro, id)).status).toBe(200);
  });

  it("表示名が空なら、メールアドレスの @ より前を名前にする (メールアドレスそのものは出さない)", async () => {
    const taro = await loginAs("taro.yamada@example.com");
    // ログインでは必ず名前が入るので、空の名前は D1 に直接作る
    await env.DB.prepare("update users set name = '' where id = ?").bind(await userIdOf(taro)).run();
    const id = await createFile(taro);
    const { body } = await postTicket(taro, id);
    expect((await verifyTicket(env, body.ticket))?.name).toBe("taro.yamada");
  });

  it("未ログインは 401", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const response = await callWorker(`/api/files/${id}/ticket`, { method: "POST", headers: { "X-Requested-With": "untie" } });
    expect(response.status).toBe(401);
  });

  it("packages/api のクライアントの files.ticket が呼べる", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const id = await createFile(taro);
    const api = createApi({
      baseUrl: "http://localhost",
      fetch: ((url: string, init: RequestInit) => taro.fetch(url.replace("http://localhost", ""), init)) as never,
    });
    const result = await api.files.ticket(id);
    expect(result.role).toBe("owner");
    expect(await verifyTicket(env, result.ticket)).not.toBeNull();
  });
});
