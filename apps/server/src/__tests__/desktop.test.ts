import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callWorker, cookieFrom, env, loginAs, resetDb, setCookies } from "./helpers";
import type { Json } from "./helpers";
import { DESKTOP_ORIGINS } from "../auth/cors";
import { DESKTOP_CODE_TTL_MS, openDesktopCode, sealDesktopCode } from "../auth/desktop";
import { base64UrlEncode, sha256Base64Url, sha256Hex } from "../auth/crypto";
import { deleteExpiredSessions } from "../db/sessions";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const STATE = "abcdefghijklmnop0123456789_-ABCD";
/** PKCE: アプリが作る乱数と、そのハッシュ */
const VERIFIER = "verifier-0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const challengeOf = (verifier: string) => sha256Base64Url(verifier);
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** HTML の script にある `var url = "untie://auth/callback?code=...&state=..."` を取り出す */
function deepLinkOf(html: string): URL {
  const match = /var url = ("[^"]*");/.exec(html);
  if (!match) throw new Error("deep link が見つかりません");
  return new URL(JSON.parse(match[1]) as string);
}

/** デスクトップの開発用ログイン (login → dev の POST) を最後まで進め、callback の応答を返す */
async function devDesktopLogin(email = "taro@example.com", state = STATE, envOverrides?: Parameters<typeof callWorker>[2]) {
  const login = await callWorker(`/auth/login?provider=dev&client=desktop&state=${state}&code_challenge=${await challengeOf(VERIFIER)}`, {}, envOverrides);
  expect(login.status).toBe(302);
  const cookie = cookieFrom(login, "untie_auth")!;
  return callWorker("/auth/dev", { method: "POST", headers: { ...FORM, Cookie: cookie }, body: new URLSearchParams({ email, name: "太郎" }) }, envOverrides);
}

/** ログインして引換コードを取る */
async function obtainCode(email?: string, state = STATE): Promise<{ code: string; html: string; response: Response }> {
  const response = await devDesktopLogin(email, state);
  const html = await response.text();
  return { code: deepLinkOf(html).searchParams.get("code")!, html, response };
}

/** 引換コードを交換する。body がオブジェクトなら、code_verifier の指定が無ければ正しい VERIFIER を補う */
const exchange = (body: unknown, headers: Record<string, string> = {}) =>
  callWorker("/auth/desktop/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify({ code_verifier: VERIFIER, ...(body as object) }),
  });

