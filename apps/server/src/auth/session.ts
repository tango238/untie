import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { createSession, deleteSession, extendSession, findSession } from "../db/sessions";
import type { SessionKind } from "../db/types";
import { forbidden, unauthorized } from "../errors";
import { generateToken, sha256Hex } from "./crypto";

export const SESSION_COOKIE = "untie_session";
/** 状態を変えるリクエストに Cookie 認証で付ける必須のヘッダー (フォームからは付けられない) */
export const CSRF_HEADER = "X-Requested-With";
export const CSRF_VALUE = "untie";

const DAY_MS = 24 * 60 * 60 * 1000;
/** セッションの寿命 (使うたびに延ばす) */
export const SESSION_TTL_MS: Record<SessionKind, number> = { web: 30 * DAY_MS, desktop: 90 * DAY_MS };

/**
 * リクエストが https のときだけ Cookie に Secure を付ける (本番は常に https。http://localhost の開発では付けない)。
 * APP_ORIGIN の書き忘れで Secure が外れることがないよう、設定ではなくリクエストの URL で決める
 */
export function isSecureRequest(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/** 公開のオリジン。APP_ORIGIN があればそれを優先し、空なら受けたリクエストのもの (OIDC の redirect URI に使う) */
export function appOrigin(c: Context<AppEnv>): string {
  return c.env.APP_ORIGIN ? c.env.APP_ORIGIN.replace(/\/+$/, "") : new URL(c.req.url).origin;
}

function setSessionCookie(c: Context<AppEnv>, token: string, kind: SessionKind): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS[kind] / 1000,
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecureRequest(c) });
}

/** セッションを作って Cookie を付ける (ログインの最後に呼ぶ) */
export async function startSession(c: Context<AppEnv>, userId: string, kind: SessionKind = "web"): Promise<void> {
  // ログインし直したとき、いま持っている Cookie のセッションが残らないように消す
  const previous = getCookie(c, SESSION_COOKIE);
  if (previous) await deleteSession(c.env.DB, await sha256Hex(previous));
  const token = generateToken();
  const now = Date.now();
  await createSession(c.env.DB, {
    id: await sha256Hex(token),
    userId,
    kind,
    userAgent: c.req.header("User-Agent")?.slice(0, 300) ?? null,
    now,
    expiresAt: now + SESSION_TTL_MS[kind],
  });
  setSessionCookie(c, token, kind);
}

export interface Credential {
  token: string;
  /** Cookie 認証のときだけ CSRF 対策のヘッダーが要る (Bearer はブラウザが勝手に付けない) */
  via: "cookie" | "bearer";
}

/** Authorization: Bearer か Cookie からトークンを読む */
export function readCredential(c: Context<AppEnv>): Credential | null {
  const authorization = c.req.header("Authorization");
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (bearer) return { token: bearer[1], via: "bearer" };
  const cookie = getCookie(c, SESSION_COOKIE);
  return cookie ? { token: cookie, via: "cookie" } : null;
}

/** GET / HEAD 以外で Cookie 認証なら X-Requested-With: untie を必須にする */
export function assertCsrf(c: Context<AppEnv>, credential: Credential): void {
  const method = c.req.method;
  if (credential.via !== "cookie" || method === "GET" || method === "HEAD") return;
  if (c.req.header(CSRF_HEADER) !== CSRF_VALUE) throw forbidden("リクエストの送り元を確認できませんでした", "csrf");
}

/** ログインを必須にする。通ると c.var.user と c.var.session が入る */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const credential = readCredential(c);
  if (!credential) throw unauthorized();
  assertCsrf(c, credential);

  const now = Date.now();
  const found = await findSession(c.env.DB, await sha256Hex(credential.token), now);
  // Cookie は web のセッション、Bearer は desktop のセッションだけを受ける (取り違えを防ぐ)
  const expectedKind: SessionKind = credential.via === "cookie" ? "web" : "desktop";
  if (!found || found.session.kind !== expectedKind) {
    if (credential.via === "cookie") clearSessionCookie(c);
    throw unauthorized("ログインの有効期限が切れました。もう一度ログインしてください", "session_expired");
  }
  // 使うたびに延ばす。ただし書き込みは 1 日に 1 回だけ
  if (now - found.session.last_seen_at > DAY_MS) {
    await extendSession(c.env.DB, found.session.id, now, now + SESSION_TTL_MS[found.session.kind]);
    if (credential.via === "cookie") setSessionCookie(c, credential.token, found.session.kind);
  }
  c.set("user", found.user);
  c.set("session", found.session);
  await next();
});

/** ログアウト: セッションの行を消し、Cookie を消す。セッションが無くても成功にする */
export async function endSession(c: Context<AppEnv>): Promise<void> {
  const credential = readCredential(c);
  if (credential) {
    assertCsrf(c, credential);
    await deleteSession(c.env.DB, await sha256Hex(credential.token));
  }
  clearSessionCookie(c);
}
