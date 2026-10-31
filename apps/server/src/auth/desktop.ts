// デスクトップのログイン (設計書 7.3)。
// ブラウザでログインが済んだら、「引換コード」をアプリへ渡す。コードにトークンは入れない:
// セッションの行 (activated_at が null で、まだ使えない) の id と、アプリの state・PKCE の challenge だけを入れる。
// 引換コードは TICKET_SECRET から HKDF で作った鍵で AES-GCM 暗号化した短命 (5 分) の文字列で、保存しない。
// アプリが交換 (POST /auth/desktop/exchange) したとき、state と code_verifier (PKCE) を検めたうえで新しいトークンを作り、
// 行の id をそのトークンのハッシュに入れ替えて返す。トークンが deep link・履歴・クリップボードに現れることはない。
// 1 回しか使えないことは D1 の sessions.activated_at で守る (交換するまでセッションは認証に通らない)
import type { Context } from "hono";
import { z } from "zod";
import type { DesktopExchangeResponse } from "@untie/api";
import type { AppEnv, Env } from "../env";
import { activateSession, findSession } from "../db/sessions";
import { toUser } from "../db/users";
import { ApiFailure, badRequest, unauthorized } from "../errors";
import { base64UrlDecode, base64UrlEncode, generateToken, sha256Base64Url, sha256Hex } from "./crypto";
import { createDesktopSession } from "./session";
import { secretIsStrong } from "./ticket";

/** 引換コードの寿命 */
export const DESKTOP_CODE_TTL_MS = 5 * 60 * 1000;

/** アプリが作る state (乱数)。URL にそのまま載せるので、使える文字を絞る */
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const isValidAppState = (value: unknown): value is string => typeof value === "string" && STATE_PATTERN.test(value);

/** PKCE の code_challenge (= base64url(sha256(code_verifier)) の 43 文字) と、code_verifier (43〜128 文字の乱数、RFC 7636) */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
export const isValidChallenge = (value: unknown): value is string => typeof value === "string" && CHALLENGE_PATTERN.test(value);

/** 引換コードの中身。トークンは入れない */
export interface DesktopCodePayload {
  /** セッションの行の id (交換で新しいトークンのハッシュに入れ替わる) */
  sessionHash: string;
  /** アプリが /auth/login に渡した state。交換のときに照合する */
  state: string;
  /** アプリが /auth/login に渡した code_challenge。交換のときに code_verifier のハッシュと照合する */
  challenge: string;
  /** 期限 (エポックミリ秒) */
  exp: number;
}

const PayloadSchema = z.object({ sessionHash: z.string(), state: z.string(), challenge: z.string(), exp: z.number() });

const encoder = new TextEncoder();
/** 暗号文を別の用途に使い回されないための識別子 (AES-GCM の追加認証データ) */
const AAD = encoder.encode("untie-desktop-code-v1");
const IV_LENGTH = 12;

async function codeKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  // チケットの HMAC と同じ TICKET_SECRET から、用途の違う鍵を派生する (info が違えば鍵も違う)
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("untie"), info: encoder.encode("desktop-exchange-code-v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 引換コードを作る: `base64url(iv ‖ 暗号文)` */
export async function sealDesktopCode(env: Pick<Env, "TICKET_SECRET">, payload: DesktopCodePayload): Promise<string> {
  if (!secretIsStrong(env.TICKET_SECRET)) throw new Error("TICKET_SECRET が短すぎます");
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await codeKey(env.TICKET_SECRET), encoder.encode(JSON.stringify(payload))),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return base64UrlEncode(out);
}

/** 引換コードを開く。改ざん・壊れ・別の鍵のものは null (理由は区別しない)。期限は呼び出し側が見る */
export async function openDesktopCode(env: Pick<Env, "TICKET_SECRET">, code: string): Promise<DesktopCodePayload | null> {
  if (!secretIsStrong(env.TICKET_SECRET)) return null;
  try {
    const bytes = base64UrlDecode(code);
    if (bytes.length <= IV_LENGTH) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_LENGTH), additionalData: AAD },
      await codeKey(env.TICKET_SECRET),
      bytes.slice(IV_LENGTH),
    );
    const parsed = PayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(plain)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** アプリが開く deep link */
export const DEEP_LINK_BASE = "untie://auth/callback";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * ログインが済んだあとの HTML (`/auth/desktop/done` の役目のページ。callback の応答としてそのまま返す)。
 * 「アプリに戻ります」と、deep link への自動遷移、ボタン、deep link が開けない環境のための引換コードの表示とコピー。
 * Cookie は付けない。コードを含むので no-store にし、インラインのスクリプトは nonce で許す
 */