describe("デスクトップのログイン: /auth/login", () => {
  it("client=desktop には state と code_challenge (PKCE) が要る (形が違えば 400)", async () => {
    const challenge = await challengeOf(VERIFIER);
    for (const state of ["", "short", "has space 0123456789abcdef", "a".repeat(129), "<script>0123456789abcdef"]) {
      const response = await callWorker(`/auth/login?provider=dev&client=desktop&state=${encodeURIComponent(state)}&code_challenge=${challenge}`);
      expect(response.status, state).toBe(400);
    }
    for (const bad of ["", "short", `${challenge}x`, "has space 0123456789abcdef0123456789abcdef0123", "<script>0123456789abcdef0123456789abcdef"]) {
      const response = await callWorker(`/auth/login?provider=dev&client=desktop&state=${STATE}&code_challenge=${encodeURIComponent(bad)}`);
      expect(response.status, bad).toBe(400);
    }
    // challenge が無い
    expect((await callWorker(`/auth/login?provider=dev&client=desktop&state=${STATE}`)).status).toBe(400);
    expect((await callWorker("/auth/login?provider=dev&client=desktop")).status).toBe(400);
    expect((await callWorker(`/auth/login?provider=google&client=desktop`)).status).toBe(400);
    // 知らない client
    expect((await callWorker(`/auth/login?provider=dev&client=tv&state=${STATE}&code_challenge=${challenge}`)).status).toBe(400);
  });

  it("dev: untie_auth に client と state を持たせて /auth/dev へ。DEV_LOGIN=false なら 404", async () => {
    const query = `provider=dev&client=desktop&state=${STATE}&code_challenge=${await challengeOf(VERIFIER)}`;
    const response = await callWorker(`/auth/login?${query}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/auth/dev");
    const header = setCookies(response).find((h) => h.startsWith("untie_auth="))!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Path=/auth");
    expect((await callWorker(`/auth/login?${query}`, {}, { DEV_LOGIN: "false" })).status).toBe(404);
  });

  it("デスクトップでないログインは、前のデスクトップのログインが残した untie_auth を消す (dev の POST が引換コードのページを返さない)", async () => {
    const desktop = await callWorker(`/auth/login?provider=dev&client=desktop&state=${STATE}&code_challenge=${await challengeOf(VERIFIER)}`);
    const stale = cookieFrom(desktop, "untie_auth")!;
    for (const url of ["/auth/login?provider=dev", "/auth/login?provider=dev&client=web", "/auth/login?provider=nope"]) {
      const response = await callWorker(url, { headers: { Cookie: stale } });
      expect(setCookies(response).find((h) => h.startsWith("untie_auth="))!, url).toMatch(/Max-Age=0|1970/);
    }
    // Google は新しい untie_auth で上書きする (client は入らない)
    const google = await callWorker("/auth/login?provider=google", { headers: { Cookie: stale } });
    expect(setCookies(google).filter((h) => h.startsWith("untie_auth="))).toHaveLength(1);
    // ブラウザが Cookie を消した状態で POST すれば Web のログイン
    const post = await callWorker("/auth/dev", { method: "POST", headers: FORM, body: new URLSearchParams({ email: "a@example.com" }) });
    expect(post.status).toBe(302);
  });

  it("google: untie_auth に client=desktop と appState が入り、OIDC の state とは別", async () => {
    const challenge = await challengeOf(VERIFIER);
    const response = await callWorker(`/auth/login?provider=google&client=desktop&state=${STATE}&code_challenge=${challenge}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    const { verifyPayload } = await import("../auth/crypto");
    const payload = await verifyPayload<Json>(env.SESSION_SECRET, cookieFrom(response, "untie_auth")!.split("=")[1]);
    expect(payload).toMatchObject({ client: "desktop", appState: STATE, challenge, state: location.searchParams.get("state") });
    expect(payload!.state).not.toBe(STATE);
    // Web のログインには client も appState も入らない
    const web = await callWorker("/auth/login?provider=google");
    const webPayload = await verifyPayload<Json>(env.SESSION_SECRET, cookieFrom(web, "untie_auth")!.split("=")[1]);
    expect(webPayload).not.toHaveProperty("client");
    expect(webPayload).not.toHaveProperty("appState");
    expect(webPayload).not.toHaveProperty("challenge");
  });
});

describe("デスクトップのログイン: callback と引換コード", () => {
  it("dev の callback は Cookie を付けず、deep link と引換コードを入れた HTML を返す", async () => {
    const { response, html, code } = await obtainCode();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toMatch(/script-src 'nonce-/);
    // デスクトップは Cookie を使わない (使い終わった untie_auth を消すものだけ)
    expect(cookieFrom(response, "untie_session")).toBeNull();
    expect(setCookies(response).every((h) => h.startsWith("untie_auth=") && /Max-Age=0|1970/.test(h))).toBe(true);

    expect(html).toContain("アプリに戻ります");
    expect(html).toContain("untie://auth/callback?code=");
    const link = deepLinkOf(html);
    expect(link.protocol).toBe("untie:");
    expect(link.host + link.pathname).toBe("auth/callback");
    expect(link.searchParams.get("state")).toBe(STATE);
    expect(code.length).toBeGreaterThan(40);
    expect(html).toContain("location.href = url");
    // deep link が開けない環境のために、引換コードを表示してコピーさせる
    expect(html).toContain(`<textarea class="code" id="code" readonly>${code}</textarea>`);
    expect(html).toContain("コピー");
  });

  it("引換コードは暗号化されていて、セッションの行 (kind=desktop・90 日) のトークンを運ぶ", async () => {
    const { code } = await obtainCode();
    const payload = (await openDesktopCode(env, code))!;
    expect(Object.keys(payload).sort()).toEqual(["challenge", "exp", "sessionHash", "state"]);
    expect(payload.state).toBe(STATE);
    expect(payload.challenge).toBe(await challengeOf(VERIFIER));
    expect(payload.exp).toBeGreaterThan(Date.now() + DESKTOP_CODE_TTL_MS - 5000);
    expect(payload.exp).toBeLessThanOrEqual(Date.now() + DESKTOP_CODE_TTL_MS);
    // コードにトークンは入らない (この時点でトークンは存在しない)。state も平文では見えない
    expect(atob(code.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain(STATE);

    const row = (await env.DB.prepare("select id, kind, created_at, expires_at, activated_at from sessions").first<Json>())!;
    expect(row.id).toBe(payload.sessionHash);
    expect(row.kind).toBe("desktop");
    expect(row.expires_at - row.created_at).toBe(90 * 24 * 60 * 60 * 1000);
    expect(row.activated_at).toBeNull();
  });

  it("引換コードは毎回違い (IV が乱数)、別の TICKET_SECRET では開けず、改ざんも弾く", async () => {
    const payload = { sessionHash: "h", state: STATE, challenge: "c".repeat(43), exp: Date.now() + 60000 };
    const a = await sealDesktopCode(env, payload);
    const b = await sealDesktopCode(env, payload);
    expect(a).not.toBe(b);
    expect(await openDesktopCode(env, a)).toEqual(payload);
    expect(await openDesktopCode({ TICKET_SECRET: "another-ticket-secret-0123456789abcdef" }, a)).toBeNull();
    // 1 文字変える・短くする・空
    const flipped = a.slice(0, -2) + (a.endsWith("AA") ? "BB" : "AA");
    expect(await openDesktopCode(env, flipped)).toBeNull();
    expect(await openDesktopCode(env, a.slice(0, 10))).toBeNull();
    expect(await openDesktopCode(env, "")).toBeNull();
    expect(await openDesktopCode(env, "!!!not base64!!!")).toBeNull();
  });

  it("交換するまでは、行の id (引換コードの sessionHash) を Bearer に使っても通らない", async () => {
    const { code } = await obtainCode();
    const payload = (await openDesktopCode(env, code))!;
    expect((await callWorker("/api/me", { headers: { Authorization: `Bearer ${payload.sessionHash}` } })).status).toBe(401);
  });

  it("exchange: token と user が返り、/api/me が Bearer で通る (Cookie は要らない)", async () => {
    const { code } = await obtainCode("Taro@Example.com");
    const response = await exchange({ code, state: STATE });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(setCookies(response)).toEqual([]);
    const body = (await response.json()) as Json;
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(body.user).toMatchObject({ email: "taro@example.com", name: "太郎" });

    const me = await callWorker("/api/me", { headers: { Authorization: `Bearer ${body.token}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "taro@example.com" });
    // Bearer は CSRF のヘッダーなしで状態を変えられる
    const created = await callWorker("/api/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${body.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(created.status).toBe(201);
    const row = (await env.DB.prepare("select id, activated_at from sessions").first<Json>())!;
    expect(row.activated_at).toBeGreaterThan(Date.now() - 5000);
  });

  it("exchange は新しいトークンを作り、行の id をそのハッシュに入れ替える (引換コードの sessionHash はもう使えない)", async () => {
    const { code } = await obtainCode();
    const payload = (await openDesktopCode(env, code))!;
    const body = (await (await exchange({ code, state: STATE })).json()) as Json;
    const rows = (await env.DB.prepare("select id from sessions").all<Json>()).results;
    expect(rows).toEqual([{ id: await sha256Hex(body.token) }]);
    expect(rows[0].id).not.toBe(payload.sessionHash);
    // 同じコードをどう組み替えても、トークンは取り出せない (コードに入っているのは行の id・state・challenge・期限だけ)
    expect(JSON.stringify(payload)).not.toContain(body.token);
  });

  it("PKCE: code_verifier が違えば 400 invalid_verifier で、コードは使われない。正しい verifier ならまだ交換できる", async () => {
    const { code } = await obtainCode();
    for (const code_verifier of ["wrong-verifier-0123456789_ABCDEFGHIJKLMNOPQRSTUV", `${VERIFIER}x`]) {
      const response = await exchange({ code, state: STATE, code_verifier });
      expect(response.status).toBe(400);
      expect(((await response.json()) as Json).error.code).toBe("invalid_verifier");
    }
    expect((await env.DB.prepare("select activated_at from sessions").first<Json>())!.activated_at).toBeNull();
    // code_verifier が無い・短い・使えない文字は形の違いとして 400
    for (const body of [{ code, state: STATE, code_verifier: undefined }, { code, state: STATE, code_verifier: "short" }, { code, state: STATE, code_verifier: `${VERIFIER}!` }]) {
      const response = await callWorker("/auth/desktop/exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
    expect((await exchange({ code, state: STATE })).status).toBe(200);
  });

  it("PKCE: コードを盗んでも、verifier を持たない者は交換できない (state を知っていても)", async () => {
    const { code } = await obtainCode();
    const stolen = await exchange({ code, state: STATE, code_verifier: "attacker-0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    expect(stolen.status).toBe(400);
    expect((await exchange({ code, state: STATE })).status).toBe(200);
  });

  it("2 回目の exchange は 401 code_used で、最初に得たトークンは使えたまま", async () => {
    const { code } = await obtainCode();
    const first = (await (await exchange({ code, state: STATE })).json()) as Json;
    const second = await exchange({ code, state: STATE });
    expect(second.status).toBe(401);
    expect(((await second.json()) as Json).error.code).toBe("code_used");
    expect((await callWorker("/api/me", { headers: { Authorization: `Bearer ${first.token}` } })).status).toBe(200);
    // 同時に 2 本来ても、通るのは 1 本だけ
    const again = await obtainCode("b@example.com", STATE);
    const results = await Promise.all([exchange({ code: again.code, state: STATE }), exchange({ code: again.code, state: STATE })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("state が合わなければ 400。コードは使われず、正しい state ならまだ交換できる", async () => {
    const { code } = await obtainCode();
    const wrong = await exchange({ code, state: "zzzzzzzzzzzzzzzzzzzzzzzz" });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as Json).error.code).toBe("state_mismatch");
    expect((await env.DB.prepare("select activated_at from sessions").first<Json>())!.activated_at).toBeNull();
    expect((await exchange({ code, state: STATE })).status).toBe(200);
  });

  it("期限切れのコードは 401 code_expired で、セッションは使えないまま", async () => {
    const { code } = await obtainCode();
    const live = (await openDesktopCode(env, code))!;
    const expired = await sealDesktopCode(env, { ...live, exp: Date.now() - 1000 });
    const response = await exchange({ code: expired, state: STATE });
    expect(response.status).toBe(401);
    expect(((await response.json()) as Json).error.code).toBe("code_expired");
    expect((await env.DB.prepare("select activated_at from sessions").first<Json>())!.activated_at).toBeNull();
    expect((await callWorker("/api/me", { headers: { Authorization: `Bearer ${live.sessionHash}` } })).status).toBe(401);
  });

  it("壊れたコード、形の違うリクエストは 400", async () => {
    const { code } = await obtainCode();
    const response = await exchange({ code: "garbage", state: STATE });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Json).error.code).toBe("invalid_code");
    expect((await exchange("not json")).status).toBe(400);
    expect((await exchange({ code })).status).toBe(400);
    expect((await exchange({ code, state: STATE, extra: 1 })).status).toBe(400);
    expect((await exchange({ code: "", state: STATE })).status).toBe(400);
    // どれも交換していない
    expect((await env.DB.prepare("select activated_at from sessions").first<Json>())!.activated_at).toBeNull();
  });

  it("消されたセッション (ログアウト済み) のコードは 401 code_used", async () => {
    const { code } = await obtainCode();
    await env.DB.prepare("delete from sessions").run();
    const response = await exchange({ code, state: STATE });
    expect(response.status).toBe(401);
    expect(((await response.json()) as Json).error.code).toBe("code_used");
  });

  it("交換されないまま 1 時間たったデスクトップのセッションは、cron の掃除で消える", async () => {
    await obtainCode();
    const web = await loginAs("w@example.com");
    await deleteExpiredSessions(env.DB, Date.now());
    expect((await env.DB.prepare("select count(*) as n from sessions").first<Json>())!.n).toBe(2);
    await deleteExpiredSessions(env.DB, Date.now() + 61 * 60 * 1000);
    const rows = (await env.DB.prepare("select kind from sessions").all<Json>()).results;
    expect(rows).toEqual([{ kind: "web" }]);
    expect((await web.json("/api/me")).status).toBe(200);
  });

  it("untie_auth が無い・壊れていれば、dev の POST は今までどおり Web のログイン", async () => {
    const response = await callWorker("/auth/dev", { method: "POST", headers: FORM, body: new URLSearchParams({ email: "a@example.com" }) });
    expect(response.status).toBe(302);
    expect(cookieFrom(response, "untie_session")).toBeTruthy();
    const forged = await callWorker("/auth/dev", { method: "POST", headers: { ...FORM, Cookie: "untie_auth=forged.sig" }, body: new URLSearchParams({ email: "a@example.com" }) });
    expect(forged.status).toBe(302);
    expect(cookieFrom(forged, "untie_session")).toBeTruthy();
  });

  it("ドメイン制限は desktop にも効く", async () => {
    const response = await devDesktopLogin("ng@other.com", STATE, { ALLOWED_EMAIL_DOMAINS: "example.com" });
    expect(response.status).toBe(403);
    expect((await env.DB.prepare("select count(*) as n from sessions").first<Json>())!.n).toBe(0);
  });

  it("google の callback も、デスクトップなら引換コードのページを返す", async () => {
    const login = await callWorker(`/auth/login?provider=google&client=desktop&state=${STATE}&code_challenge=${await challengeOf(VERIFIER)}`);
    const location = new URL(login.headers.get("Location")!);
    const encode = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
    const idToken = `${encode({ alg: "RS256" })}.${encode({
      iss: "https://accounts.google.com",
      aud: "test-google-client-id",
      sub: "g-desktop",
      email: "Hanako@Example.com",
      email_verified: true,
      name: "花子",
      nonce: location.searchParams.get("nonce"),
    })}.sig`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: idToken });
      throw new Error(`想定外の通信: ${url}`);
    });
    const response = await callWorker(`/auth/callback?code=abc&state=${location.searchParams.get("state")}`, { headers: { Cookie: cookieFrom(login, "untie_auth")! } });
    expect(response.status).toBe(200);
    expect(cookieFrom(response, "untie_session")).toBeNull();
    const link = deepLinkOf(await response.text());
    expect(link.searchParams.get("state")).toBe(STATE);
    const body = (await (await exchange({ code: link.searchParams.get("code"), state: STATE })).json()) as Json;
    expect(body.user).toMatchObject({ email: "hanako@example.com", name: "花子" });
    expect((await callWorker("/api/me", { headers: { Authorization: `Bearer ${body.token}` } })).status).toBe(200);
  });
});

describe("デスクトップのログアウト (Bearer)", () => {
  async function bearer(email = "taro@example.com") {
    const { code } = await obtainCode(email);
    return ((await (await exchange({ code, state: STATE })).json()) as Json).token as string;
  }

  it("POST /auth/logout は Bearer でも行を消す (CSRF のヘッダーは要らない)", async () => {
    const token = await bearer();
    const response = await callWorker("/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(204);
    expect((await env.DB.prepare("select count(*) as n from sessions").first<Json>())!.n).toBe(0);
    expect((await callWorker("/api/me", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("POST /auth/logout-all は Bearer でそのユーザーの全セッションを消す", async () => {
    const token = await bearer();
    const web = await loginAs("taro@example.com");
    const other = await loginAs("other@example.com");
    expect((await callWorker("/auth/logout-all", { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status).toBe(204);
    expect((await web.json("/api/me")).status).toBe(401);
    expect((await other.json("/api/me")).status).toBe(200);
  });
});

describe("CORS (デスクトップの WebView)", () => {
  const PATHS = ["/api/me", "/auth/providers", "/auth/desktop/exchange", "/auth/logout", "/auth/logout-all"];

  it("許す送り元の一覧は tauri://localhost・http://tauri.localhost。http://localhost:1420 (tauri dev) は DEV_LOGIN=true のときだけ", async () => {
    expect([...DESKTOP_ORIGINS]).toEqual(["tauri://localhost", "http://tauri.localhost"]);
    const preflight = (envOverrides?: Parameters<typeof callWorker>[2]) =>
      callWorker("/api/me", { method: "OPTIONS", headers: { Origin: "http://localhost:1420", "Access-Control-Request-Method": "GET" } }, envOverrides);
    const on = await preflight();
    expect(on.status).toBe(204);
    expect(on.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:1420");
    const off = await preflight({ DEV_LOGIN: "false" });
    expect(off.status).toBe(403);
    expect(off.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const response = await callWorker("/auth/providers", { headers: { Origin: "http://localhost:1420" } }, { DEV_LOGIN: "false" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("プリフライト: 許す送り元には 204 とヘッダー (credentials なし)、すべての対象パスで", async () => {
    for (const origin of [...DESKTOP_ORIGINS, "http://localhost:1420"]) {
      for (const path of PATHS) {
        const response = await callWorker(path, {
          method: "OPTIONS",
          headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
        });
        expect(response.status, `${origin} ${path}`).toBe(204);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
        expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, Content-Type, X-Untie-Token, X-Requested-With");
        expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, PUT, PATCH, DELETE, OPTIONS");
        expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
        expect(response.headers.get("Vary")).toContain("Origin");
      }
    }
  });

  it("プリフライト: 許さない送り元には Allow-Origin を付けない (403)", async () => {
    for (const origin of ["https://evil.example", "http://localhost:5173", "http://localhost:1421", "tauri://evil", "null", "http://localhost:1420.evil.example"]) {
      const response = await callWorker("/api/me", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET" } });
      expect(response.status, origin).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
    }
  });

  it("本体の応答 (成功も 401 も) に、許す送り元だけを echo する。Allow-Credentials は付けない", async () => {
    for (const origin of [...DESKTOP_ORIGINS, "http://localhost:1420"]) {
      const ok = await callWorker("/auth/providers", { headers: { Origin: origin } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(ok.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      expect(ok.headers.get("Access-Control-Expose-Headers")).toBe("Content-Disposition");
      expect(ok.headers.get("Vary")).toContain("Origin");
      const denied = await callWorker("/api/me", { headers: { Origin: origin } });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
  });

  it("許さない送り元・送り元なしの応答には CORS のヘッダーが付かない", async () => {
    for (const headers of [{ Origin: "https://evil.example" }, { Origin: "http://localhost:5173" }, {}] as Record<string, string>[]) {
      const response = await callWorker("/auth/providers", { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
  });

  it("対象外のパス (/auth/login・/parties/*) には CORS を付けない", async () => {
    const login = await callWorker("/auth/login?provider=nope", { headers: { Origin: "tauri://localhost" } });
    expect(login.status).toBe(400);
    expect(login.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const parties = await callWorker("/parties/untie-room/x", { headers: { Origin: "tauri://localhost" } });
    expect(parties.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("Bearer は CORS 経由で通り、書き出しのファイル名を読めるよう Expose-Headers が付く", async () => {
    const { code } = await obtainCode();
    const token = ((await (await exchange({ code, state: STATE }, { Origin: "tauri://localhost" })).json()) as Json).token;
    const me = await callWorker("/api/me", { headers: { Origin: "tauri://localhost", Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(me.headers.get("Access-Control-Allow-Origin")).toBe("tauri://localhost");
  });

  it("Cookie 認証は CORS 経由では使わない: デスクトップの送り元から届いた Cookie は無かったことにする", async () => {
    const web = await loginAs("a@example.com");
    expect((await callWorker("/api/me", { headers: { Cookie: web.cookie } })).status).toBe(200);
    for (const origin of [...DESKTOP_ORIGINS, "http://localhost:1420"]) {
      const response = await callWorker("/api/me", { headers: { Cookie: web.cookie, Origin: origin } });
      expect(response.status, origin).toBe(401);
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
    // Cookie のセッションも消えていない (読まなかっただけ)
    expect((await web.json("/api/me")).status).toBe(200);
  });
});
