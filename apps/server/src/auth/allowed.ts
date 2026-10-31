import type { Env } from "../env";

/** メールアドレスを小文字に正規化する (users.email に合わせる) */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * ALLOWED_EMAIL_DOMAINS (カンマ区切り、空なら制限なし) でログインを許すメールか。
 * ログインの経路 (Google・開発用) はすべてここを通す
 */
export function isEmailAllowed(env: Pick<Env, "ALLOWED_EMAIL_DOMAINS">, email: string): boolean {
  const domains = (env.ALLOWED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter((d) => d.length > 0);
  if (domains.length === 0) return true;
  const at = normalizeEmail(email).lastIndexOf("@");
  if (at < 0) return false;
  return domains.includes(normalizeEmail(email).slice(at + 1));
}
