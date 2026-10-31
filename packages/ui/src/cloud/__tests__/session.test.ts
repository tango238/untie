import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memory } from "../../test/platform";
import { apiError, fakeServer, summary, type FakeServer, user } from "../../test/server";
import { useFilesStore } from "../files";
import { useUntieStore } from "../../store";
import { useSessionStore } from "../session";

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
