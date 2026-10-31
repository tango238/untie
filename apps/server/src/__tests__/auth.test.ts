import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callWorker, cookieFrom, env, loginAs, resetDb, setCookies, userIdOf } from "./helpers";
import type { Client } from "./helpers";
import type { Json } from "./helpers";
import { isEmailAllowed } from "../auth/allowed";
import { base64UrlEncode, generateToken, sha256Hex, signPayload, verifyPayload } from "../auth/crypto";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("開発用ログインとセッション", () => {
  it("ログインすると Cookie が付き、/api/me が自分を返す", async () => {
    const client = await loginAs("Taro@Example.com", "太郎");
    expect(client.cookie).toMatch(/^untie_session=.{40,}/);
    const { status, body } = await client.json("/api/me");
    expect(status).toBe(200);
    // メールは小文字に正規化される
    expect(body).toMatchObject({ email: "taro@example.com", name: "太郎" });
    expect(body.id).toMatch(/^usr_/);
  });

  it("Cookie は HttpOnly・SameSite=Lax・Path=/・Max-Age 30 日で、http では Secure を付けない", async () => {
    const response = await callWorker("/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a@example.com" }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    const header = setCookies(response).find((h) => h.startsWith("untie_session="))!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=2592000");
    expect(header).not.toContain("Secure");
  });

  it("リクエストが https なら Secure を付ける (APP_ORIGIN の設定には頼らない)", async () => {
    const response = await callWorker("https://localhost/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a@example.com" }),
    });
    expect(setCookies(response).find((h) => h.startsWith("untie_session="))).toContain("Secure");
    // APP_ORIGIN が空でも、https なら付く
    expect(env.APP_ORIGIN).toBe("");
  });

  it("ログインし直すと、持っていた Cookie のセッションの行は消える", async () => {
    const first = await loginAs("a@example.com");
    const second = await callWorker("/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: first.cookie },
      body: new URLSearchParams({ email: "a@example.com" }),
    });
    expect(second.status).toBe(302);
    expect((await env.DB.prepare("select count(*) as n from sessions").first<{ n: number }>())!.n).toBe(1);
    expect((await first.json("/api/me")).status).toBe(401);
    expect((await callWorker("/api/me", { headers: { Cookie: cookieFrom(second, "untie_session")! } })).status).toBe(200);
  });

  it("D1 にはトークンの SHA-256 だけが入る", async () => {
    const client = await loginAs("a@example.com");
    const token = client.cookie.split("=")[1];
    const row = await env.DB.prepare("select id, kind from sessions").first<{ id: string; kind: string }>();
    expect(row).toEqual({ id: await sha256Hex(token), kind: "web" });
  });

  it("同じメールで何度ログインしても同じユーザー", async () => {
    const a = await loginAs("same@example.com", "一回目");
    const b = await loginAs("SAME@example.com", "二回目");
    const [meA, meB] = [(await a.json("/api/me")).body, (await b.json("/api/me")).body];
    expect(meA.id).toBe(meB.id);
    expect(meB.name).toBe("二回目");
    expect((await env.DB.prepare("select count(*) as n from users").first<{ n: number }>())!.n).toBe(1);
  });

  it("未ログインは 401 で、エラーは { error: { code, message } }", async () => {
    const response = await callWorker("/api/me");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthenticated", message: "ログインしてください" } });
  });

  /** desktop のセッションの行を D1 に直接作って、そのトークンを返す */
  async function createDesktopToken(client: Client): Promise<string> {
    const token = generateToken();
    const now = Date.now();
    await env.DB.prepare("insert into sessions (id, user_id, kind, created_at, expires_at, last_seen_at) values (?, ?, 'desktop', ?, ?, ?)")
      .bind(await sha256Hex(token), await userIdOf(client), now, now + 90 * 24 * 60 * 60 * 1000, now)
      .run();
    return token;
  }

  it("Bearer は kind=desktop のセッションだけを受け、Cookie は kind=web だけを受ける", async () => {
    const web = await loginAs("a@example.com");
    const desktopToken = await createDesktopToken(web);
    // web のトークンを Bearer で送っても、desktop のトークンを Cookie で送っても 401
    expect((await callWorker("/api/me", { headers: { Authorization: `Bearer ${web.cookie.split("=")[1]}` } })).status).toBe(401);
    expect((await callWorker("/api/me", { headers: { Cookie: `untie_session=${desktopToken}` } })).status).toBe(401);
    expect((await callWorker("/api/me", { headers: { Authorization: `Bearer ${desktopToken}` } })).status).toBe(200);
    expect((await web.json("/api/me")).status).toBe(200);
  });

  it("Bearer トークン (desktop) でも認証できる (CSRF ヘッダーは要らない)", async () => {
    const client = await loginAs("a@example.com");
    const token = await createDesktopToken(client);
    const get = await callWorker("/api/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(get.status).toBe(200);
    const post = await callWorker("/api/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(post.status).toBe(201);
  });

  it("期限切れのセッションは 401", async () => {
    const client = await loginAs("a@example.com");
    await env.DB.prepare("update sessions set expires_at = ?").bind(Date.now() - 1000).run();
    const { status, body } = await client.json("/api/me");
    expect(status).toBe(401);
    expect(body.error.code).toBe("session_expired");
  });

  it("使うと last_seen_at と expires_at を延ばす (1 日に 1 回だけ)", async () => {
    const client = await loginAs("a@example.com");
    const day = 24 * 60 * 60 * 1000;
    const old = Date.now() - 2 * day;
    await env.DB.prepare("update sessions set last_seen_at = ?, expires_at = ?").bind(old, old + 30 * day).run();
    await client.json("/api/me");
    const row = (await env.DB.prepare("select last_seen_at, expires_at from sessions").first<{ last_seen_at: number; expires_at: number }>())!;
    expect(row.last_seen_at).toBeGreaterThan(Date.now() - 5000);
    expect(row.expires_at).toBeGreaterThan(Date.now() + 29 * day);
    // すぐもう一度使っても書き換えない
    await client.json("/api/me");
    const again = (await env.DB.prepare("select last_seen_at from sessions").first<{ last_seen_at: number }>())!;
    expect(again.last_seen_at).toBe(row.last_seen_at);
  });
});

