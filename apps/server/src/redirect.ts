// 公開の URL (APP_ORIGIN) 以外のホスト (workers.dev など) で開かれたとき、APP_ORIGIN の同じパスへ 302 で移す (設計書 9 章)。
// Cookie はホストごとなので、workers.dev と独自ドメインの両方で開けると、片方でログインしても他方では未ログインに見え、
// Google の redirect URI も片方しか登録できない。入口を APP_ORIGIN の 1 つに揃える。
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env";
import { isDesktopOrigin } from "./auth/cors";

/** 移さないパス: ルームの WebSocket、リンク閲覧 (ログイン不要で、別のホストの画面からも呼ばれる)、デスクトップの引換コードの交換 */
const EXEMPT = [/^\/parties(\/|$)/, /^\/api\/links(\/|$)/, /^\/auth\/desktop\/exchange$/];

/** ループバック (wrangler dev / テスト)。wrangler dev はリクエストのオリジンを常に http://localhost:8787 と見るので、APP_ORIGIN (5173) と食い違って無限に移ってしまう */
const isLoopback = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/**
 * APP_ORIGIN が設定されていて、リクエストのオリジンがそれと違うとき、APP_ORIGIN + 同じパス・クエリへ 302 する。
 * 移さないもの: 上の EXEMPT、GET / HEAD 以外 (302 だと本文が落ちて別の失敗になる)、ループバックのホスト、
 * デスクトップアプリからの呼び出し (Origin が WebView のもの、または Authorization: Bearer 付き。アプリは設定したサーバーの URL へ直接つなぐ)
 */
export const redirectToAppOrigin = createMiddleware<AppEnv>(async (c, next) => {
  const configured = c.env.APP_ORIGIN?.trim().replace(/\/+$/, "");
  if (!configured) return next();
  const url = new URL(c.req.url);
  let target: URL;
  try {
    target = new URL(configured);
  } catch {
    return next();
  }
  if (url.origin === target.origin || isLoopback(url.hostname)) return next();
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  if (EXEMPT.some((p) => p.test(url.pathname))) return next();
  if (isDesktopOrigin(c.req.header("Origin"), c.env) || /^Bearer\s/i.test(c.req.header("Authorization") ?? "")) return next();
  return c.redirect(`${target.origin}${url.pathname}${url.search}`, 302);
});