export function desktopDonePage(code: string, state: string): { html: string; headers: Record<string, string> } {
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const url = `${DEEP_LINK_BASE}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untie</title>
<style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6}h1{font-size:1.25rem}.btn{display:inline-block;padding:.5rem 1rem;border:1px solid #888;border-radius:6px;background:#f4f4f4;color:inherit;text-decoration:none;font:inherit;cursor:pointer}.code{width:100%;box-sizing:border-box;height:6rem;font:.75rem ui-monospace,monospace;word-break:break-all}.note{color:#666;font-size:.875rem}</style>
<body>
<h1>アプリに戻ります</h1>
<p>ログインできました。Untie アプリに自動で戻ります。戻らないときは、下のボタンを押してください。</p>
<p><a class="btn" id="open" href="${escapeHtml(url)}">Untie を開く</a></p>
<p class="note">ボタンを押してもアプリが開かないときは、次の引換コードをコピーして、アプリのログイン欄の「引換コードを貼る」に貼ってください。コードは 5 分間、1 回だけ使えます。</p>
<textarea class="code" id="code" readonly>${escapeHtml(code)}</textarea>
<p><button class="btn" type="button" id="copy">コピー</button> <span class="note" id="copied" role="status"></span></p>
<script nonce="${nonce}">
var url = ${JSON.stringify(url).replace(/</g, "\\u003c")};
document.getElementById("copy").addEventListener("click", function () {
  var box = document.getElementById("code");
  var done = function () { document.getElementById("copied").textContent = "コピーしました"; };
  box.select();
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.value).then(done, function () { document.execCommand("copy"); done(); });
  else { document.execCommand("copy"); done(); }
});
location.href = url;
</script>
</body></html>`;
  return {
    html,
    headers: {
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  };
}

/**
 * ログインが済んだ人 (Google・開発用ログインの callback) に、デスクトップのセッションを作って引換コードのページを返す。
 * state・challenge が無い・形が違うときは (Cookie が壊れているので) 拒む
 */
export async function finishDesktopLogin(c: Context<AppEnv>, userId: string, state: string | undefined, challenge: string | undefined): Promise<Response> {
  if (!isValidAppState(state) || !isValidChallenge(challenge)) throw badRequest("ログインの手続きが無効か、時間切れです。もう一度お試しください", "invalid_state");
  const { sessionHash } = await createDesktopSession(c, userId);
  const code = await sealDesktopCode(c.env, { sessionHash, state, challenge, exp: Date.now() + DESKTOP_CODE_TTL_MS });
  const page = desktopDonePage(code, state);
  return c.html(page.html, 200, page.headers);
}

const ExchangeRequestSchema = z
  .object({
    code: z.string().min(1).max(2048),
    state: z.string().min(1).max(256),
    code_verifier: z.string().regex(VERIFIER_PATTERN, "code_verifier の形が正しくありません"),
  })
  .strict();

/**
 * POST /auth/desktop/exchange { code, state, code_verifier } → { token, user }。セッションは要らない。
 * 復号して期限・state・PKCE を検め、新しいトークンを作って行の id を入れ替える。activated_at が null のときだけ通す (2 回目は 401 code_used)
 */
export async function exchangeDesktopCode(c: Context<AppEnv>): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("リクエストの形が正しくありません");
  }
  const { code, state, code_verifier: verifier } = ExchangeRequestSchema.parse(body);

  const payload = await openDesktopCode(c.env, code);
  if (!payload) throw new ApiFailure(400, "invalid_code", "引換コードが正しくありません。ブラウザの画面からもう一度コピーしてください");
  const now = Date.now();
  if (payload.exp <= now) throw unauthorized("引換コードの期限が切れました。もう一度ログインしてください", "code_expired");
  if (payload.state !== state) throw new ApiFailure(400, "state_mismatch", "このアプリが始めたログインではありません。もう一度ログインしてください");
  // PKCE: ブラウザの画面や deep link でコードが他人に見えても、verifier を持つのはログインを始めたアプリだけ
  if ((await sha256Base64Url(verifier)) !== payload.challenge) {
    throw new ApiFailure(400, "invalid_verifier", "このアプリが始めたログインではありません。もう一度ログインしてください");
  }
  // 新しいトークンをここで作り、行の id をそのハッシュに入れ替える (トークンは引換コードのどこにも入っていない)
  const token = generateToken();
  const newId = await sha256Hex(token);
  if (!(await activateSession(c.env.DB, payload.sessionHash, newId, now))) {
    throw unauthorized("この引換コードはすでに使われています。もう一度ログインしてください", "code_used");
  }
  const found = await findSession(c.env.DB, newId, now);
  if (!found) throw unauthorized("引換コードを使えませんでした。もう一度ログインしてください", "code_used");
  c.header("Cache-Control", "no-store");
  return c.json({ token, user: toUser(found.user) } satisfies DesktopExchangeResponse);
}