describe("CSRF", () => {
  it("Cookie 認証で状態を変えるのに X-Requested-With が無ければ 403", async () => {
    const client = await loginAs("a@example.com");
    const { status, body } = await client.json("/api/files", { method: "POST", json: { name: "x" }, csrf: false });
    expect(status).toBe(403);
    expect(body.error.code).toBe("csrf");
    // GET は要らない
    expect((await client.json("/api/files", { csrf: false })).status).toBe(200);
  });

  it("ログアウトも同じ", async () => {
    const client = await loginAs("a@example.com");
    expect((await client.fetch("/auth/logout", { method: "POST", csrf: false })).status).toBe(403);
    expect((await client.json("/api/me")).status).toBe(200);
  });
});

describe("ログアウト", () => {
  it("logout でセッションの行と Cookie を消す", async () => {
    const client = await loginAs("a@example.com");
    const response = await client.fetch("/auth/logout", { method: "POST" });
    expect(response.status).toBe(204);
    expect(setCookies(response).find((h) => h.startsWith("untie_session="))).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect((await client.json("/api/me")).status).toBe(401);
    expect((await env.DB.prepare("select count(*) as n from sessions").first<{ n: number }>())!.n).toBe(0);
  });

  it("セッションが無くても logout は成功する", async () => {
    const response = await callWorker("/auth/logout", { method: "POST", headers: { "X-Requested-With": "untie" } });
    expect(response.status).toBe(204);
  });

  it("logout-all はそのユーザーの全セッションを消す (他のユーザーは残す)", async () => {
    const a1 = await loginAs("a@example.com");
    const a2 = await loginAs("a@example.com");
    const b = await loginAs("b@example.com");
    expect((await a1.fetch("/auth/logout-all", { method: "POST" })).status).toBe(204);
    expect((await a2.json("/api/me")).status).toBe(401);
    expect((await a1.json("/api/me")).status).toBe(401);
    expect((await b.json("/api/me")).status).toBe(200);
  });
});

