import { createExecutionContext, createScheduledController, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHotelSample } from "@untie/core/sample";
import worker from "../index";
import { PURGE_BATCH_SIZE, purgeTrash, TRASH_RETENTION_DAYS } from "../jobs/purgeTrash";
import { getRoom } from "../rooms";
import { resetConfigReport } from "../config";
import { callWorker, env, loginAs, resetDb } from "./helpers";
import type { Json } from "./helpers";

beforeEach(resetDb);

const DAY = 24 * 60 * 60 * 1000;

describe("ルーティング", () => {
  it("/api の存在しないパスは JSON の 404", async () => {
    const taro = await loginAs("taro@example.com");
    const { status, body } = await taro.json("/api/nothing");
    expect(status).toBe(404);
    expect(body).toEqual({ error: { code: "not_found", message: "見つかりません" } });
  });

  // ブラウザの画面遷移 (Sec-Fetch-Mode: navigate) では、wrangler.jsonc の assets に run_worker_first が無いと
  // /auth/* や /api/* が SPA の index.html になる。SELF.fetch が assets のルーターを通るかはこのテストからは確かめられない
  // ので、ここでは Worker が navigate のリクエストにも HTML フォーム・JSON を返すことだけを確かめる。
  // run_worker_first の効きは wrangler dev で実測した (curl -H "Sec-Fetch-Mode: navigate" -H "Accept: text/html" を付けて確かめられる)
  it("画面遷移のリクエスト (Sec-Fetch-Mode: navigate) でも /auth と /api は Worker が答える", async () => {
    const headers = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", Accept: "text/html" };
    const dev = await SELF.fetch("http://localhost/auth/dev", { headers });
    expect(dev.status).toBe(200);
    expect(await dev.text()).toContain('action="/auth/dev"');
    const me = await SELF.fetch("http://localhost/api/me", { headers });
    expect(me.status).toBe(401);
    expect(me.headers.get("Content-Type")).toContain("application/json");
    expect(await me.json()).toMatchObject({ error: { code: "unauthenticated" } });
    const post = await SELF.fetch("http://localhost/auth/dev", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "nav@example.com" }),
      redirect: "manual",
    });
    expect(post.status).toBe(302);
  });

  it("名前空間が無い /parties/<名前>/x も JSON の 404", async () => {
    const response = await callWorker("/parties/no-such-room/abc");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "見つかりません" } });
  });

  it("/parties は HTTP も、チケットの無い WebSocket も 401", async () => {
    const http = await callWorker("/parties/untie-room/abc");
    expect(http.status).toBe(401);
    expect((await http.json<Json>()).error.code).toBe("unauthenticated");
    const ws = await callWorker("/parties/untie-room/abc", { headers: { Upgrade: "websocket" } });
    expect(ws.status).toBe(401);
    expect((await ws.json<Json>()).error.code).toBe("invalid_ticket");
  });

  it("それ以外は ASSETS (SPA) に任せる", async () => {
    const response = await callWorker("/some/spa/route");
    // apps/cloud/dist が空のテストでは 404。ASSETS に渡ったことを、JSON のエラーではないことで確かめる
    expect(response.headers.get("Content-Type") ?? "").not.toContain("application/json");
  });
});

