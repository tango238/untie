import { env as rawEnv, runInDurableObject, SELF } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import type { UntieRoom } from "@untie/collab/room";
import worker from "../index";
import type { Env } from "../env";

/** テストの env。cloudflare:test の env は型が空なので、Worker の Env とマイグレーションの型を付ける */
export const env = rawEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

/** ルームの Durable Object の中で callback を走らせる (instance のメソッドや storage を直接触る) */
export function inRoom<R>(stub: unknown, callback: (room: UntieRoom, state: DurableObjectState) => R | Promise<R>): Promise<R> {
  return runInDurableObject(stub as DurableObjectStub, callback as never) as Promise<R>;
}

/** Set-Cookie のヘッダーを全部返す */
export function setCookies(response: Response): string[] {
  return (response.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

export type Json = Record<string, any>;

/** 全テーブルを空にする (テスト同士が干渉しないように) */
export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ["invitations", "file_members", "files", "sessions", "identities", "users"].map((table) => env.DB.prepare(`delete from ${table}`)),
  );
}

export interface Client {
  cookie: string;
  email: string;
  fetch(path: string, init?: RequestInit & { json?: unknown; csrf?: boolean }): Promise<Response>;
  json<T = Json>(path: string, init?: RequestInit & { json?: unknown; csrf?: boolean }): Promise<{ status: number; body: T; response: Response }>;
}

/** Set-Cookie から `name=value` を取り出す */
export function cookieFrom(response: Response, name: string): string | null {
  for (const header of setCookies(response)) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(header);
    if (match) return `${name}=${match[1]}`;
  }
  return null;
}

/** 絶対 URL を渡すとそのホストで呼ぶ。envOverrides があれば、そのバインディングで Worker を直接呼ぶ (DEV_LOGIN や ALLOWED_EMAIL_DOMAINS を変えたいとき) */
export async function callWorker(path: string, init?: RequestInit, envOverrides?: Partial<Env>): Promise<Response> {
  // path は "/..." (http://localhost 上) か、絶対 URL (ホストや https を変えたいとき)
  const request = new Request(path.startsWith("/") ? `http://localhost${path}` : path, { redirect: "manual", ...init });
  if (!envOverrides) return SELF.fetch(request);
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return worker.fetch(request as never, { ...env, ...envOverrides } as Env, ctx) as Promise<Response>;
}

/** 開発用ログインでログインしたクライアント */
export async function loginAs(email: string, name = "", envOverrides?: Partial<Env>): Promise<Client> {
  const response = await callWorker(
    "/auth/dev",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, name }) },
    envOverrides,
  );
  if (response.status !== 302) throw new Error(`ログインできません: ${response.status} ${await response.text()}`);
  const cookie = cookieFrom(response, "untie_session");
  if (!cookie) throw new Error("Cookie が付きません");
  const client: Client = {
    cookie,
    email,
    fetch(path, init = {}) {
      const { json, csrf = true, ...rest } = init;
      const headers = new Headers(rest.headers);
      headers.set("Cookie", cookie);
      const method = (rest.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD" && csrf) headers.set("X-Requested-With", "untie");
      let body = rest.body;
      if (json !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(json);
      }
      return callWorker(path, { ...rest, headers, body }, envOverrides);
    },
    async json(path, init) {
      const response = await client.fetch(path, init);
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : null) as never, response };
    },
  };
  return client;
}

export async function userIdOf(client: Client): Promise<string> {
  return (await client.json("/api/me")).body.id as string;
}
