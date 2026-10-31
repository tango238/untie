import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memory } from "../../test/platform";
import { apiError, fakeServer, summary, type FakeServer, user } from "../../test/server";
import { useFilesStore } from "../files";
import { useUntieStore } from "../../store";
import { listenForPlatformLogin, useSessionStore } from "../session";

let server: FakeServer;
const initial = { status: "unknown" as const, user: null, providers: [], hasServer: false, error: null };

beforeEach(() => {
  useSessionStore.setState(initial);
  useUntieStore.setState({ toasts: [] });
  server = fakeServer({ providers: ["google", "dev"] });
});
afterEach(() => server.restore());

describe("session.load", () => {
  it("サーバー未設定なら API を呼ばずに anonymous で providers は空", async () => {
    memory().origin = "";
    await useSessionStore.getState().load();
    const s = useSessionStore.getState();
    expect(s.status).toBe("anonymous");
    expect(s.hasServer).toBe(false);
    expect(s.providers).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });

  it("ログイン済みなら signedIn。ユーザーと providers を持つ", async () => {
    await useSessionStore.getState().load();
    const s = useSessionStore.getState();
    expect(s.status).toBe("signedIn");
    expect(s.user).toEqual(user);
    expect(s.providers).toEqual(["google", "dev"]);
    expect(s.hasServer).toBe(true);
    expect(server.calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(["GET /api/me", "GET /auth/providers"]);
  });

  it("401 は anonymous (失敗ではないので error は空)", async () => {
    server.signedIn = false;
    await useSessionStore.getState().load();
    const s = useSessionStore.getState();
    expect(s.status).toBe("anonymous");
    expect(s.user).toBeNull();
    expect(s.providers).toEqual(["google", "dev"]);
    expect(s.error).toBeNull();
  });

  it("ネットワークエラーは error に入れて anonymous", async () => {
    server.overrides["GET /api/me"] = () => {
      throw new TypeError("Failed to fetch");
    };
    await useSessionStore.getState().load();
    const s = useSessionStore.getState();
    expect(s.status).toBe("anonymous");
    expect(s.error).toContain("サーバーにつながりません");
  });

  it("サーバーが 500 を返したときも error に入れる", async () => {
    server.overrides["GET /api/me"] = () => apiError(500, "internal", "サーバーでエラーが起きました");
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().status).toBe("anonymous");
    expect(useSessionStore.getState().error).toBe("サーバーでエラーが起きました");
  });

  it("authorize を通したリクエストを出す (Cookie と CSRF 用のヘッダー)", async () => {
    memory().authorize = async (init) => ({ ...init, headers: { ...(init.headers as Record<string, string>), Authorization: "Bearer t" } });
    await useSessionStore.getState().load();
    expect(server.calls.every((c) => c.headers.Authorization === "Bearer t")).toBe(true);
  });
});

describe("session.load の重なりと失敗", () => {
  it("実行中に重ねて呼んでも 1 回だけ叩く", async () => {
    const a = useSessionStore.getState().load();
    const b = useSessionStore.getState().load();
    await Promise.all([a, b]);
    expect(server.calls.filter((c) => c.path === "/api/me")).toHaveLength(1);
    expect(server.calls.filter((c) => c.path === "/auth/providers")).toHaveLength(1);
    // 終わったあとの呼び出しは、もう一度叩く
    await useSessionStore.getState().load();
    expect(server.calls.filter((c) => c.path === "/api/me")).toHaveLength(2);
  });

  it("providers を取れなかったら、未ログインでは「ログイン方法を取得できませんでした」を error にする", async () => {
    server.signedIn = false;
    server.overrides["GET /auth/providers"] = () => apiError(500, "internal", "x");
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().status).toBe("anonymous");
    expect(useSessionStore.getState().error).toBe("ログイン方法を取得できませんでした");
  });

  it("providers を取れなくても、ログイン済みなら signedIn で error は空", async () => {
    server.overrides["GET /auth/providers"] = () => apiError(500, "internal", "x");
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().status).toBe("signedIn");
    expect(useSessionStore.getState().error).toBeNull();
  });
});

describe("401 (セッション切れ)", () => {
  it("使っている途中で 401 を受けたら anonymous に戻し、一覧を空にして知らせる", async () => {
    server.mine = [summary({ id: "a", name: "A" })];
    await useSessionStore.getState().load();
    await useFilesStore.getState().refresh();
    expect(useFilesStore.getState().mine).toHaveLength(1);

    server.signedIn = false;
    server.unauthorizedCode = "session_expired";
    await useFilesStore.getState().rename("a", "x");
    expect(useSessionStore.getState().status).toBe("anonymous");
    expect(useSessionStore.getState().user).toBeNull();
    expect(useFilesStore.getState().mine).toEqual([]);
    const messages = useUntieStore.getState().toasts.map((t) => t.message);
    expect(messages).toContain("ログインの有効期限が切れました。もう一度ログインしてください");
  });

  it("logout は 401 を成功とみなして手元の状態を消す (トーストは出さない)", async () => {
    await useSessionStore.getState().load();
    server.signedIn = false;
    server.overrides["POST /auth/logout"] = () => apiError(401, "session_expired", "ログインの有効期限が切れました");
    await useSessionStore.getState().logout();
    expect(useSessionStore.getState().status).toBe("anonymous");
    expect(useUntieStore.getState().toasts).toEqual([]);
  });

  it("logoutAll は 401 を成功とみなす", async () => {
    await useSessionStore.getState().load();
    server.signedIn = false;
    await useSessionStore.getState().logoutAll();
    expect(useSessionStore.getState().status).toBe("anonymous");
    expect(useUntieStore.getState().toasts).toEqual([]);
  });
});