describe("cron: ゴミ箱の掃除", () => {
  it("scheduled で、ゴミ箱に入れて 30 日を過ぎたファイルだけを destroy して行を消す", async () => {
    const taro = await loginAs("taro@example.com");
    const mk = async () => (await taro.json("/api/files", { method: "POST", json: { model: createHotelSample() } })).body.id as string;
    const [old, recent, alive] = [await mk(), await mk(), await mk()];
    await env.DB.prepare("update files set deleted_at = ? where id = ?").bind(Date.now() - 31 * DAY, old).run();
    await env.DB.prepare("update files set deleted_at = ? where id = ?").bind(Date.now() - 29 * DAY, recent).run();
    // 期限切れのセッションも一緒に掃除する
    await env.DB.prepare("insert into sessions (id, user_id, kind, created_at, expires_at, last_seen_at) select 'expired', id, 'web', 1, 2, 1 from users").run();

    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "0 3 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    const ids = (await env.DB.prepare("select id from files order by id").all<{ id: string }>()).results.map((r) => r.id).sort();
    expect(ids).toEqual([recent, alive].sort());
    expect((await env.DB.prepare("select count(*) as n from file_members where file_id = ?").bind(old).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("select count(*) as n from sessions where id = 'expired'").first<{ n: number }>())!.n).toBe(0);

    // 消したファイルのルームは空。残したファイルの中身は残る
    const oldRoom = await getRoom(env, old);
    expect(await oldRoom.listSnapshots()).toEqual([]);
    expect(((await (await getRoom(env, alive)).exportModel()) as unknown as Json).elements.length).toBeGreaterThan(0);
    expect(((await (await getRoom(env, recent)).exportModel()) as unknown as Json).elements.length).toBeGreaterThan(0);
  });

  it("purgeTrash は消した件数を返す。保持日数は 30 日で、1 回に 50 件まで", async () => {
    expect(TRASH_RETENTION_DAYS).toBe(30);
    expect(PURGE_BATCH_SIZE).toBe(50);
    expect(await purgeTrash(env)).toBe(0);

    await env.DB.prepare("insert into users (id, email, name, created_at) values ('usr_b', 'b@example.com', 'B', 1)").run();
    const old = Date.now() - 40 * DAY;
    await env.DB.batch(
      Array.from({ length: 55 }, (_, i) => [
        env.DB.prepare("insert into files (id, name, owner_id, created_at, updated_at, deleted_at) values (?, 'x', 'usr_b', 1, 1, ?)").bind(`old-${i}`, old + i),
        env.DB.prepare("insert into file_members (file_id, user_id, role, added_at) values (?, 'usr_b', 'owner', 1)").bind(`old-${i}`),
      ]).flat(),
    );
    expect(await purgeTrash(env)).toBe(50);
    expect((await env.DB.prepare("select count(*) as n from files").first<{ n: number }>())!.n).toBe(5);
    // 残りは次の回で消える
    expect(await purgeTrash(env)).toBe(5);
    expect((await env.DB.prepare("select count(*) as n from files").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("cron: 古い招待の掃除", () => {
  it("受けられないまま期限が切れて 30 日たったものと、受けて 30 日たったものを消す。それ以外は残す", async () => {
    const taro = await loginAs("taro@example.com");
    const file = (await taro.json("/api/files", { method: "POST", json: { name: "A" } })).body.id as string;
    const userId = (await taro.json("/api/me")).body.id as string;
    const now = Date.now();
    const insert = (id: string, expiresAt: number, acceptedAt: number | null) =>
      env.DB.prepare("insert into invitations (id, file_id, email, role, created_by, created_at, expires_at, accepted_at) values (?, ?, ?, 'viewer', ?, 1, ?, ?)").bind(
        id,
        file,
        `${id}@example.com`,
        userId,
        expiresAt,
        acceptedAt,
      );
    await env.DB.batch([
      insert("expired-old", now - 31 * DAY, null), // 消す
      insert("expired-recent", now - 29 * DAY, null), // 期限が切れて 30 日たっていない
      insert("pending", now + 5 * DAY, null), // まだ有効
      insert("accepted-old", now + 5 * DAY, now - 31 * DAY), // 消す
      insert("accepted-recent", now + 5 * DAY, now - 29 * DAY),
      insert("accepted-old-expired", now - 40 * DAY, now - 45 * DAY), // 消す
    ]);

    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "0 3 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    const ids = (await env.DB.prepare("select id from invitations order by id").all<{ id: string }>()).results.map((r) => r.id);
    expect(ids).toEqual(["accepted-recent", "expired-recent", "pending"]);
    // ファイルとメンバーには触れない
    expect((await env.DB.prepare("select count(*) as n from file_members").first<{ n: number }>())!.n).toBe(1);
  });
});

describe("秘密の値が短いとき", () => {
  afterEach(() => resetConfigReport());

  it("SESSION_SECRET が 32 文字未満なら、/api・/auth は 500 ではなく 503 misconfigured。原因は最初の 1 回だけログに出す (値は出さない)", async () => {
    resetConfigReport();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const weak = { SESSION_SECRET: "short-session-secret" };
      for (const path of ["/auth/providers", "/api/me"]) {
        const response = await callWorker(path, {}, weak);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: "misconfigured" } });
      }
      // ブラウザが直接開く画面は、JSON ではなく戻るリンク付きの HTML
      const page = await callWorker("/auth/dev", {}, weak);
      expect(page.status).toBe(503);
      expect(await page.text()).toContain("設定が不完全");
      expect(error).toHaveBeenCalledTimes(1);
      const logged = String(error.mock.calls[0][0]);
      expect(logged).toContain("SESSION_SECRET");
      expect(logged).not.toContain("short-session-secret");
      expect(logged).not.toContain("TICKET_SECRET");
    } finally {
      error.mockRestore();
    }
  });

  it("TICKET_SECRET が短い・空のときも 503。32 文字ちょうどなら通る。静的ファイルは配る", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await callWorker("/api/me", {}, { TICKET_SECRET: "" })).status).toBe(503);
      expect((await callWorker("/auth/providers", {}, { SESSION_SECRET: "x".repeat(31) })).status).toBe(503);
      expect((await callWorker("/auth/providers", {}, { SESSION_SECRET: "x".repeat(32), TICKET_SECRET: "y".repeat(32) })).status).toBe(200);
      const spa = await callWorker("/some/spa/route", {}, { SESSION_SECRET: "" });
      expect(spa.headers.get("Content-Type") ?? "").not.toContain("application/json");
    } finally {
      error.mockRestore();
    }
  });
});

