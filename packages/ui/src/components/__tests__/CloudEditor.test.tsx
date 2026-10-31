import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ApiError, type Role } from "@untie/api";
import { createHotelSample } from "@untie/core/sample";
import { useAgentStore } from "../../ai/agentStore";
import { useSessionStore } from "../../cloud/session";
import { currentRoute, navigate } from "../../router";
import { useUntieStore } from "../../store";
import { memory } from "../../test/platform";
import { fakeServer, summary, user, type FakeServer } from "../../test/server";
import { resetStore } from "../../test/utils";
import { CloudEditor } from "../CloudEditor";

// 接続そのもの (collab.ts) と、エディタ本体 (キャンバスが ResizeObserver を使う) は代役にする
const { openCloudFile, closeCloudFile } = vi.hoisted(() => ({
  openCloudFile: vi.fn<(fileId: string, options?: { link?: string }) => Promise<void>>(),
  closeCloudFile: vi.fn<() => void>(),
}));
vi.mock("../../cloud/collab", () => ({ openCloudFile, closeCloudFile }));
vi.mock("../../App", () => ({ default: () => <div>エディタ</div> }));

const st = () => useUntieStore.getState();
const toasts = () => st().toasts.map((t) => t.message);

/** 読み込めた状態にする (collab.ts がやること) */
function loadCloud(fileId = "f1", status: "loading" | "connected" = "connected", role: Role = "editor", link?: string) {
  act(() => {
    st().loadCloudDocument(createHotelSample(), { fileId, role, doc: new Y.Doc(), status, link });
  });
}

beforeEach(() => {
  resetStore();
  openCloudFile.mockReset();
  closeCloudFile.mockReset();
  openCloudFile.mockResolvedValue(undefined);
  useSessionStore.setState({ status: "signedIn", user, providers: [], hasServer: true, error: null });
  window.location.hash = "#/f/f1";
});
afterEach(() => {
  act(() => st().closeCloud());
  useAgentStore.setState({ running: false });
});

