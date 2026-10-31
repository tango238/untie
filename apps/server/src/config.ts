// サーバーの設定の検査 (設計書 7.1)。秘密の値が短いまま動かすと、署名が総当たりで破られやすい。
// 足りなければ 500 ではなく、ログ (原因を管理者に伝える) と 503 `misconfigured` (画面に出せる文言) で断る
import { createMiddleware } from "hono/factory";
import type { AppEnv, Env } from "./env";
import { secretIsStrong } from "./auth/ticket";
import { ApiFailure } from "./errors";

/** 32 文字以上が必要な秘密の値の名前 */
const STRONG_SECRETS = ["SESSION_SECRET", "TICKET_SECRET"] as const;

/** 足りない (空・短い) 秘密の値の名前。値は出さない */
export function weakSecrets(env: Pick<Env, (typeof STRONG_SECRETS)[number]>): string[] {
  return STRONG_SECRETS.filter((name) => !secretIsStrong(env[name], name, false));
}

/** 設定の問題をログに出したか (Worker の起動後、最初の 1 回だけ出す。リクエストのたびに出さない) */
let reported = false;
/** テスト用: ログ済みの目印を戻す */
export function resetConfigReport(): void {
  reported = false;
}

/** 秘密の値が足りないとき、最初の 1 回だけ原因をログに出す。足りない名前を返す (無ければ空) */
export function checkConfig(env: Pick<Env, (typeof STRONG_SECRETS)[number]>): string[] {
  const weak = weakSecrets(env);
  if (weak.length > 0 && !reported) {
    reported = true;
    console.error(`設定が足りません: ${weak.join("・")} は 32 文字以上にしてください (wrangler secret put)。それまで /api・/auth・/parties は 503 を返します`);
  }
  return weak;
}

/** 秘密の値が足りなければ 503 misconfigured。/api・/auth・/parties の前に置く */
export const requireConfig = createMiddleware<AppEnv>(async (c, next) => {
  if (checkConfig(c.env).length > 0) {
    throw new ApiFailure(503, "misconfigured", "サーバーの設定が不完全です。管理者に連絡してください");
  }
  await next();
});
