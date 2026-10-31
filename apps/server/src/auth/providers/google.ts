import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Google, decodeIdToken, generateCodeVerifier, generateState } from "arctic";
import type { AppEnv, Env } from "../../env";
import { upsertUser } from "../../db/users";
import { ApiFailure } from "../../errors";
import { isEmailAllowed, normalizeEmail } from "../allowed";
import { base64UrlEncode, signPayload, verifyPayload } from "../crypto";
import { appOrigin, isSecureRequest, startSession } from "../session";

/** state・nonce・PKCE の code_verifier・戻り先を署名して持つ Cookie (10 分) */
export const AUTH_COOKIE = "untie_auth";
const AUTH_COOKIE_MAX_AGE = 10 * 60;

interface AuthCookie {
  state: string;
  nonce: string;
  verifier: string;
  /** ログイン後に開く `#...` (空なら `/`) */
  returnTo: string;
  exp: number;
}

/** GOOGLE_CLIENT_ID が空なら Google は使えない (プロバイダーの一覧にも出さない) */
export function googleEnabled(env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID);
}

/**
 * 戻り先は `#...` のハッシュだけを受ける (外のサイトへ飛ばさない)。それ以外は空にする。
 * 例: `#/files/abc` → `/#/files/abc`
 */
export function sanitizeReturn(value: string | undefined | null): string {
  if (!value || value.length > 500) return "";
  return /^#[\w\-./%~:@!$&'()*+,;=?]*$/.test(value) ? value : "";
}

function googleClient(c: Context<AppEnv>): Google {
  return new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${appOrigin(c)}/auth/callback`);
}

/** GET /auth/login?provider=google&return=<hash> → Google へ 302 */
export async function startGoogleLogin(c: Context<AppEnv>): Promise<Response> {
  if (!googleEnabled(c.env)) throw new ApiFailure(404, "not_found", "Google でのログインは設定されていません");
  const state = generateState();
  const verifier = generateCodeVerifier();
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

  const url = googleClient(c).createAuthorizationURL(state, verifier, ["openid", "profile", "email"]);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("prompt", "select_account");

  const cookie: AuthCookie = { state, nonce, verifier, returnTo: sanitizeReturn(c.req.query("return")), exp: Date.now() + AUTH_COOKIE_MAX_AGE * 1000 };
  setCookie(c, AUTH_COOKIE, await signPayload(c.env.SESSION_SECRET, cookie), {
    httpOnly: true,
    secure: isSecureRequest(c),
    // Google からの戻りはトップレベルの GET なので Lax で届く
    sameSite: "Lax",
    path: "/auth",
    maxAge: AUTH_COOKIE_MAX_AGE,
  });
  return c.redirect(url.toString(), 302);
}

interface GoogleClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  nonce?: string;
}

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** GET /auth/callback?code&state。照合してセッションを作り、`/` + return へ 302 */
export async function finishGoogleLogin(c: Context<AppEnv>): Promise<Response> {
  if (!googleEnabled(c.env)) throw new ApiFailure(404, "not_found", "Google でのログインは設定されていません");
  const stored = getCookie(c, AUTH_COOKIE);
  deleteCookie(c, AUTH_COOKIE, { path: "/auth", secure: isSecureRequest(c) });

  if (c.req.query("error")) throw new ApiFailure(400, "login_cancelled", "Google でのログインが取り消されました。もう一度お試しください");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const auth = stored ? await verifyPayload<AuthCookie>(c.env.SESSION_SECRET, stored) : null;
  if (!code || !state || !auth || auth.exp < Date.now() || auth.state !== state) {
    throw new ApiFailure(400, "invalid_state", "ログインの手続きが無効か、時間切れです。もう一度お試しください");
  }

  let claims: GoogleClaims;
  try {
    const tokens = await googleClient(c).validateAuthorizationCode(code, auth.verifier);
    claims = decodeIdToken(tokens.idToken()) as GoogleClaims;
  } catch {
    throw new ApiFailure(400, "token_exchange_failed", "Google でのログインを完了できませんでした。もう一度お試しください");
  }

  // id_token はトークンエンドポイントから TLS で直接受け取ったもの。署名は見ず、宛先・発行元・nonce を照合する
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(c.env.GOOGLE_CLIENT_ID) || !GOOGLE_ISSUERS.includes(claims.iss ?? "") || claims.nonce !== auth.nonce || !claims.sub) {
    throw new ApiFailure(400, "invalid_token", "Google の応答を確認できませんでした。もう一度お試しください");
  }
  if (!claims.email || claims.email_verified !== true) {
    throw new ApiFailure(403, "email_not_verified", "メールアドレスが確認できていない Google アカウントではログインできません");
  }
  const email = normalizeEmail(claims.email);
  if (!isEmailAllowed(c.env, email)) {
    throw new ApiFailure(403, "email_not_allowed", "このメールアドレスのドメインではログインできません");
  }

  const user = await upsertUser(c.env.DB, { provider: "google", subject: claims.sub, email, name: claims.name ?? "", avatarUrl: claims.picture });
  await startSession(c, user.id, "web");
  return c.redirect(`/${auth.returnTo}`, 302);
}
