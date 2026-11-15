// ログイン (SSO)。IdP (OpenID Connect) が出したトークンを確かめて、操作を行う人にする。
// どの IdP かは決めない: 発行者・宛先・公開鍵の置き場所と、役割の入っているクレームの名前だけを受け取る。
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { UnauthenticatedError } from "./errors";
import type { Principal } from "./policy";

export interface TokenVerifierOptions {
  /** トークンの発行者 (IdP の issuer) */
  issuer: string;
  /** トークンの宛先 (このシステムの audience) */
  audience: string;
  /** 公開鍵。IdP の JWKS の URL か、鍵の組そのもの (テスト用) */
  keys: URL | JSONWebKeySet;
  /** このシステムの id。役割は「<システムの id>:<役割の id>」の形で入っているものだけを、このシステムの役割として読む */
  systemId: string;
  /** 役割の入っているクレームの名前 (既定は roles)。値は、文字列の配列か、役割の名前をキーにしたオブジェクト */
  rolesClaim?: string;
}

export type TokenVerifier = (token: string) => Promise<Principal>;

function rolesOf(payload: JWTPayload, claim: string, systemId: string): string[] {
  const raw = payload[claim];
  const names = Array.isArray(raw) ? raw : raw !== null && typeof raw === "object" ? Object.keys(raw) : [];
  const prefix = `${systemId}:`;
  return [...new Set(names.filter((n): n is string => typeof n === "string" && n.startsWith(prefix)).map((n) => n.slice(prefix.length)))];
}

/** トークンを確かめる関数を作る (署名・発行者・宛先・期限)。通らなければ UnauthenticatedError */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const keys = options.keys instanceof URL ? createRemoteJWKSet(options.keys) : createLocalJWKSet(options.keys);
  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, { issuer: options.issuer, audience: options.audience }));
    } catch (cause) {
      throw new UnauthenticatedError("トークンを確かめられませんでした", { cause });
    }
    if (!payload.sub) throw new UnauthenticatedError("トークンに、利用者の id (sub) がありません");
    return { kind: "user", subject: payload.sub, roles: rolesOf(payload, options.rolesClaim ?? "roles", options.systemId) };
  };
}

/** リクエストの Authorization: Bearer のトークンを確かめて、操作を行う人を返す */
export async function authenticate(request: Request, verify: TokenVerifier): Promise<Principal> {
  const match = /^Bearer +(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new UnauthenticatedError("ログインが必要です");
  return verify(match[1]!);
}
