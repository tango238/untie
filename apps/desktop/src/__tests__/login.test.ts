import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { LoginResult, Platform } from "@untie/ui/platform";
import { desktopPlatform } from "../platform";

// キーチェーンはメモリの Map で代える (Rust のコマンド get_secret / set_secret / delete_secret)
const keychain = new Map<string, string>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const opener = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => opener);
const link = vi.hoisted(() => ({ handler: null as null | ((urls: string[]) => void), current: null as string[] | null, listens: 0 }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: async (handler: (urls: string[]) => void) => {
    link.listens++;
    link.handler = handler;
    return () => {};
  },
  getCurrent: async () => link.current,
}));

const ORIGIN = "https://untie.example.com";
const user = { id: "u1", email: "me@example.com", name: "太郎" };
const exchangeBody = (token = "tok-1") => new Response(JSON.stringify({ token, user }), { status: 200, headers: { "Content-Type": "application/json" } });

let platform: Platform;
let results: LoginResult[];
let fetchMock: ReturnType<typeof vi.fn>;

/** login が開いた URL から state を取り出す */
const openedState = () => new URL(opener.openUrl.mock.lastCall![0] as string).searchParams.get("state")!;
const openedChallenge = () => new URL(opener.openUrl.mock.lastCall![0] as string).searchParams.get("code_challenge")!;
const pendingRecord = () => JSON.parse(sessionStorage.getItem("untie.desktopLogin")!);
/** PKCE: base64url(sha256(verifier)) */
async function challengeOf(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const NO_RECORD = "ログインの記録がありません。もう一度ログインしてください";
const callbackUrl = (code: string, state: string) => `untie://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
/** 購読して、ログインを始め、開いた URL の state を返す */
async function startLogin(returnTo = "#/") {
  await platform.login("google", returnTo);
  await vi.waitFor(() => expect(link.handler).not.toBeNull());
  return openedState();
}
const deepLink = (url: string) => link.handler!([url]);

beforeEach(() => {
  vi.resetAllMocks();
  keychain.clear();
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = "";
  link.handler = null;
  link.current = null;
  link.listens = 0;
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    const { name, value } = (args ?? {}) as { name: string; value: string };
    if (command === "get_secret") return keychain.get(name) ?? null;
    if (command === "set_secret") keychain.set(name, value);
    if (command === "delete_secret") keychain.delete(name);
    return null;
  });
  fetchMock = vi.fn(async () => exchangeBody());
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem("untie.serverOrigin", ORIGIN);
  platform = desktopPlatform();
  results = [];
  platform.onLoggedIn!((r) => results.push(r));
});
afterEach(() => vi.unstubAllGlobals());

describe("login: 既定のブラウザで /auth/login を開く", () => {
  it("provider・client=desktop・state・code_challenge を付けた URL を開き、state・verifier・戻り先を sessionStorage に置く", async () => {
    const state = await startLogin("#/f/abc");
    const pending = pendingRecord();
    // PKCE (RFC 7636): verifier は 43 文字以上の乱数、challenge = base64url(sha256(verifier))。URL には challenge だけを載せる
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const challenge = await challengeOf(pending.verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opener.openUrl).toHaveBeenCalledWith(`${ORIGIN}/auth/login?provider=google&client=desktop&state=${state}&code_challenge=${challenge}`);
    expect(opener.openUrl.mock.lastCall![0]).not.toContain(pending.verifier);
    // サーバーが受ける形 (16〜128 文字の英数字と - _)
    expect(state).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(pending).toMatchObject({ state, returnTo: "#/f/abc", origin: ORIGIN });
    // ログインのたびに違う state
    await platform.login("dev", "#/");
    expect(openedState()).not.toBe(state);
    expect(pendingRecord().verifier).not.toBe(pending.verifier);
    expect(opener.openUrl).toHaveBeenLastCalledWith(expect.stringContaining("provider=dev&client=desktop"));
  });

  it("サーバーが未設定ならブラウザを開かず Error", async () => {
    localStorage.removeItem("untie.serverOrigin");
    await expect(platform.login("google", "#/")).rejects.toThrow("サーバーが設定されていません");
    expect(opener.openUrl).not.toHaveBeenCalled();
  });
});

describe("deep link で戻る", () => {
  it("state が合えば引換コードを交換して、トークンをキーチェーンに置き、戻り先へ移って onLoggedIn で知らせる", async () => {
    const state = await startLogin("#/f/abc");
    const challenge = openedChallenge();
    deepLink(callbackUrl("the-code", state));
    await vi.waitFor(() => expect(results).toEqual([{ ok: true }]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/auth/desktop/exchange`);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" } });
    // PKCE: 交換には、login で渡した challenge の元の verifier を送る
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ code: "the-code", state, code_verifier: expect.any(String) });
    expect(await challengeOf(sent.code_verifier)).toBe(challenge);
    expect(keychain.get("session")).toBe("tok-1");
    expect(invoke).toHaveBeenCalledWith("set_secret", { name: "session", value: "tok-1" });
    expect(window.location.hash).toBe("#/f/abc");
    // 使い終わった記録は消える (同じ deep link をもう一度受けても通らない)
    expect(sessionStorage.getItem("untie.desktopLogin")).toBeNull();
  });

  it("state が違う deep link は拒む (サーバーにもキーチェーンにも触れない)", async () => {
    await startLogin();
    deepLink(callbackUrl("the-code", "forged-state-forged-state-forged"));
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({ ok: false, message: expect.stringContaining("このアプリが始めたログインではありません") });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(keychain.has("session")).toBe(false);
    // 本物の戻りはまだ受けられる
    deepLink(callbackUrl("the-code", openedState()));
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results[1]).toEqual({ ok: true });
  });

  it("ログインの記録が無いまま届いた deep link は、黙って捨てずに「記録がありません」と知らせる。何度届いても知らせるのは 1 度", async () => {
    await platform.onLoggedIn!(() => {});
    await vi.waitFor(() => expect(link.handler).not.toBeNull());
    deepLink(callbackUrl("c", "s".repeat(32)));
    await vi.waitFor(() => expect(results).toEqual([{ ok: false, message: NO_RECORD }]));
    deepLink(callbackUrl("c2", "s".repeat(32)));
    await new Promise((r) => setTimeout(r, 20));
    expect(results).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    // ログインを始めればまた知らせる対象に戻る
    await platform.login("google", "#/");
    sessionStorage.removeItem("untie.desktopLogin");
    deepLink(callbackUrl("c3", "s".repeat(32)));
    await vi.waitFor(() => expect(results).toHaveLength(2));
  });

  it("始めてから 15 分たった記録は使わず「時間切れです」と知らせる (14 分ならまだ使える)", async () => {
    const state = await startLogin();
    const pending = pendingRecord();
    sessionStorage.setItem("untie.desktopLogin", JSON.stringify({ ...pending, at: Date.now() - 14 * 60 * 1000 }));
    deepLink(callbackUrl("fresh", state));
    await vi.waitFor(() => expect(results).toEqual([{ ok: true }]));

    const state2 = await startLogin();
    sessionStorage.setItem("untie.desktopLogin", JSON.stringify({ ...pendingRecord(), at: Date.now() - 16 * 60 * 1000 }));
    deepLink(callbackUrl("stale", state2));
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results[1]).toEqual({ ok: false, message: "時間切れです。もう一度ログインしてください" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("交換が済んだあとに、同じ deep link が時間をあけてもう一度届いても、何もしない (エラーも出さない)", async () => {
    const state = await startLogin();
    deepLink(callbackUrl("once", state));
    await vi.waitFor(() => expect(results).toEqual([{ ok: true }]));
    expect(sessionStorage.getItem("untie.desktopLogin")).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    deepLink(callbackUrl("once", state));
    await new Promise((r) => setTimeout(r, 50));
    expect(results).toEqual([{ ok: true }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("交換している間にサーバーの URL を変えたら、返ってきたトークンは保存しない(新しいサーバーに送らない)", async () => {
    fetchMock.mockImplementationOnce(async () => {
      await platform.setServerOrigin!("https://other.example.com");
      return exchangeBody("tok-from-old-server");
    });
    const state = await startLogin();
    deepLink(callbackUrl("racing", state));
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({ ok: false, message: expect.stringContaining("もう一度ログインしてください") });
    expect(keychain.has("session")).toBe(false);
    expect(platform.serverOrigin()).toBe("https://other.example.com");
    expect(new Headers((await platform.authorize({})).headers).has("Authorization")).toBe(false);
  });

  it("交換している間にログインの記録が消えた (別のログインを始めた・取り消した) ときも、保存しない", async () => {
    fetchMock.mockImplementationOnce(async () => {
      sessionStorage.removeItem("untie.desktopLogin");
      return exchangeBody();
    });
    const state = await startLogin();
    deepLink(callbackUrl("cancelled", state));
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({ ok: false });
    expect(keychain.has("session")).toBe(false);
  });

  it("deep link の URL は hostname に頼らず、untie://auth/callback の頭で見分ける(末尾のスラッシュ・大文字小文字は許し、似た別の URL は無視する)", async () => {
    const state = await startLogin();
    for (const bad of ["untie://auth/callbackx?code=c&state=" + state, "untie://auth/callback-evil?code=c&state=" + state, "untie://auth.evil/callback?code=c&state=" + state, "untie://auth/other?code=c&state=" + state]) {
      deepLink(bad);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    deepLink(`UNTIE://auth/callback/?code=slash&state=${state}`);
    await vi.waitFor(() => expect(results).toEqual([{ ok: true }]));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({ code: "slash", state });
  });

  it("untie://auth/callback 以外の URL、code や state の無い URL は無視する", async () => {
    const state = await startLogin();
    deepLink("untie://other/callback?code=c&state=" + state);
    deepLink("untie://auth/callback?state=" + state);
    deepLink("https://untie.example.com/?code=c&state=" + state);
    deepLink("not a url");
    await new Promise((r) => setTimeout(r, 20));
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("同じ deep link が重ねて届いても、交換は 1 回", async () => {
    const state = await startLogin();
    deepLink(callbackUrl("same-code", state));
    deepLink(callbackUrl("same-code", state));
    await vi.waitFor(() => expect(results).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ ok: true }]);
  });

  it("サーバーが拒んだら (使用済み・期限切れ) その文言を知らせ、トークンは置かない", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "code_used", message: "この引換コードはすでに使われています。もう一度ログインしてください" } }), { status: 401 }),
    );
    const state = await startLogin();
    deepLink(callbackUrl("used", state));
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toEqual({ ok: false, message: "この引換コードはすでに使われています。もう一度ログインしてください" });
    expect(keychain.has("session")).toBe(false);
    expect(sessionStorage.getItem("untie.desktopLogin")).not.toBeNull();
  });

  it("サーバーにつながらなければ理由を知らせ、同じ deep link をもう一度開けば交換できる", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const state = await startLogin();
    deepLink(callbackUrl("retry", state));
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({ ok: false, message: expect.stringContaining("サーバーにつながりません") });
    deepLink(callbackUrl("retry", state));
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results[1]).toEqual({ ok: true });
  });

  it("返事の形が違えば失敗として知らせる", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ nothing: true }), { status: 200 }));
    const state = await startLogin();
    deepLink(callbackUrl("c", state));
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({ ok: false });
    expect(keychain.has("session")).toBe(false);
  });

  it("deep link で起動されたとき (getCurrent) も、始めたログインの戻りなら受ける。記録が無ければ「記録がありません」と知らせる", async () => {
    // 記録が無い(新しく起動された): 黙って捨てず、知らせる
    link.current = [callbackUrl("old", "o".repeat(32))];
    const quiet = desktopPlatform();
    const quietResults: LoginResult[] = [];
    quiet.onLoggedIn!((r) => quietResults.push(r));
    await vi.waitFor(() => expect(quietResults).toEqual([{ ok: false, message: NO_RECORD }]));
    expect(fetchMock).not.toHaveBeenCalled();

    // 始めたログインの戻り: 記録 (sessionStorage) があれば受ける
    sessionStorage.setItem("untie.desktopLogin", JSON.stringify({ state: "s".repeat(32), verifier: "v".repeat(43), returnTo: "#/", origin: ORIGIN, at: Date.now() }));
    link.current = [callbackUrl("fresh", "s".repeat(32))];
    const cold = desktopPlatform();
    const coldResults: LoginResult[] = [];
    cold.onLoggedIn!((r) => coldResults.push(r));
    await vi.waitFor(() => expect(coldResults).toEqual([{ ok: true }]));
    expect(keychain.get("session")).toBe("tok-1");
  });

  it("deep link の受け取りは Platform ごとに 1 度だけ始める", async () => {
    await startLogin();
    await platform.login("google", "#/");
    platform.onLoggedIn!(() => {});
    expect(link.listens).toBe(1);
  });
});