describe("ログイン方法", () => {
  it("DEV_LOGIN=false なら /auth/dev は 404 で、providers にも出ない", async () => {
    const off = { DEV_LOGIN: "false" };
    expect((await callWorker("/auth/dev", {}, off)).status).toBe(404);
    const post = await callWorker("/auth/dev", { method: "POST", body: new URLSearchParams({ email: "a@example.com" }) }, off);
    expect(post.status).toBe(404);
    expect((await callWorker("/auth/login?provider=dev", {}, off)).status).toBe(404);
    expect(await (await callWorker("/auth/providers", {}, off)).json()).toEqual({ providers: ["google"] });
    expect((await env.DB.prepare("select count(*) as n from users").first<{ n: number }>())!.n).toBe(0);
  });

  it("DEV_LOGIN=true でも、ホストが localhost / 127.0.0.1 でなければ使えない", async () => {
    expect((await callWorker("http://example.com/auth/dev")).status).toBe(404);
    expect((await callWorker("http://example.com/auth/login?provider=dev")).status).toBe(404);
    expect((await callWorker("http://example.com/auth/dev", { method: "POST", body: new URLSearchParams({ email: "a@example.com" }) })).status).toBe(404);
    expect(await (await callWorker("http://example.com/auth/providers")).json()).toEqual({ providers: ["google"] });
    expect((await callWorker("http://localhost/auth/dev")).status).toBe(200);
    expect((await callWorker("http://127.0.0.1/auth/dev")).status).toBe(200);
    expect((await callWorker("http://localhost:5173/auth/dev")).status).toBe(200);
    expect((await env.DB.prepare("select count(*) as n from users").first<{ n: number }>())!.n).toBe(0);
  });

  it("DEV_LOGIN=true なら フォームが出て、login?provider=dev は /auth/dev へ", async () => {
    const form = await callWorker("/auth/dev");
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('action="/auth/dev"');
    const login = await callWorker("/auth/login?provider=dev&return=%23%2Ffiles%2Fabc");
    expect(login.status).toBe(302);
    expect(login.headers.get("Location")).toBe("/auth/dev?return=%23%2Ffiles%2Fabc");
  });

  it("providers: GOOGLE_CLIENT_ID が空なら google を出さない", async () => {
    expect(await (await callWorker("/auth/providers")).json()).toEqual({ providers: ["google", "dev"] });
    expect(await (await callWorker("/auth/providers", {}, { GOOGLE_CLIENT_ID: "" })).json()).toEqual({ providers: ["dev"] });
    expect(await (await callWorker("/auth/providers", {}, { GOOGLE_CLIENT_ID: "", DEV_LOGIN: "false" })).json()).toEqual({ providers: [] });
  });

  it("ALLOWED_EMAIL_DOMAINS に無いドメインはログインできない", async () => {
    const only = { ALLOWED_EMAIL_DOMAINS: "example.com, Corp.example.jp" };
    await expect(loginAs("ok@example.com", "", only)).resolves.toBeDefined();
    await expect(loginAs("ok@corp.example.jp", "", only)).resolves.toBeDefined();
    const response = await callWorker(
      "/auth/dev",
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "ng@other.com" }) },
      only,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("ドメイン");
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("isEmailAllowed: 空なら制限なし、@ 付きの指定も受ける、部分一致はしない", () => {
    expect(isEmailAllowed({ ALLOWED_EMAIL_DOMAINS: "" }, "a@x.com")).toBe(true);
    expect(isEmailAllowed({ ALLOWED_EMAIL_DOMAINS: "@x.com" }, "A@X.com")).toBe(true);
    expect(isEmailAllowed({ ALLOWED_EMAIL_DOMAINS: "x.com" }, "a@evilx.com")).toBe(false);
    expect(isEmailAllowed({ ALLOWED_EMAIL_DOMAINS: "x.com" }, "a@x.com.evil.com")).toBe(false);
    expect(isEmailAllowed({ ALLOWED_EMAIL_DOMAINS: "x.com" }, "no-at-sign")).toBe(false);
  });

  it("不正なメールは 400", async () => {
    const response = await callWorker("/auth/dev", { method: "POST", body: new URLSearchParams({ email: "nomail" }) });
    expect(response.status).toBe(400);
  });
});

