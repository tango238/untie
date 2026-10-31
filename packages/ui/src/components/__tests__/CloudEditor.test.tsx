import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ApiError } from "@untie/api";
import { createHotelSample } from "@untie/core/sample";
import { useAgentStore } from "../../ai/agentStore";
import { useSessionStore } from "../../cloud/session";
import { currentRoute, navigate } from "../../router";
import { useUntieStore } from "../../store";
import { memory } from "../../test/platform";
import { user } from "../../test/server";
import { resetStore } from "../../test/utils";
import { CloudEditor } from "../CloudEditor";

// 接続そのもの (collab.ts) と、エディタ本体 (キャンバスが ResizeObserver を使う) は代役にする
const { openCloudFile, closeCloudFile } = vi.hoisted(() => ({
  openCloudFile: vi.fn<(fileId: string) => Promise<void>>(),
  closeCloudFile: vi.fn<() => void>(),
}));
vi.mock("../../cloud/collab", () => ({ openCloudFile, closeCloudFile }));
vi.mock("../../App", () => ({ default: () => <div>エディタ</div> }));

const st = () => useUntieStore.getState();
const toasts = () => st().toasts.map((t) => t.message);

/** 読み込めた状態にする (collab.ts がやること) */
function loadCloud(fileId = "f1", status: "loading" | "connected" = "connected") {
  act(() => {
    st().loadCloudDocument(createHotelSample(), { fileId, role: "editor", doc: new Y.Doc(), status });
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