describe("completeLoginWithCode: 引換コードを貼る", () => {
  it("ログインを始めていれば、貼ったコードを交換して保存し、onLoggedIn で知らせる", async () => {
    const state = await startLogin("#/f/zzz");
    const pendingRecordVerifier = pendingRecord().verifier;
    await platform.completeLoginWithCode!("  pasted-code \n");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // deep link と同じ記録の verifier を使う
    expect(JSON.parse(init.body as string)).toEqual({ code: "pasted-code", state, code_verifier: pendingRecordVerifier });
    expect(keychain.get("session")).toBe("tok-1");
    expect(results).toEqual([{ ok: true }]);
    expect(window.location.hash).toBe("#/f/zzz");
  });

  it("deep link の URL ごと貼られても code を取り出す", async () => {
    const state = await startLogin();
    await platform.completeLoginWithCode!(callbackUrl("from-url", state));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({ code: "from-url", state });
  });

  it("ログインを始めていなければ Error。サーバーが拒んだ理由は Error で返す (onLoggedIn には流さない)", async () => {
    await expect(platform.completeLoginWithCode!("x")).rejects.toThrow("先に「ログイン」を押してください");
    await startLogin();
    await expect(platform.completeLoginWithCode!("   ")).rejects.toThrow("引換コードを貼ってください");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "state_mismatch", message: "このアプリが始めたログインではありません" } }), { status: 400 }));
    await expect(platform.completeLoginWithCode!("bad")).rejects.toThrow("このアプリが始めたログインではありません");
    expect(results).toEqual([]);
    expect(keychain.has("session")).toBe(false);
  });

  it("失敗したコードは「処理済み」から外れ、同じコードの deep link をあとから受けられる。記録が期限切れなら「時間切れです」", async () => {
    const state = await startLogin();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(platform.completeLoginWithCode!("retry-code")).rejects.toThrow("サーバーにつながりません");
    deepLink(callbackUrl("retry-code", state));
    await vi.waitFor(() => expect(results).toEqual([{ ok: true }]));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await startLogin();
    sessionStorage.setItem("untie.desktopLogin", JSON.stringify({ ...pendingRecord(), at: Date.now() - 16 * 60 * 1000 }));
    await expect(platform.completeLoginWithCode!("late")).rejects.toThrow("時間切れです。もう一度ログインしてください");
  });
});