describe("Google (OIDC)", () => {
  async function startLogin(returnTo = "") {
    const response = await callWorker(`/auth/login?provider=google${returnTo ? `&return=${encodeURIComponent(returnTo)}` : ""}`);
    const location = new URL(response.headers.get("Location")!);
    return { response, location, authCookie: cookieFrom(response, "untie_auth")! };
  }

  /** トークンエンドポイントの応答を差し替える。id_token の署名は検めない (TLS で直接受け取るため) */
  function mockTokenEndpoint(claims: Json) {
    const encode = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
    const idToken = `${encode({ alg: "RS256" })}.${encode(claims)}.sig`;
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        // 呼ばれた側の文脈で本文を読んでおく
        if (input instanceof Request) bodies.push(new TextDecoder().decode(await input.arrayBuffer()));
        return Response.json({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: idToken });
      }
      throw new Error(`想定外の通信: ${url}`);
    });
    return bodies;
  }

  it("/auth/login?provider=google は Google へ 302 し、署名付きの untie_auth Cookie を付ける", async () => {
    const { response, location, authCookie } = await startLogin("#/files/abc");
    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("client_id")).toBe("test-google-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost/auth/callback");
    expect(location.searchParams.get("scope")).toBe("openid profile email");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(authCookie).toBeTruthy();
    const header = setCookies(response).find((h) => h.startsWith("untie_auth="))!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Max-Age=600");
    // Cookie の中身は署名で守られ、state・nonce・戻り先を持つ
    const payload = await verifyPayload<Json>("test-session-secret", authCookie.split("=")[1]);
    expect(payload).toMatchObject({ state: location.searchParams.get("state"), nonce: location.searchParams.get("nonce"), returnTo: "#/files/abc" });
    expect(await verifyPayload("another-secret", authCookie.split("=")[1])).toBeNull();
  });

  it("untie_auth の Secure もリクエストが https かどうかで決まる", async () => {
    const http = await callWorker("/auth/login?provider=google");
    expect(setCookies(http).find((h) => h.startsWith("untie_auth="))).not.toContain("Secure");
    const https = await callWorker("https://localhost/auth/login?provider=google");
    expect(setCookies(https).find((h) => h.startsWith("untie_auth="))).toContain("Secure");
  });

  it("redirect_uri は APP_ORIGIN があればそれを優先し、無ければリクエストのオリジン", async () => {
    const fromRequest = new URL((await callWorker("http://localhost:5173/auth/login?provider=google")).headers.get("Location")!);
    expect(fromRequest.searchParams.get("redirect_uri")).toBe("http://localhost:5173/auth/callback");
    const fixed = new URL((await callWorker("http://localhost:8787/auth/login?provider=google", {}, { APP_ORIGIN: "http://localhost:5173/" })).headers.get("Location")!);
    expect(fixed.searchParams.get("redirect_uri")).toBe("http://localhost:5173/auth/callback");
  });

  it("GOOGLE_CLIENT_ID が空なら 404", async () => {
    expect((await callWorker("/auth/login?provider=google", {}, { GOOGLE_CLIENT_ID: "" })).status).toBe(404);
  });

  it("callback: 照合に通ればユーザーを作ってセッションを付け、/ + return へ 302", async () => {
    const { location, authCookie } = await startLogin("#/files/abc");
    const nonce = location.searchParams.get("nonce")!;
    const tokenRequestBodies = mockTokenEndpoint({
      iss: "https://accounts.google.com",
      aud: "test-google-client-id",
      sub: "google-sub-1",
      email: "Hanako@Example.com",
      email_verified: true,
      name: "花子",
      picture: "https://example.com/p.png",
      nonce,
    });
    const response = await callWorker(`/auth/callback?code=abc&state=${location.searchParams.get("state")}`, { headers: { Cookie: authCookie } });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/#/files/abc");
    const session = cookieFrom(response, "untie_session")!;
    expect(session).toBeTruthy();
    // 認可コードの交換に code_verifier を送っている (PKCE)
    expect(tokenRequestBodies[0]).toContain("code_verifier=");

    const me = await callWorker("/api/me", { headers: { Cookie: session } });
    expect(await me.json()).toMatchObject({ email: "hanako@example.com", name: "花子", avatarUrl: "https://example.com/p.png" });
    const identity = await env.DB.prepare("select provider, subject from identities").first();
    expect(identity).toEqual({ provider: "google", subject: "google-sub-1" });
    // 使い終わった untie_auth は消す
    expect(setCookies(response).find((h) => h.startsWith("untie_auth="))).toMatch(/Max-Age=0|1970/);
  });

  it("同じメールで dev から作ったユーザーに Google の identity が付く", async () => {
    const dev = await loginAs("both@example.com", "開発");
    const { location, authCookie } = await startLogin();
    mockTokenEndpoint({
      iss: "accounts.google.com",
      aud: "test-google-client-id",
      sub: "g2",
      email: "both@example.com",
      email_verified: true,
      name: "本番",
      nonce: location.searchParams.get("nonce"),
    });
    const response = await callWorker(`/auth/callback?code=abc&state=${location.searchParams.get("state")}`, { headers: { Cookie: authCookie } });
    const me = await callWorker("/api/me", { headers: { Cookie: cookieFrom(response, "untie_session")! } });
    expect((await me.json<Json>()).id).toBe((await dev.json("/api/me")).body.id);
  });

  it("callback: email_verified が true でなければ拒む", async () => {
    const { location, authCookie } = await startLogin();
    mockTokenEndpoint({ iss: "https://accounts.google.com", aud: "test-google-client-id", sub: "s", email: "a@example.com", email_verified: false, nonce: location.searchParams.get("nonce") });
    const response = await callWorker(`/auth/callback?code=abc&state=${location.searchParams.get("state")}`, { headers: { Cookie: authCookie } });
    expect(response.status).toBe(403);
    expect(cookieFrom(response, "untie_session")).toBeNull();
    expect((await env.DB.prepare("select count(*) as n from users").first<{ n: number }>())!.n).toBe(0);
  });

  it("callback: state・nonce・Cookie・ドメインが合わなければ拒む", async () => {
    const { location, authCookie } = await startLogin();
    const state = location.searchParams.get("state")!;
    const good = { iss: "https://accounts.google.com", aud: "test-google-client-id", sub: "s", email: "a@example.com", email_verified: true, nonce: location.searchParams.get("nonce") };

    // state が違う
    mockTokenEndpoint(good);
    expect((await callWorker("/auth/callback?code=abc&state=wrong", { headers: { Cookie: authCookie } })).status).toBe(400);
    // Cookie が無い
    expect((await callWorker(`/auth/callback?code=abc&state=${state}`)).status).toBe(400);
    // Cookie の署名が違う
    const forged = `untie_auth=${await signPayload("other", { state, nonce: "n", verifier: "v", returnTo: "", exp: Date.now() + 60000 })}`;
    expect((await callWorker(`/auth/callback?code=abc&state=${state}`, { headers: { Cookie: forged } })).status).toBe(400);
    // nonce が違う
    mockTokenEndpoint({ ...good, nonce: "other" });
    expect((await callWorker(`/auth/callback?code=abc&state=${state}`, { headers: { Cookie: authCookie } })).status).toBe(400);
    // aud が違う
    mockTokenEndpoint({ ...good, aud: "someone-else" });
    expect((await callWorker(`/auth/callback?code=abc&state=${state}`, { headers: { Cookie: authCookie } })).status).toBe(400);
    // ドメイン制限
    mockTokenEndpoint(good);
    const denied = await callWorker(`/auth/callback?code=abc&state=${state}`, { headers: { Cookie: authCookie } }, { ALLOWED_EMAIL_DOMAINS: "corp.example" });
    expect(denied.status).toBe(403);
    // Google が error を返した (ユーザーが取り消した)
    expect((await callWorker("/auth/callback?error=access_denied", { headers: { Cookie: authCookie } })).status).toBe(400);
  });

  it("return は # で始まる相対のものだけ受ける (外のサイトへ飛ばさない)", async () => {
    for (const bad of ["https://evil.example/", "//evil.example", "/path", "javascript:alert(1)"]) {
      const { authCookie } = await startLogin(bad);
      const payload = await verifyPayload<Json>("test-session-secret", authCookie.split("=")[1]);
      expect(payload!.returnTo).toBe("");
    }
  });
});

describe("crypto", () => {
  it("トークンは 32 バイトの乱数の base64url で、毎回違う", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });
  it("署名は改ざんを見抜く", async () => {
    const signed = await signPayload("k", { a: 1 });
    expect(await verifyPayload("k", signed)).toEqual({ a: 1 });
    expect(await verifyPayload("k", `${signed}x`)).toBeNull();
    expect(await verifyPayload("k", "no-dot")).toBeNull();
    const [body, sig] = signed.split(".");
    expect(await verifyPayload("k", `${btoa('{"a":2}')}.${sig}`)).toBeNull();
    expect(body).toBeTruthy();
  });
});