describe("CloudEditor", () => {
  it("マウントで openCloudFile、アンマウントで closeCloudFile を呼ぶ。読み込み中は「読み込み中…」を出す", async () => {
    const { unmount } = render(<CloudEditor fileId="f1" />);
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledWith("f1"));
    expect(screen.getByText("読み込み中…")).toBeTruthy();
    expect(screen.queryByText("エディタ")).toBeNull();
    expect(closeCloudFile).not.toHaveBeenCalled();
    unmount();
    expect(closeCloudFile).toHaveBeenCalled();
  });

  it("最初の同期が済むまでは、cloud があってもエディタを出さない", () => {
    render(<CloudEditor fileId="f1" />);
    loadCloud("f1", "loading");
    expect(screen.getByText("読み込み中…")).toBeTruthy();
    act(() => st().setCloudStatus("connected"));
    expect(screen.getByText("エディタ")).toBeTruthy();
  });

  it("別のファイルが開いている間は、エディタを出さない", () => {
    render(<CloudEditor fileId="f1" />);
    loadCloud("other");
    expect(screen.queryByText("エディタ")).toBeNull();
  });

  it("ログインの状態が分かるまでは待ち、分かってから開く", async () => {
    useSessionStore.setState({ status: "unknown" });
    render(<CloudEditor fileId="f1" />);
    expect(openCloudFile).not.toHaveBeenCalled();
    expect(screen.getByText("読み込み中…")).toBeTruthy();
    act(() => useSessionStore.setState({ status: "signedIn" }));
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledWith("f1"));
  });

  it("ログインしていなければ、開かずにホームへ戻してログインを促す", () => {
    useSessionStore.setState({ status: "anonymous", user: null });
    render(<CloudEditor fileId="f1" />);
    expect(openCloudFile).not.toHaveBeenCalled();
    expect(currentRoute()).toEqual({ name: "home" });
    expect(toasts()).toEqual(["クラウドのファイルを開くにはログインしてください"]);
  });

  it("使っている途中でログインが切れたら、ホームへ戻すだけで「ログインしてください」を重ねて出さない", async () => {
    render(<CloudEditor fileId="f1" />);
    await waitFor(() => expect(openCloudFile).toHaveBeenCalled());
    act(() => useSessionStore.setState({ status: "anonymous", user: null }));
    expect(currentRoute()).toEqual({ name: "home" });
    expect(toasts()).toEqual([]);
  });

  it("保存していないローカルの編集があれば、開く前に確かめる。断られたらローカルの編集へ戻し、開かない", async () => {
    act(() => {
      st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "ローカルの編集" } } }));
    });
    memory().discard = false;
    render(<CloudEditor fileId="f1" />);
    await waitFor(() => expect(currentRoute()).toEqual({ name: "local" }));
    expect(openCloudFile).not.toHaveBeenCalled();
    expect(st().model.meta.name).toBe("ローカルの編集");
  });

  it("確かめて破棄すると決めたら、開く", async () => {
    act(() => {
      st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "ローカルの編集" } } }));
    });
    memory().discard = true;
    render(<CloudEditor fileId="f1" />);
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledWith("f1"));
  });

  it("変更が無ければ確かめずに開く", async () => {
    const confirm = vi.spyOn(memory(), "confirmDiscard");
    render(<CloudEditor fileId="f1" />);
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledWith("f1"));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("チケットが 401 ならホームへ (理由のトーストは session ストアが出す)", async () => {
    openCloudFile.mockRejectedValue(new ApiError(401, "ログインしてください", "unauthenticated"));
    render(<CloudEditor fileId="f1" />);
    await waitFor(() => expect(currentRoute()).toEqual({ name: "home" }));
    expect(toasts()).toEqual([]);
  });

  it.each([
    [403, "このファイルは開けません"],
    [404, "このファイルは開けません"],
    [409, "ゴミ箱の中のファイルです"],
  ])("チケットが %i なら、ホームへ戻して「%s」と出す", async (status, message) => {
    openCloudFile.mockRejectedValue(new ApiError(status, "サーバーの文言", "x"));
    render(<CloudEditor fileId="f1" />);
    await waitFor(() => expect(currentRoute()).toEqual({ name: "home" }));
    expect(toasts()).toEqual([message]);
  });

  it("それ以外の失敗は、その文言を出してホームへ戻す", async () => {
    openCloudFile.mockRejectedValue(new ApiError(0, "サーバーにつながりません", "network"));
    render(<CloudEditor fileId="f1" />);
    await waitFor(() => expect(currentRoute()).toEqual({ name: "home" }));
    expect(toasts()).toEqual(["サーバーにつながりません"]);
  });

  it("閉じられた (kick など) ら、理由をトーストに出してホームへ戻す", () => {
    render(<CloudEditor fileId="f1" />);
    loadCloud();
    expect(screen.getByText("エディタ")).toBeTruthy();
    act(() => st().setCloudClosed({ code: 4003, reason: "共有から外されました" }));
    expect(toasts()).toEqual(["共有から外されました"]);
    expect(currentRoute()).toEqual({ name: "home" });
  });

  it("読み込み中の画面からホームへ戻れる", () => {
    render(<CloudEditor fileId="f1" />);
    fireEvent.click(screen.getByRole("button", { name: "ホームへ戻る" }));
    expect(currentRoute()).toEqual({ name: "home" });
  });

  it("長く読み込めないときは、つながっていないことを伝える", () => {
    vi.useFakeTimers();
    try {
      render(<CloudEditor fileId="f1" />);
      expect(screen.queryByText(/つながっていません/)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(screen.getByText(/つながっていません/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("開く先が変わったら閉じてから開き直す。離れるときは AI エージェントを止める", async () => {
    const original = useAgentStore.getState().cancel;
    const cancel = vi.fn();
    useAgentStore.setState({ cancel });
    onTestFinished(() => useAgentStore.setState({ cancel: original }));
    const { rerender, unmount } = render(<CloudEditor fileId="f1" />);
    rerender(<CloudEditor fileId="f2" />);
    expect(closeCloudFile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(openCloudFile).toHaveBeenLastCalledWith("f2"));
    unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
    navigate({ name: "home" });
  });
});

describe("CloudEditor: 役割が変わったとき (4001)", () => {
  it("ホームへは戻さず、新しい役割でその場につなぎ直して、役割が変わったと知らせる", async () => {
    render(<CloudEditor fileId="f1" />);
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledTimes(1));
    loadCloud("f1", "connected", "editor");
    // つなぎ直すと、サーバーが返す新しい役割で開く
    openCloudFile.mockImplementationOnce(async (id) => {
      loadCloud(id, "connected", "viewer");
    });
    act(() => st().setCloudClosed({ code: 4001, reason: "役割が変わりました" }));
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledTimes(2));
    expect(openCloudFile).toHaveBeenLastCalledWith("f1");
    await waitFor(() => expect(toasts()).toEqual(["役割が閲覧者に変わりました"]));
    // 落ち着いたあとも、つなぎ直しは 1 回だけ (開き直しがまた 4001 を呼ぶ・effect が走り直す、などで増えない)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(openCloudFile).toHaveBeenCalledTimes(2);
    expect(toasts()).toEqual(["役割が閲覧者に変わりました"]);
    expect(currentRoute()).toEqual({ name: "file", fileId: "f1" });
    expect(st().cloud?.role).toBe("viewer");
    expect(st().cloud?.closed).toBeUndefined();
  });

  it("つなぎ直しに失敗したら (外された、など) ホームへ戻して理由を出す", async () => {
    render(<CloudEditor fileId="f1" />);
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledTimes(1));
    loadCloud();
    openCloudFile.mockRejectedValueOnce(new ApiError(404, "ファイルが見つかりません", "file_not_found"));
    act(() => st().setCloudClosed({ code: 4001, reason: "役割が変わりました" }));
    await waitFor(() => expect(currentRoute()).toEqual({ name: "home" }));
    expect(toasts()).toEqual(["このファイルは開けません"]);
  });

  it.each([
    [4003, "共有から外されました"],
    [4004, "リンクが無効になりました"],
  ])("%i はこれまでどおり、理由を出してホームへ戻す (つなぎ直さない)", async (code, reason) => {
    render(<CloudEditor fileId="f1" />);
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledTimes(1));
    loadCloud();
    act(() => st().setCloudClosed({ code, reason }));
    expect(toasts()).toEqual([reason]);
    expect(currentRoute()).toEqual({ name: "home" });
    expect(openCloudFile).toHaveBeenCalledTimes(1);
  });
});

describe("CloudEditor: リンクで開く (#/link/<token>)", () => {
  let server: FakeServer;
  beforeEach(() => {
    server = fakeServer({ signedIn: false });
    server.others = [summary({ id: "f1", name: "リンクのファイル", ownerId: "u9", ownerName: "山田" })];
    server.shares.f1 = { members: [], invitations: [], linkToken: "tok" };
    window.location.hash = "#/link/tok";
  });
  afterEach(() => server.restore());

  it("ログインしていなくても開く。links.get でファイルを引き、link を付けて openCloudFile を呼ぶ (ホームへは戻さない)", async () => {
    useSessionStore.setState({ status: "anonymous", user: null });
    render(<CloudEditor link="tok" />);
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledWith("f1", { link: "tok" }));
    expect(toasts()).toEqual([]);
    expect(currentRoute()).toEqual({ name: "link", token: "tok" });
    const info = server.calls.find((c) => c.path === "/api/links/info")!;
    expect(info.headers["X-Untie-Token"]).toBe("tok");
    // 読み込めたらエディタを出す
    expect(screen.getByText("読み込み中…")).toBeTruthy();
    loadCloud("f1", "connected", "guest", "tok");
    expect(screen.getByText("エディタ")).toBeTruthy();
  });

  it("メンバー (所有者を含む) がリンクで開いたら、via: link のままにせず #/f/<id> に置き換えてメンバーとして開く (トークンも URL から消える)", async () => {
    useSessionStore.setState({ status: "signedIn", user });
    server.signedIn = true;
    server.others = [];
    server.mine = [summary({ id: "f1", name: "リンクのファイル", role: "owner" })];
    const before = window.history.length;
    render(<CloudEditor link="tok" />);
    await waitFor(() => expect(currentRoute()).toEqual({ name: "file", fileId: "f1" }));
    expect(window.location.hash).toBe("#/f/f1");
    expect(window.location.hash).not.toContain("tok");
    expect(window.history.length).toBe(before);
    // この画面は link のままでは開かない (あとは Root が #/f/<id> の CloudEditor を出す)
    await act(async () => {});
    expect(openCloudFile).not.toHaveBeenCalled();
  });

  it("ログインの状態が分かるまでは待つ", async () => {
    useSessionStore.setState({ status: "unknown", user: null });
    render(<CloudEditor link="tok" />);
    await act(async () => {});
    expect(server.calls.filter((c) => c.path === "/api/links/info")).toHaveLength(0);
    act(() => useSessionStore.setState({ status: "anonymous" }));
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledWith("f1", { link: "tok" }));
  });

  it("無効なリンク (links.get が 404) は「このリンクは無効です」と出してホームへ。開かない", async () => {
    render(<CloudEditor link="nothing" />);
    await waitFor(() => expect(currentRoute()).toEqual({ name: "home" }));
    expect(toasts()).toEqual(["このリンクは無効です"]);
    expect(openCloudFile).not.toHaveBeenCalled();
  });

  it("チケットが 404 (取る直前に無効にされた) でも同じ", async () => {
    openCloudFile.mockRejectedValue(new ApiError(404, "リンクが見つかりません", "link_not_found"));
    render(<CloudEditor link="tok" />);
    await waitFor(() => expect(currentRoute()).toEqual({ name: "home" }));
    expect(toasts()).toEqual(["このリンクは無効です"]);
  });

  it("リンクの無効化で閉じられた (4004) ら、理由を出してホームへ戻す", async () => {
    render(<CloudEditor link="tok" />);
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledTimes(1));
    loadCloud("f1", "connected", "guest", "tok");
    act(() => st().setCloudClosed({ code: 4004, reason: "リンクが無効になりました" }));
    expect(toasts()).toEqual(["リンクが無効になりました"]);
    expect(currentRoute()).toEqual({ name: "home" });
  });

  it("4001 では link を付けたままつなぎ直す", async () => {
    useSessionStore.setState({ status: "signedIn", user });
    render(<CloudEditor link="tok" />);
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledTimes(1));
    loadCloud("f1", "connected", "guest", "tok");
    openCloudFile.mockImplementationOnce(async (id, options) => {
      loadCloud(id, "connected", "editor", options?.link);
    });
    act(() => st().setCloudClosed({ code: 4001, reason: "役割が変わりました" }));
    await waitFor(() => expect(openCloudFile).toHaveBeenCalledTimes(2));
    expect(openCloudFile).toHaveBeenLastCalledWith("f1", { link: "tok" });
    await waitFor(() => expect(toasts()).toEqual(["役割が編集者に変わりました"]));
    // links.get はつなぎ直しでは引き直さない
    expect(server.calls.filter((c) => c.path === "/api/links/info")).toHaveLength(1);
  });

  it("保存していないローカルの編集があれば、リンクでも開く前に確かめる", async () => {
    act(() => {
      st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "ローカルの編集" } } }));
    });
    memory().discard = false;
    render(<CloudEditor link="tok" />);
    await waitFor(() => expect(currentRoute()).toEqual({ name: "local" }));
    expect(openCloudFile).not.toHaveBeenCalled();
  });
});