describe("authorize: セッションのトークンを Authorization に付ける", () => {
  it("キーチェーンに session があれば Bearer を足し、元のヘッダー (plain object) を残す。credentials は omit", async () => {
    keychain.set("session", "tok-xyz");
    const init = { method: "POST", headers: { Accept: "application/json", "X-Requested-With": "untie" }, credentials: "include" as const, body: "{}" };
    const out = await platform.authorize(init);
    const headers = new Headers(out.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok-xyz");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("X-Requested-With")).toBe("untie");
    expect(out).toMatchObject({ method: "POST", body: "{}", credentials: "omit" });
    // 渡した init は書き換えない
    expect(init.headers).toEqual({ Accept: "application/json", "X-Requested-With": "untie" });
    expect(init.credentials).toBe("include");
  });

  it("Headers で渡されても壊さず、Authorization を上書きする", async () => {
    keychain.set("session", "tok-xyz");
    const given = new Headers({ "Content-Type": "application/json", Authorization: "Bearer old" });
    const out = await platform.authorize({ headers: given });
    const headers = new Headers(out.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok-xyz");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(given.get("Authorization")).toBe("Bearer old");
  });

  it("配列のヘッダーも受ける。ヘッダーが無い init にも付く", async () => {
    keychain.set("session", "tok-xyz");
    const fromPairs = await platform.authorize({ headers: [["X-A", "1"]] });
    expect(new Headers(fromPairs.headers).get("X-A")).toBe("1");
    expect(new Headers(fromPairs.headers).get("Authorization")).toBe("Bearer tok-xyz");
    expect(new Headers((await platform.authorize({})).headers).get("Authorization")).toBe("Bearer tok-xyz");
  });

  it("トークンが無ければ Authorization を付けない (credentials は omit)", async () => {
    const out = await platform.authorize({ headers: { Accept: "application/json" } });
    expect(new Headers(out.headers).has("Authorization")).toBe(false);
    expect(out.credentials).toBe("omit");
  });

  it("キーチェーンは最初の 1 回だけ読み、clearSession のあとはトークンを付けない", async () => {
    keychain.set("session", "tok-xyz");
    await platform.authorize({});
    await platform.authorize({});
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "get_secret")).toHaveLength(1);
    await platform.clearSession();
    expect(keychain.has("session")).toBe(false);
    expect(new Headers((await platform.authorize({})).headers).has("Authorization")).toBe(false);
  });

  it("ログインが済んだ直後から、そのトークンを付ける", async () => {
    expect(new Headers((await platform.authorize({})).headers).has("Authorization")).toBe(false);
    const state = await startLogin();
    deepLink(callbackUrl("c", state));
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(new Headers((await platform.authorize({})).headers).get("Authorization")).toBe("Bearer tok-1");
  });
});

