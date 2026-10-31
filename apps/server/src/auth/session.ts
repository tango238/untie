import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { createSession, deleteSession, deleteSessionsOfUser, extendSession, findSession, findSessionOwner } from "../db/sessions";
import type { SessionKind, SessionRow, UserRow } from "../db/types";
import { forbidden, unauthorized } from "../errors";
import { isDesktopOrigin } from "./cors";
import { kickRoomsOfUser } from "../rooms";
import { generateToken, sha256Hex } from "./crypto";
import { sidOf } from "./ticket";

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

/**
 * デスクトップのセッションを作る。Cookie は付けない (デスクトップは Cookie を使わない)。
 * 作った時点では使えず (activated_at が null)、引換コードを交換して初めて Bearer で通る。行の id を返す (引換コードに入れる)
 */
export async function createDesktopSession(c: Context<AppEnv>, userId: string): Promise<{ sessionHash: string }> {
  // 作った時点ではトークンは存在しない。行の id は乱数のハッシュで、交換のときに新しいトークンのハッシュへ入れ替える
  const sessionHash = await sha256Hex(generateToken());
  const now = Date.now();
  await createSession(c.env.DB, {
    id: sessionHash,
    userId,
    kind: "desktop",
    userAgent: c.req.header("User-Agent")?.slice(0, 300) ?? null,
    now,
    expiresAt: now + SESSION_TTL_MS.desktop,
  });
  return { sessionHash };
}

export interface Credential {
  token: string;
  /** Cookie 認証のときだけ CSRF 対策のヘッダーが要る (Bearer はブラウザが勝手に付けない) */
  via: "cookie" | "bearer";
}

/**
 * Authorization: Bearer か Cookie からトークンを読む。
 * デスクトップアプリの WebView (CORS で許す送り元。cors.ts) から届いたリクエストの Cookie は読まない:
 * デスクトップは Bearer だけで、Cookie が付いてくるのは何かの間違いか悪用なので、無かったことにする
 */
export function readCredential(c: Context<AppEnv>): Credential | null {
  const authorization = c.req.header("Authorization");
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (bearer) return { token: bearer[1], via: "bearer" };
  if (isDesktopOrigin(c.req.header("Origin"), c.env)) return null;
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

/**
 * セッションがあればユーザーとセッションを返す。無い・期限切れ・種類違いは null (エラーにせず、Cookie も触らない)。
 * リンク閲覧のようにログインしなくても通る API が、ログインしていればメンバーとして扱うために使う。
 * 状態を変えるのはチケットの発行だけで、Cookie の送り元を悪用されても返事は読めないので CSRF のヘッダーは見ない
 */
export async function optionalSession(c: Context<AppEnv>): Promise<{ user: UserRow; session: SessionRow } | null> {
  const credential = readCredential(c);
  if (!credential) return null;
  const found = await findSession(c.env.DB, await sha256Hex(credential.token), Date.now());
  const expectedKind: SessionKind = credential.via === "cookie" ? "web" : "desktop";
  return found && found.session.kind === expectedKind ? found : null;
}


/**
 * ログアウト: セッションの行を消し、Cookie を消す。セッションが無くても成功にする。
 * そのセッションで開いているルームの接続も閉じる (チケットの sid が一致するもの。4000「ログアウトしました」)
 */
export async function endSession(c: Context<AppEnv>): Promise<void> {
  const credential = readCredential(c);
  if (credential) {
    assertCsrf(c, credential);
    const id = await sha256Hex(credential.token);
    const userId = await findSessionOwner(c.env.DB, id);
    await deleteSession(c.env.DB, id);
    if (userId) await kickRoomsOfUser(c, userId, { sid: sidOf(id) });
  }
  clearSessionCookie(c);
}

/** すべての端末からログアウト: ユーザーの全セッションを消し、そのユーザーが開いているルームの接続をすべて閉じる (4000「ログアウトしました」) */
export async function endAllSessions(c: Context<AppEnv>, userId: string): Promise<void> {
  await deleteSessionsOfUser(c.env.DB, userId);
  await kickRoomsOfUser(c, userId, { userId, reason: "loggedOut" });
  clearSessionCookie(c);
}