describe("APP_ORIGIN 以外のホストで開かれたとき", () => {
  const APP = { APP_ORIGIN: "https://untie.example.com" };
  const redirected = async (url: string, init: RequestInit = {}, overrides: Record<string, string> = APP) => callWorker(url, init, overrides);

  it("画面 (/) もログインも、APP_ORIGIN の同じパス・クエリへ 302 する", async () => {
    const root = await redirected("https://untie.workers.dev/");
    expect(root.status).toBe(302);
    expect(root.headers.get("Location")).toBe("https://untie.example.com/");
    const login = await redirected("https://untie.workers.dev/auth/login?provider=google&return=%23%2Ff%2Fabc");
    expect(login.status).toBe(302);
    expect(login.headers.get("Location")).toBe("https://untie.example.com/auth/login?provider=google&return=%23%2Ff%2Fabc");
    expect((await redirected("https://untie.workers.dev/api/me")).headers.get("Location")).toBe("https://untie.example.com/api/me");
  });

  it("HEAD も 302 する (GET と同じ移し先)", async () => {
    const head = await redirected("https://untie.workers.dev/auth/login?provider=google", { method: "HEAD" });
    expect(head.status).toBe(302);
    expect(head.headers.get("Location")).toBe("https://untie.example.com/auth/login?provider=google");
    expect((await redirected("https://untie.workers.dev/", { method: "HEAD" })).headers.get("Location")).toBe("https://untie.example.com/");
  });

  it("APP_ORIGIN と同じオリジンなら移さない (末尾の / があっても)", async () => {
    expect((await redirected("https://untie.example.com/auth/providers")).status).toBe(200);
    expect((await redirected("https://untie.example.com/auth/providers", {}, { APP_ORIGIN: "https://untie.example.com/" })).status).toBe(200);
  });

  it("/parties・/api/links/*・/auth/desktop/exchange は移さない", async () => {
    expect((await redirected("https://untie.workers.dev/parties/untie-room/x")).status).not.toBe(302);
    const link = await redirected("https://untie.workers.dev/api/links/info", { headers: { "X-Untie-Token": "none" } });
    expect(link.status).toBe(404);
    const exchange = await redirected("https://untie.workers.dev/auth/desktop/exchange", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(exchange.status).toBe(400);
  });

  it("APP_ORIGIN が空なら移さない。ループバック (wrangler dev) も、デスクトップアプリからの呼び出しも、GET / HEAD 以外も移さない", async () => {
    expect((await redirected("https://untie.workers.dev/auth/providers", {}, { APP_ORIGIN: "" })).status).toBe(200);
    expect((await redirected("http://localhost:8787/auth/providers")).status).toBe(200);
    expect((await redirected("http://127.0.0.1:8787/auth/providers")).status).toBe(200);
    expect((await redirected("https://untie.workers.dev/auth/providers", { headers: { Origin: "tauri://localhost" } })).status).toBe(200);
    expect((await redirected("https://untie.workers.dev/api/me", { headers: { Authorization: "Bearer abc" } })).status).toBe(401);
    expect((await redirected("https://untie.workers.dev/auth/logout", { method: "POST" })).status).toBe(204);
  });
});
