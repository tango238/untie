// ルームに接続するチケット (設計書 7.5)。TICKET_SECRET で HMAC-SHA256 署名した短い JWT で、60 秒だけ使え、1 回しか使えない。
// 1 回限りはルームが jti を記録して守る (チケットそのものは保存しない)
import { RoleSchema, TICKET_TTL_MS } from "@untie/api";
import type { Role, TicketVia } from "@untie/api";
import { z } from "zod";
import type { Env } from "../env";
import { base64UrlDecode, base64UrlEncode } from "./crypto";

/** チケットが運ぶ中身。userId はゲスト (リンク閲覧でログインしていない人) のとき null */
export interface TicketClaims {
  fileId: string;
  userId: string | null;
  name: string;
  role: Role;
  via: TicketVia;
  /** 発行したセッションのハッシュの先頭 16 文字 (ログアウトで、そのセッションの接続だけを閉じるため)。セッションが無い (ゲスト) なら null か省略 */
  sid?: string | null;
}

/** セッションの id (トークンの SHA-256) から、チケットに入れる sid を作る */
export const SID_LENGTH = 16;
export const sidOf = (sessionId: string): string => sessionId.slice(0, SID_LENGTH);

/**
 * 検証を通ったチケット。iat は発行時刻 (エポックミリ秒)。ルームが取り消し (kick) の時刻と比べるために渡す。
 * jti はチケットごとの乱数で、ルームが 1 回しか使えないようにするために渡す。expMs は期限 (エポックミリ秒。使用済みの記録を残す期間)
 */
export interface VerifiedTicket extends TicketClaims {
  sid: string | null;
  iat: number;
  jti: string;
  expMs: number;
}

const ClaimsSchema = z
  .object({
    fileId: z.string().min(1),
    userId: z.string().min(1).nullable(),
    name: z.string(),
    role: RoleSchema,
    via: z.enum(["member", "link"]),
    sid: z.string().min(1).max(64).nullable(),
    /** チケットごとの乱数。ルームが使用済みを記録する */
    jti: z.string().min(16).max(64),
    /** 発行時刻 (ミリ秒。秒に丸めると kick との前後が曖昧になる) */
    iat: z.number(),
    /** 期限 (JWT の決まりどおり秒) */
    exp: z.number(),
  })
  // メンバーには必ず userId がある。ゲストはリンクからだけ来る
  .refine((c) => c.via !== "member" || c.userId !== null, "メンバーのチケットには userId が要ります")
  .refine((c) => c.role !== "guest" || c.via === "link", "guest のチケットは via が link でなければなりません");

/** 署名の鍵の最小の長さ。短い鍵は総当たりで破られやすいので使わない */
export const MIN_SECRET_LENGTH = 32;

const encoder = new TextEncoder();
const HEADER = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** 鍵が短すぎれば false (理由はログにだけ出す。鍵の値は出さない)。name はログに出す秘密の名前 (TICKET_SECRET / SESSION_SECRET) */
export function secretIsStrong(secret: string | undefined, name = "TICKET_SECRET", log = true): secret is string {
  if (typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH) return true;
  if (log) console.error(`${name} が ${MIN_SECRET_LENGTH} 文字未満のため、${name === "TICKET_SECRET" ? "チケットを扱えません" : "ログインを扱えません"}`);
  return false;
}

/** チケットを作る。exp は 60 秒後 (JWT の秒単位)、iat は発行時刻のミリ秒。返す expiresAt はエポックミリ秒 */
export async function issueTicket(
  env: Pick<Env, "TICKET_SECRET">,
  claims: TicketClaims,
  now = Date.now(),
): Promise<{ ticket: string; expiresAt: number }> {
  if (!secretIsStrong(env.TICKET_SECRET)) throw new Error("TICKET_SECRET が短すぎます");
  const expiresAt = now + TICKET_TTL_MS;
  const payload = { ...claims, sid: claims.sid ?? null, jti: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))), iat: now, exp: Math.floor(expiresAt / 1000) };
  const signingInput = `${HEADER}.${base64UrlEncode(encoder.encode(JSON.stringify(payload)))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env.TICKET_SECRET, "sign"), encoder.encode(signingInput)));
  return { ticket: `${signingInput}.${base64UrlEncode(signature)}`, expiresAt };
}

/** 署名・期限・形を検め、通れば中身を返す。通らなければ null (理由は区別しない) */
export async function verifyTicket(env: Pick<Env, "TICKET_SECRET">, token: string, now = Date.now()): Promise<VerifiedTicket | null> {
  if (!secretIsStrong(env.TICKET_SECRET)) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  try {
    // header は自分が出したものと同じ文字列でなければ拒む (alg の差し替え対策)
    if (header !== HEADER) return null;
    // crypto.subtle.verify の比較は定数時間
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.TICKET_SECRET, "verify"), base64UrlDecode(signature), encoder.encode(`${header}.${body}`));
    if (!ok) return null;
    const parsed = ClaimsSchema.safeParse(JSON.parse(new TextDecoder().decode(base64UrlDecode(body))));
    if (!parsed.success) return null;
    const { exp, ...claims } = parsed.data;
    if (exp * 1000 <= now) return null;
    return { ...claims, expMs: exp * 1000 };
  } catch {
    return null;
  }
}