describe("login / logout", () => {
  it("login は Platform に provider と戻り先を渡す", async () => {
    window.location.hash = "#/local";
    await useSessionStore.getState().login("dev");
    expect(memory().logins).toEqual([{ provider: "dev", returnTo: "#/local" }]);
    window.location.hash = "";
    await useSessionStore.getState().login("google");
    expect(memory().logins[1]).toEqual({ provider: "google", returnTo: "#/" });
  });

  it("招待・リンクのトークンはログインの戻り先 (URL に載る) に含めず、sessionStorage に預ける", async () => {
    sessionStorage.clear();
    await useSessionStore.getState().login("dev", "#/invite/tok-invite");
    window.location.hash = "#/link/tok-link";
    await useSessionStore.getState().login("dev");
    expect(memory().logins).toEqual([
      { provider: "dev", returnTo: "#/invite" },
      { provider: "dev", returnTo: "#/link" },
    ]);
    expect(JSON.stringify(memory().logins)).not.toContain("tok-");
    expect(sessionStorage.getItem("untie.pendingInvite")).toBe("tok-invite");
    expect(sessionStorage.getItem("untie.pendingLink")).toBe("tok-link");
    sessionStorage.clear();
    window.location.hash = "";
  });

  it("Platform の login が失敗したらトーストに出す", async () => {
    memory().login = async () => {
      throw new Error("デスクトップ版のログインは次の段階で対応します");
    };
    await useSessionStore.getState().login("google");
    expect(useUntieStore.getState().toasts.map((t) => t.message)).toEqual(["デスクトップ版のログインは次の段階で対応します"]);
  });

  it("logout は POST /auth/logout を呼び、anonymous に戻る", async () => {
    await useSessionStore.getState().load();
    await useSessionStore.getState().logout();
    expect(server.calls.some((c) => c.method === "POST" && c.path === "/auth/logout")).toBe(true);
    expect(server.calls.find((c) => c.path === "/auth/logout")!.headers["X-Requested-With"]).toBe("untie");
    expect(useSessionStore.getState().status).toBe("anonymous");
    expect(useSessionStore.getState().user).toBeNull();
  });

  it("logoutAll は POST /auth/logout-all を呼ぶ。失敗したらトーストを出してログイン中のまま", async () => {
    await useSessionStore.getState().load();
    server.overrides["POST /auth/logout-all"] = () => apiError(500, "internal", "ログアウトできませんでした");
    await useSessionStore.getState().logoutAll();
    expect(useSessionStore.getState().status).toBe("signedIn");
    expect(useUntieStore.getState().toasts.slice(-1)[0]?.message).toBe("ログアウトできませんでした");
    delete server.overrides["POST /auth/logout-all"];
    await useSessionStore.getState().logoutAll();
    expect(useSessionStore.getState().status).toBe("anonymous");
  });
});