describe("setServerOrigin", () => {
  it("URL を検めてオリジンで保存し、キーチェーンのセッションと、始めたログインの記録を消す", async () => {
    keychain.set("session", "tok-old");
    await startLogin();
    await platform.setServerOrigin!(" https://other.example.com/ ");
    expect(localStorage.getItem("untie.serverOrigin")).toBe("https://other.example.com");
    expect(platform.serverOrigin()).toBe("https://other.example.com");
    expect(keychain.has("session")).toBe(false);
    expect(sessionStorage.getItem("untie.desktopLogin")).toBeNull();
    // 古いトークンを新しいサーバーに送らない
    expect(new Headers((await platform.authorize({})).headers).has("Authorization")).toBe(false);
  });

  it("不正な URL は拒み、保存済みの URL もセッションもそのまま", async () => {
    keychain.set("session", "tok-old");
    for (const bad of [
      "",
      "untie.example.com",
      "ftp://untie.example.com",
      "javascript:alert(1)",
      "not a url",
      "https://user:pass@untie.example.com",
      // パス・クエリ・ハッシュ付きは拒む
      "https://other.example.com/some/path",
      "https://other.example.com/?x=1",
      "https://other.example.com/#top",
      // http は localhost / 127.0.0.1 だけ
      "http://other.example.com",
      "http://192.168.1.5:8787",
    ]) {
      await expect(platform.setServerOrigin!(bad), bad).rejects.toThrow("サーバーの URL");
    }
    expect(localStorage.getItem("untie.serverOrigin")).toBe(ORIGIN);
    expect(keychain.get("session")).toBe("tok-old");
  });

  it("http://localhost・http://127.0.0.1 は受ける (開発用)", async () => {
    await platform.setServerOrigin!("http://localhost:8787/");
    expect(platform.serverOrigin()).toBe("http://localhost:8787");
    await platform.setServerOrigin!("http://127.0.0.1:8787");
    expect(platform.serverOrigin()).toBe("http://127.0.0.1:8787");
  });

  it("キーチェーンのセッションを消せなければ、URL も変えない", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("キーチェーンから消せませんでした"));
    await expect(platform.setServerOrigin!("https://other.example.com")).rejects.toThrow("キーチェーンから消せませんでした");
    expect(localStorage.getItem("untie.serverOrigin")).toBe(ORIGIN);
  });
});
