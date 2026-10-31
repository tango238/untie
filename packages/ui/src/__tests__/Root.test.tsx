import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Root from "../Root";
import { useSessionStore } from "../cloud/session";
import { navigate } from "../router";
import { memory } from "../test/platform";
import { fakeServer, type FakeServer } from "../test/server";
import { resetStore } from "../test/utils";
import { useUntieStore } from "../store";
import { createHotelSample } from "@untie/core/sample";

// エディタ本体 (キャンバスが ResizeObserver を使う) は jsdom で描けないので、ツールバーだけの代役にする
vi.mock("../App", async () => {
  const { Toolbar } = await import("../components/Toolbar");
  return { default: () => <Toolbar /> };
});

let server: FakeServer;
beforeEach(() => {
  resetStore();
  window.location.hash = "";
  useSessionStore.setState({ status: "unknown", user: null, providers: [], hasServer: false, error: null });
  server = fakeServer({ signedIn: false, providers: ["dev"] });
});
afterEach(() => server.restore());

describe("Root", () => {
  it("ハッシュが無ければホームを出し、起動時にログインの状態を確かめる", async () => {
    render(<Root />);
    expect(screen.getByRole("heading", { level: 1, name: "Untie" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "ローカル" })).toBeTruthy();
    await screen.findByRole("button", { name: "開発用ログイン (メールを入れるだけ)" });
    expect(useSessionStore.getState().status).toBe("anonymous");
  });

  it("#/local ではエディタ、#/f/<id> ではクラウドファイルの読み込み、#/invite/<t> は招待を受ける画面、#/link/<t> はリンクで開く", async () => {
    render(<Root />);
    act(() => navigate({ name: "local" }));
    expect(screen.getByRole("button", { name: "ホーム" })).toBeTruthy();

    act(() => navigate({ name: "file", fileId: "abc" }));
    expect(screen.getByText("読み込み中…")).toBeTruthy();
    act(() => navigate({ name: "home" }));
    expect(screen.getByRole("region", { name: "ローカル" })).toBeTruthy();

    act(() => navigate({ name: "invite", token: "t" }));
    expect(screen.getByRole("region", { name: "招待" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "ローカル" })).toBeNull();
    act(() => navigate({ name: "link", token: "t" }));
    expect(screen.getByText("読み込み中…")).toBeTruthy();
    // 無効なリンクならホームへ戻る
    await waitFor(() => expect(screen.getByRole("region", { name: "ローカル" })).toBeTruthy());
  });

  it("ログインから戻った #/invite は、預けたトークンの招待を受ける画面に直す", async () => {
    window.location.hash = "#/invite";
    sessionStorage.setItem("untie.pendingInvite", "tok");
    render(<Root />);
    expect(window.location.hash).toBe("#/invite/tok");
    expect(screen.getByRole("region", { name: "招待" })).toBeTruthy();
    expect(sessionStorage.getItem("untie.pendingInvite")).toBeNull();
  });

  it("ホームで「サンプルを開く」を押すとエディタに移り、ツールバーの「ホーム」で戻れる", async () => {
    render(<Root />);
    screen.getByRole("button", { name: "サンプルを開く" }).click();
    await waitFor(() => expect(screen.getByRole("button", { name: "ホーム" })).toBeTruthy());
    expect(window.location.hash).toBe("#/local");
    screen.getByRole("button", { name: "ホーム" }).click();
    await waitFor(() => expect(screen.getByRole("region", { name: "ローカル" })).toBeTruthy());
  });

  it("閉じる前の確認は、ホームに出ている間も登録される (未保存の変更があれば止める)", async () => {
    const { unmount } = render(<Root />);
    expect(memory().closeGuards.size).toBe(1);
    const [guard] = [...memory().closeGuards];
    expect(guard!()).toBe(false);
    // ローカルの編集が裏に残っていれば、ホームでも「変更あり」と答える
    useUntieStore.setState({ savedModel: createHotelSample() });
    expect(guard!()).toBe(true);
    act(() => navigate({ name: "local" }));
    expect(memory().closeGuards.size).toBe(1);
    unmount();
    expect(memory().closeGuards.size).toBe(0);
  });

  it("サーバー未設定ならその旨を出す", async () => {
    memory().origin = "";
    render(<Root />);
    await screen.findByText("サーバーが設定されていないため、クラウドの機能は使えません");
  });
});
