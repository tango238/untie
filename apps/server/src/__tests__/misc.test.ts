import { createExecutionContext, createScheduledController, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createHotelSample } from "@untie/core/sample";
import worker from "../index";
import { PURGE_BATCH_SIZE, purgeTrash, TRASH_RETENTION_DAYS } from "../jobs/purgeTrash";
import { getRoom } from "../rooms";
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
    // apps/web/dist が空のテストでは 404。ASSETS に渡ったことを、JSON のエラーではないことで確かめる
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
