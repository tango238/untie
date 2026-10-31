// トークンの生成とハッシュ、HMAC 署名 (Web Crypto だけ。Worker で動く)

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

export const base64UrlEncode = toBase64Url;
export const base64UrlDecode = fromBase64Url;

/** 32 バイトの乱数 → base64url (セッション・招待・リンクのトークン) */
export function generateToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256 を 16 進で返す。D1 にはトークンの代わりにこれを置く */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** `<base64url(payload)>.<base64url(HMAC-SHA256)>` を作る */
export async function signPayload(secret: string, payload: unknown): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(body)));
  return `${body}.${toBase64Url(signature)}`;
}

/** 署名を検めてペイロードを返す。署名が合わない・壊れていれば null (比較は subtle.verify なので定数時間) */
export async function verifyPayload<T>(secret: string, signed: string): Promise<T | null> {
  const dot = signed.indexOf(".");
  if (dot < 0) return null;
  const body = signed.slice(0, dot);
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), fromBase64Url(signed.slice(dot + 1)), encoder.encode(body));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T;
  } catch {
    return null;
  }
}
