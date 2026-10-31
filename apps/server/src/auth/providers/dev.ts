import type { Context } from "hono";
import type { AppEnv } from "../../env";
import { upsertUser } from "../../db/users";
import { ApiFailure } from "../../errors";
import { isEmailAllowed, normalizeEmail } from "../allowed";
import { startSession } from "../session";
import { sanitizeReturn } from "./google";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/**
 * 開発用ログイン。DEV_LOGIN が "true" で、かつリクエストのホストが localhost / 127.0.0.1 のときだけ使える。
 * 本番で DEV_LOGIN を誤って true にしても、公開のホスト名では効かない
 */
export function devLoginEnabled(c: Context<AppEnv>): boolean {
  return c.env.DEV_LOGIN === "true" && LOCAL_HOSTNAMES.has(new URL(c.req.url).hostname);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function assertEnabled(c: Context<AppEnv>): void {
  if (!devLoginEnabled(c)) throw new ApiFailure(404, "not_found", "見つかりません");
}

/** GET /auth/dev: メールと名前を入れる小さなフォーム */
export function devLoginForm(c: Context<AppEnv>): Response {
  assertEnabled(c);
  const returnTo = escapeHtml(sanitizeReturn(c.req.query("return")));
  return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untie 開発用ログイン</title>
<body style="font-family:system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">開発用ログイン</h1>
<p style="color:#666;font-size:.875rem">開発中だけ使えます。メールアドレスを入れるだけでログインします。</p>
<form method="post" action="/auth/dev" style="display:grid;gap:.75rem">
<label>メールアドレス<br><input name="email" type="email" required autofocus style="width:100%;box-sizing:border-box"></label>
<label>名前 (省略可)<br><input name="name" style="width:100%;box-sizing:border-box"></label>
<input type="hidden" name="return" value="${returnTo}">
<button type="submit">ログイン</button>
</form></body></html>`);
}

/** POST /auth/dev: users を upsert してセッションを作り、`/` + return へ 302 */
export async function devLogin(c: Context<AppEnv>): Promise<Response> {
  assertEnabled(c);
  const form = await c.req.parseBody();
  const email = typeof form.email === "string" ? normalizeEmail(form.email) : "";
  const name = typeof form.name === "string" ? form.name.trim().slice(0, 100) : "";
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new ApiFailure(400, "invalid_email", "メールアドレスの形が正しくありません");
  if (!isEmailAllowed(c.env, email)) throw new ApiFailure(403, "email_not_allowed", "このメールアドレスのドメインではログインできません");

  const user = await upsertUser(c.env.DB, { provider: "dev", subject: email, email, name });
  await startSession(c, user.id, "web");
  return c.redirect(`/${sanitizeReturn(typeof form.return === "string" ? form.return : "")}`, 302);
}
