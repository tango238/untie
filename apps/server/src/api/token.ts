import type { Context } from "hono";
import { TOKEN_HEADER } from "@untie/api";
import type { AppEnv } from "../env";

/**
 * リンク・招待のトークンをヘッダー (X-Untie-Token) から読む。パスに置くと Workers のログに残るため、ヘッダーで受ける。
 * 無ければ空文字 (SHA-256 を引いても何も見つからず、他のでたらめなトークンと同じ 404 になる)
 */
export function readToken(c: Context<AppEnv>): string {
  return (c.req.header(TOKEN_HEADER) ?? "").trim();
}
