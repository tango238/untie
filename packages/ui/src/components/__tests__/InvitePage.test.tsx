import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFilesStore } from "../../cloud/files";
import { useSessionStore } from "../../cloud/session";
import { currentRoute } from "../../router";
import { useUntieStore } from "../../store";
import { memory } from "../../test/platform";
import { apiError, fakeServer, summary, user, type FakeInvitation, type FakeServer } from "../../test/server";
import { resetStore } from "../../test/utils";
import { InvitePage } from "../InvitePage";

let server: FakeServer;

const invitation = (overrides: Partial<FakeInvitation> = {}): FakeInvitation => ({
  fileId: "f9",
  fileName: "経理",
  email: user.email,
  role: "editor",
  inviterName: "山田",
  expiresAt: Date.now() + 86_400_000,
  ...overrides,
});
const signedIn = () => useSessionStore.setState({ status: "signedIn", user, providers: ["dev"], hasServer: true, error: null });

beforeEach(() => {
  resetStore();
  window.location.hash = "#/invite/tok";
  useFilesStore.getState().reset();
  useSessionStore.setState({ status: "unknown", user: null, providers: ["dev"], hasServer: true, error: null });
  server = fakeServer();
  server.inviteTokens.tok = invitation();
});
afterEach(() => server.restore());

