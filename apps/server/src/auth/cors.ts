// デスクトップアプリの WebView からの CORS (設計書 7.2)。
// Web は同じオリジンなので CORS は要らない。デスクトップの WebView は別のオリジンから API を呼ぶので、その送り元だけを許す。
// 認証は Authorization: Bearer だけで、Cookie は使わない (credentials は許さない: Access-Control-Allow-Credentials は付けない)
import { createMiddleware } from "hono/factory";
import type { AppEnv, Env } from "../env";
import { errorBody } from "../errors";

/**
 * デスクトップ (Tauri) の WebView のオリジン。macOS / Linux は `tauri://localhost`、Windows は `http://tauri.localhost`。
 * これ以外の送り元には CORS のヘッダーを付けない
 */
export const DESKTOP_ORIGINS: readonly string[] = ["tauri://localhost", "http://tauri.localhost"];
/** `tauri dev` の WebView (Vite) のオリジン。開発用ログインが有効 (DEV_LOGIN=true) のときだけ許す。本番では許さない */
export const DESKTOP_DEV_ORIGIN = "http://localhost:1420";

export function isDesktopOrigin(origin: string | undefined | null, env: Pick<Env, "DEV_LOGIN">): origin is string {
  if (typeof origin !== "string") return false;
  return DESKTOP_ORIGINS.includes(origin) || (origin === DESKTOP_DEV_ORIGIN && env.DEV_LOGIN === "true");
}

const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS = "Authorization, Content-Type, X-Untie-Token, X-Requested-With";
/** 書き出しのファイル名 (Content-Disposition) をデスクトップの画面から読めるようにする */
const EXPOSE_HEADERS = "Content-Disposition";
/** プリフライトの結果をブラウザが覚えておく秒数 */
const MAX_AGE = "600";

/**
 * 許す送り元からのリクエストに CORS のヘッダーを付ける。許可外の送り元・送り元の無いリクエストには何も付けない。
 * プリフライト (OPTIONS + Access-Control-Request-Method) は、許す送り元には 204、許さない送り元には 403 を返してルートへは進めない
 */
export const desktopCors = createMiddleware<AppEnv>(async (c, next) => {
  const origin = c.req.header("Origin");
  const preflight = c.req.method === "OPTIONS" && origin !== undefined && c.req.header("Access-Control-Request-Method") !== undefined;

  if (preflight) {
    if (!isDesktopOrigin(origin, c.env)) {
      return c.json(errorBody("forbidden", "この送り元からは使えません"), 403, { Vary: "Origin" });
    }
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": ALLOW_METHODS,
      "Access-Control-Allow-Headers": ALLOW_HEADERS,
      "Access-Control-Max-Age": MAX_AGE,
      Vary: "Origin",
    });
  }

  await next();
  // 送り元で応答が変わるので、許可外にも Vary を付ける (キャッシュが取り違えないように)
  c.res.headers.append("Vary", "Origin");
  if (isDesktopOrigin(origin, c.env)) {
    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  }
});