describe("デスクトップ: 手元のセッションとサーバーの設定", () => {
  it("logout / logoutAll のあと Platform の clearSession を呼ぶ。失敗してログイン中のままなら呼ばない", async () => {
    await useSessionStore.getState().load();
    server.overrides["POST /auth/logout"] = () => apiError(500, "internal", "ログアウトできませんでした");
    await useSessionStore.getState().logout();
    expect(memory().clearedSessions).toBe(0);
    delete server.overrides["POST /auth/logout"];
    await useSessionStore.getState().logout();
    expect(memory().clearedSessions).toBe(1);
    await useSessionStore.getState().load();
    await useSessionStore.getState().logoutAll();
    expect(memory().clearedSessions).toBe(2);
  });

  it("サーバー側ですでに消えていた (401) ログアウトでも、手元のセッションは消す", async () => {
    await useSessionStore.getState().load();
    server.signedIn = false;
    await useSessionStore.getState().logout();
    expect(memory().clearedSessions).toBe(1);
  });

  it("clearSession が失敗しても画面はログアウトし、理由をトーストに出す", async () => {
    await useSessionStore.getState().load();
    memory().clearSession = async () => {
      throw new Error("キーチェーンから消せませんでした");
    };
    await useSessionStore.getState().logout();
    expect(useSessionStore.getState().status).toBe("anonymous");
    expect(useUntieStore.getState().toasts.map((t) => t.message).join()).toContain("キーチェーンから消せませんでした");
  });

  it("使っている途中で 401 を受けたら (セッション切れ)、効かなくなったトークンを手元から消す", async () => {
    await useSessionStore.getState().load();
    server.signedIn = false;
    await useFilesStore.getState().rename("a", "x");
    await new Promise((r) => setTimeout(r, 0));
    expect(memory().clearedSessions).toBe(1);
  });

  it("login は始められたら true、Platform が失敗したら false", async () => {
    expect(await useSessionStore.getState().login("google")).toBe(true);
    memory().login = async () => {
      throw new Error("サーバーが設定されていません");
    };
    expect(await useSessionStore.getState().login("google")).toBe(false);
  });

  it("setServer は Platform に URL を渡し、状態を作り直す (新しいサーバーに聞く)", async () => {
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().status).toBe("signedIn");
    server.signedIn = false;
    await useSessionStore.getState().setServer("https://other.test/");
    expect(memory().serverSets).toEqual(["https://other.test/"]);
    expect(memory().origin).toBe("https://other.test");
    const s = useSessionStore.getState();
    expect(s.status).toBe("anonymous");
    expect(s.user).toBeNull();
    expect(s.hasServer).toBe(true);
  });

  it("setServer: 不正な URL は Error を投げ、いまの状態は変えない", async () => {
    await useSessionStore.getState().load();
    await expect(useSessionStore.getState().setServer("untie.example.com")).rejects.toThrow("http:// か https://");
    expect(useSessionStore.getState().status).toBe("signedIn");
    expect(memory().origin).toBe("http://test");
  });

  it("setServer: オリジンが変わらなければ何もしない (ログアウトも通信もしない)", async () => {
    memory().origin = "https://same.test";
    await useSessionStore.getState().load();
    server.calls.length = 0;
    await useSessionStore.getState().setServer("https://same.test");
    await useSessionStore.getState().setServer(" https://same.test/ ");
    expect(memory().serverSets).toEqual([]);
    expect(server.calls).toEqual([]);
    expect(useSessionStore.getState().status).toBe("signedIn");
  });

  it("setServer: ログイン中なら、先にいまのサーバーでログアウトを試す。失敗しても進める", async () => {
    await useSessionStore.getState().load();
    server.calls.length = 0;
    await useSessionStore.getState().setServer("https://other.test");
    expect(server.calls[0]).toMatchObject({ method: "POST", path: "/auth/logout" });
    expect(memory().serverSets).toEqual(["https://other.test"]);
    // ログアウトが失敗しても (トーストも出さず) サーバーは変わる
    memory().origin = "http://test";
    useSessionStore.setState({ status: "signedIn", user, hasServer: true });
    server.overrides["POST /auth/logout"] = () => apiError(500, "internal", "ログアウトできませんでした");
    await useSessionStore.getState().setServer("https://third.test");
    expect(memory().serverSets).toEqual(["https://other.test", "https://third.test"]);
    expect(useUntieStore.getState().toasts).toEqual([]);
  });

  it("setServer: 不正な URL なら、ログアウトもしない", async () => {
    await useSessionStore.getState().load();
    server.calls.length = 0;
    for (const bad of ["untie.example.com", "http://example.com", "https://example.com/path"]) {
      await expect(useSessionStore.getState().setServer(bad)).rejects.toThrow();
    }
    expect(server.calls).toEqual([]);
    expect(useSessionStore.getState().status).toBe("signedIn");
  });

  it("デスクトップは、サーバーにつながらなくても、ログアウトで手元のトークンを消す(Web は消さない)", async () => {
    await useSessionStore.getState().load();
    server.overrides["POST /auth/logout"] = () => {
      throw new TypeError("Failed to fetch");
    };
    await useSessionStore.getState().logout();
    // Web: つながらないので、ログイン中のまま
    expect(useSessionStore.getState().status).toBe("signedIn");
    expect(memory().clearedSessions).toBe(0);
    memory().kind = "desktop";
    await useSessionStore.getState().logout();
    expect(memory().clearedSessions).toBe(1);
    expect(useUntieStore.getState().toasts.map((t) => t.message)).toContain("サーバーにつながらないため、この端末のログイン情報だけ消しました");
    delete server.overrides["POST /auth/logout"];
    server.signedIn = false;
  });

  it("listenForPlatformLogin: ログインが終わったら読み直し、戻り先の預かりトークンで画面を直す", async () => {
    server.signedIn = false;
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().status).toBe("anonymous");
    sessionStorage.setItem("untie.pendingInvite", "tok-invite");
    window.location.hash = "#/invite";
    const off = listenForPlatformLogin();
    server.signedIn = true;
    memory().emitLoggedIn({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().status).toBe("signedIn");
    expect(window.location.hash).toBe("#/invite/tok-invite");
    off();
    expect(memory().loginListeners.size).toBe(0);
    window.location.hash = "";
  });

  it("listenForPlatformLogin: 失敗はトーストで知らせ、状態は読み直さない", async () => {
    const off = listenForPlatformLogin();
    memory().emitLoggedIn({ ok: false, message: "引換コードの期限が切れました" });
    expect(useUntieStore.getState().toasts.map((t) => t.message)).toEqual(["引換コードの期限が切れました"]);
    expect(server.calls).toHaveLength(0);
    off();
  });
});