describe("InvitePage", () => {
  it("ログインの状態が分かるまでは「確認中」。招待は取りにいかない", () => {
    render(<InvitePage token="tok" />);
    expect(screen.getByText("確認中…")).toBeTruthy();
    expect(server.calls.filter((c) => c.path.startsWith("/api/invitations"))).toHaveLength(0);
  });

  it("未ログインならログイン欄を出し、ログインのあとこの招待へ戻る (戻り先にトークンは載せない)", () => {
    sessionStorage.clear();
    useSessionStore.setState({ status: "anonymous", user: null });
    render(<InvitePage token="tok" />);
    expect(screen.getByText(/招待を受けるにはログインしてください/)).toBeTruthy();
    expect(server.calls.filter((c) => c.path.startsWith("/api/invitations"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "開発用ログイン (メールを入れるだけ)" }));
    expect(memory().logins).toEqual([{ provider: "dev", returnTo: "#/invite" }]);
    expect(sessionStorage.getItem("untie.pendingInvite")).toBe("tok");
  });

  it("ログイン済みなら招待の中身を出す。トークンは X-Untie-Token ヘッダーで送り、パスには載せない", async () => {
    signedIn();
    render(<InvitePage token="tok" />);
    await screen.findByText("山田さんから「経理」に編集者として招待されています。");
    const get = server.calls.find((c) => c.path === "/api/invitations/info")!;
    expect(get.headers["X-Untie-Token"]).toBe("tok");
    expect(get.path).not.toContain("tok");
    // ログインしただけでは受けない
    expect(server.calls.filter((c) => c.path === "/api/invitations/accept")).toHaveLength(0);
  });

  it("「受ける」で accept して、そのファイルのルートへ移る", async () => {
    signedIn();
    render(<InvitePage token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "受ける" }));
    await waitFor(() => expect(currentRoute()).toEqual({ name: "file", fileId: "f9" }));
    const accept = server.calls.find((c) => c.path === "/api/invitations/accept")!;
    expect(accept.method).toBe("POST");
    expect(accept.headers["X-Untie-Token"]).toBe("tok");
    // 共有されたファイルの一覧も更新される
    await waitFor(() => expect(useFilesStore.getState().shared.map((f) => f.id)).toContain("f9"));
  });

  it("「やめる」で何も受けずにホームへ戻る", async () => {
    signedIn();
    render(<InvitePage token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "やめる" }));
    expect(currentRoute()).toEqual({ name: "home" });
    expect(server.calls.filter((c) => c.path === "/api/invitations/accept")).toHaveLength(0);
  });

  it("期限切れ (expired) は「この招待は期限切れです」で、受けるボタンは出ない", async () => {
    server.inviteTokens.tok = invitation({ expiresAt: Date.now() - 1000 });
    signedIn();
    render(<InvitePage token="tok" />);
    await screen.findByText("この招待は期限切れです");
    expect(screen.queryByRole("button", { name: "受ける" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ホームへ" }));
    expect(currentRoute()).toEqual({ name: "home" });
  });

  it("受けるときに 410 (期限切れ) なら、期限切れの画面にする", async () => {
    signedIn();
    server.overrides["POST /api/invitations/accept"] = () => apiError(410, "invitation_expired", "招待の期限が切れています");
    render(<InvitePage token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "受ける" }));
    await screen.findByText("この招待は期限切れです");
    expect(currentRoute()).not.toEqual({ name: "file", fileId: "f9" });
  });

  it("受けたあとに外された人の古い招待は、info は読めるが、受けると 410 invitation_used で使用済みと出す", async () => {
    server.inviteTokens.tok = invitation({ accepted: true });
    signedIn();
    render(<InvitePage token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "受ける" }));
    await screen.findByText("この招待はすでに使われています");
    expect(currentRoute()).not.toEqual({ name: "file", fileId: "f9" });
  });

  it("受け終わった招待をまだメンバーのまま受け直しても、同じ結果 (冪等) でファイルへ移る", async () => {
    server.inviteTokens.tok = invitation({ accepted: true });
    server.shared = [summary({ id: "f9", name: "経理", role: "editor", ownerId: "u9", ownerName: "山田" })];
    signedIn();
    render(<InvitePage token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "受ける" }));
    await waitFor(() => expect(currentRoute()).toEqual({ name: "file", fileId: "f9" }));
  });

  it("受けたあとの遷移は履歴に積まない (戻るで招待の画面へ戻らない)", async () => {
    signedIn();
    const before = window.history.length;
    render(<InvitePage token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "受ける" }));
    await waitFor(() => expect(currentRoute()).toEqual({ name: "file", fileId: "f9" }));
    expect(window.history.length).toBe(before);
  });

  it("別のメールアドレス宛なら、いまのログインのメールを添えて知らせる", async () => {
    server.inviteTokens.tok = invitation({ email: "other@example.com" });
    signedIn();
    render(<InvitePage token="tok" />);
    await screen.findByText("この招待は別のメールアドレス宛です (いまのログイン: me@example.com)");
    expect(screen.queryByRole("button", { name: "受ける" })).toBeNull();
    // 別のアカウントでログインし直せる: ログアウトすると、この招待に戻るログイン欄になる
    fireEvent.click(screen.getByRole("button", { name: "別のアカウントでログインし直す" }));
    await screen.findByText(/招待を受けるにはログインしてください/);
    expect(useSessionStore.getState().status).toBe("anonymous");
  });

  it("期限切れ・見つからないときは「別のアカウントで」のボタンを出さない", async () => {
    signedIn();
    render(<InvitePage token="nothing" />);
    await screen.findByText("この招待は見つかりません");
    expect(screen.queryByRole("button", { name: "別のアカウントでログインし直す" })).toBeNull();
  });

  it("見つからない招待は「この招待は見つかりません」", async () => {
    signedIn();
    render(<InvitePage token="nothing" />);
    await screen.findByText("この招待は見つかりません");
  });

  it("受けるときのその他の失敗はトーストに出し、押し直せる。二重に押しても 1 回しか送らない", async () => {
    signedIn();
    let calls = 0;
    server.overrides["POST /api/invitations/accept"] = () => {
      calls++;
      return apiError(500, "internal", "サーバーで問題が起きました");
    };
    render(<InvitePage token="tok" />);
    const accept = await screen.findByRole("button", { name: "受ける" });
    fireEvent.click(accept);
    fireEvent.click(accept);
    await waitFor(() => expect(useUntieStore.getState().toasts.map((t) => t.message)).toContain("サーバーで問題が起きました"));
    expect(calls).toBe(1);
    expect((screen.getByRole("button", { name: "受ける" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("使っている途中でログインが切れたら、ログイン欄へ戻る", async () => {
    signedIn();
    render(<InvitePage token="tok" />);
    await screen.findByRole("button", { name: "受ける" });
    act(() => useSessionStore.setState({ status: "anonymous", user: null }));
    expect(screen.getByText(/招待を受けるにはログインしてください/)).toBeTruthy();
  });
});
