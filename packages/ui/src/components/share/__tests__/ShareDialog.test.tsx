import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFilesStore } from "../../../cloud/files";
import { useSessionStore } from "../../../cloud/session";
import { useUntieStore } from "../../../store";
import { apiError, fakeServer, member, summary, user, type FakeServer } from "../../../test/server";
import { resetStore } from "../../../test/utils";
import { ShareDialog } from "../ShareDialog";

let server: FakeServer;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

const toasts = () => useUntieStore.getState().toasts.map((t) => t.message);
const calls = (method: string, path: string) => server.calls.filter((c) => c.method === method && c.path === path);

/** 読み込み終わるまで待つ */
async function open(fileId = "f1") {
  render(<ShareDialog fileId={fileId} onClose={onClose} />);
  await screen.findByRole("region", { name: "メンバー" });
}

beforeEach(() => {
  resetStore();
  onClose = vi.fn<() => void>();
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useFilesStore.getState().reset();
  useSessionStore.setState({ status: "signedIn", user, providers: ["dev"], hasServer: true, error: null });
  server = fakeServer({ mine: [summary({ id: "f1", name: "業務", memberCount: 3 })] });
  server.users = [{ id: "u4", email: "d@example.com", name: "佐藤" }];
  server.shares.f1 = {
    members: [member("u1", "テスト太郎", "owner", user.email), member("u2", "田中", "editor", "b@example.com"), member("u3", "鈴木", "viewer", "c@example.com")],
    invitations: [],
    linkToken: null,
  };
});
afterEach(() => server.restore());

describe("ShareDialog: 表示", () => {
  it("role=dialog で、題名に labelledby が付く。メンバーの名前・メール・役割が並び、所有者の役割は固定表示", async () => {
    await open();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "「業務」を共有" }).id).toBe(dialog.getAttribute("aria-labelledby"));
    const members = within(screen.getByRole("region", { name: "メンバー" }));
    expect(members.getByText("b@example.com")).toBeTruthy();
    expect(members.getByText("所有者")).toBeTruthy();
    expect((members.getByLabelText("田中 の役割") as HTMLSelectElement).value).toBe("editor");
    expect((members.getByLabelText("鈴木 の役割") as HTMLSelectElement).value).toBe("viewer");
    // 所有者の行には選択も「外す」も無い
    expect(members.queryByLabelText("テスト太郎 の役割")).toBeNull();
    expect(members.queryByRole("button", { name: "テスト太郎 を外す" })).toBeNull();
    // 「閉じる」にフォーカスが当たる
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "閉じる" }));
  });

  it("所有者でないと開けない (中身を出さず、所有者だけと伝える)", async () => {
    server.mine = [];
    server.shared = [summary({ id: "f1", name: "業務", role: "editor", ownerId: "u2", ownerName: "田中" })];
    render(<ShareDialog fileId="f1" onClose={onClose} />);
    await screen.findByText("共有を設定できるのは所有者だけです。");
    expect(screen.queryByRole("region", { name: "メンバー" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "招待" })).toBeNull();
  });

  it("読み込めなかったら理由を出す", async () => {
    render(<ShareDialog fileId="nothing" onClose={onClose} />);
    await screen.findByText(/共有の設定を読めませんでした: ファイルが見つかりません/);
  });

  it("Escape と「閉じる」で閉じる", async () => {
    await open();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Tab でダイアログの外へ出ない (末尾で先頭へ、先頭で Shift+Tab すると末尾へ)", async () => {
    await open();
    const dialog = screen.getByRole("dialog");
    const focusables = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)")];
    expect(focusables.length).toBeGreaterThan(2);
    focusables[focusables.length - 1]!.focus();
    fireEvent.keyDown(focusables[focusables.length - 1]!, { key: "Tab" });
    expect(document.activeElement).toBe(focusables[0]);
    fireEvent.keyDown(focusables[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });
});

describe("ShareDialog: メンバー", () => {
  it("役割を変えると PUT で送り、取り直してホームの一覧も更新する", async () => {
    await open();
    const before = calls("GET", "/api/files").length;
    fireEvent.change(screen.getByLabelText("田中 の役割"), { target: { value: "viewer" } });
    await waitFor(() => expect(calls("PUT", "/api/files/f1/members/u2")).toHaveLength(1));
    expect(calls("PUT", "/api/files/f1/members/u2")[0]!.body).toEqual({ role: "viewer" });
    await waitFor(() => expect((screen.getByLabelText("田中 の役割") as HTMLSelectElement).value).toBe("viewer"));
    await waitFor(() => expect(calls("GET", "/api/files").length).toBeGreaterThan(before));
  });

  it("「外す」で DELETE して、一覧から消える", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "鈴木 を外す" }));
    await waitFor(() => expect(calls("DELETE", "/api/files/f1/members/u3")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByLabelText("鈴木 の役割")).toBeNull());
    expect(screen.getByLabelText("田中 の役割")).toBeTruthy();
  });

  it("失敗は ApiError の文言をトーストに出し、表示はサーバーの状態に戻る", async () => {
    server.overrides["PUT /api/files/f1/members/u2"] = () => apiError(403, "forbidden", "この操作をする権限がありません");
    await open();
    fireEvent.change(screen.getByLabelText("田中 の役割"), { target: { value: "viewer" } });
    await waitFor(() => expect(toasts()).toContain("この操作をする権限がありません"));
    await waitFor(() => expect((screen.getByLabelText("田中 の役割") as HTMLSelectElement).value).toBe("editor"));
  });

  it("操作中は他の操作を受けず、二重に押しても 1 回しか送らない", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.overrides["DELETE /api/files/f1/members/u3"] = async () => {
      await gate;
      return new Response(null, { status: 204 });
    };
    await open();
    const remove = screen.getByRole("button", { name: "鈴木 を外す" });
    fireEvent.click(remove);
    fireEvent.click(remove);
    await waitFor(() => expect((screen.getByRole("button", { name: "田中 を外す" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "招待" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("DELETE", "/api/files/f1/members/u3")).toHaveLength(1);
    release();
    await waitFor(() => expect((screen.getByRole("button", { name: "田中 を外す" }) as HTMLButtonElement).disabled).toBe(false));
    expect(calls("DELETE", "/api/files/f1/members/u3")).toHaveLength(1);
  });

  it("操作のあとフォーカスが外に落ちても、ダイアログに戻す。「外す」のあとも Escape で閉じられる", async () => {
    await open();
    const remove = screen.getByRole("button", { name: "鈴木 を外す" });
    remove.focus();
    expect(document.activeElement).toBe(remove);
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByLabelText("鈴木 の役割")).toBeNull());
    // 押したボタンは消えたので、フォーカスはダイアログへ
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
    expect(screen.getByRole("dialog").getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("すでにダイアログの中にフォーカスがあれば、動かさない", async () => {
    await open();
    const select = screen.getByLabelText("田中 の役割") as HTMLSelectElement;
    select.focus();
    fireEvent.change(select, { target: { value: "viewer" } });
    await waitFor(() => expect(calls("PUT", "/api/files/f1/members/u2")).toHaveLength(1));
    await waitFor(() => expect((screen.getByLabelText("田中 の役割") as HTMLSelectElement).value).toBe("viewer"));
    expect(document.activeElement).toBe(screen.getByLabelText("田中 の役割"));
  });

  it("譲る相手に選んだ人を外したら、選びを空に戻す", async () => {
    await open();
    const select = screen.getByLabelText("所有者を譲る相手") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "u3" } });
    expect(select.value).toBe("u3");
    fireEvent.click(screen.getByRole("button", { name: "鈴木 を外す" }));
    await waitFor(() => expect(screen.queryByLabelText("鈴木 の役割")).toBeNull());
    expect((screen.getByLabelText("所有者を譲る相手") as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("button", { name: "所有者を譲る…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("取り直しに 2 回目以降で失敗したら、トーストに出す (最初の読み込み失敗とは別)", async () => {
    await open();
    server.overrides["GET /api/files/f1"] = () => apiError(500, "internal", "サーバーで問題が起きました");
    fireEvent.click(screen.getByRole("button", { name: "鈴木 を外す" }));
    await waitFor(() => expect(toasts()).toContain("サーバーで問題が起きました"));
    // 画面は前の状態のまま残る (読み込み失敗の表示には切り替えない)
    expect(screen.getByRole("region", { name: "メンバー" })).toBeTruthy();
    expect(screen.queryByText(/共有の設定を読めませんでした/)).toBeNull();
  });

  it("所有者を譲る: 相手を選んで確認し、取り消せばなにもせず、譲ればダイアログを閉じる", async () => {
    await open();
    const button = screen.getByRole("button", { name: "所有者を譲る…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("所有者を譲る相手"), { target: { value: "u3" } });
    fireEvent.click(button);
    const confirm = screen.getByRole("dialog", { name: "所有者を譲る" });
    expect(confirm.textContent).toContain("鈴木さんに譲ります");
    // 確認の Escape は確認だけを閉じる (共有ダイアログは閉じない)
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "所有者を譲る" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(calls("POST", "/api/files/f1/transfer")).toHaveLength(0);

    fireEvent.click(button);
    fireEvent.click(within(screen.getByRole("dialog", { name: "所有者を譲る" })).getByRole("button", { name: "譲る" }));
    await waitFor(() => expect(calls("POST", "/api/files/f1/transfer")).toHaveLength(1));
    expect(calls("POST", "/api/files/f1/transfer")[0]!.body).toEqual({ userId: "u3" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toasts()).toContain("所有者を鈴木さんに譲りました");
  });
});

describe("ShareDialog: 招待", () => {
  it("すでにユーザーのメールなら、その場でメンバーに加えたと出す", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), { target: { value: "D@Example.com " } });
    fireEvent.change(screen.getByLabelText("招待する役割"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "招待" }));
    await screen.findByText("佐藤さんをメンバーに加えました");
    expect(calls("POST", "/api/files/f1/invitations")[0]!.body).toEqual({ email: "D@Example.com", role: "viewer" });
    // メンバー一覧に増え、入力欄は空になる
    await screen.findByLabelText("佐藤 の役割");
    expect((screen.getByLabelText("招待するメールアドレス") as HTMLInputElement).value).toBe("");
    expect(screen.queryByLabelText("招待リンク")).toBeNull();
  });

  it("すでにメンバーのメールを招待し直すと「〜さんの役割を変えました」。メンバー一覧は 1 回だけ取る", async () => {
    server.users = [{ id: "u2", email: "b@example.com", name: "田中" }];
    await open();
    const gets = () => calls("GET", "/api/files/f1").length;
    const before = gets();
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), { target: { value: "b@example.com" } });
    fireEvent.change(screen.getByLabelText("招待する役割"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "招待" }));
    await screen.findByText("田中さんの役割を変えました");
    expect(gets() - before).toBe(1);
    expect((screen.getByLabelText("田中 の役割") as HTMLSelectElement).value).toBe("viewer");
  });

  it("メンバーに加えた人宛の未承諾の招待は、一覧から消える", async () => {
    server.shares.f1!.invitations = [{ id: "i9", email: "d@example.com", role: "viewer", createdAt: Date.now(), expiresAt: Date.now() + 86_400_000 }];
    await open();
    expect(screen.getByRole("button", { name: "d@example.com の招待を取り消す" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), { target: { value: "d@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "招待" }));
    await screen.findByText("佐藤さんをメンバーに加えました");
    expect(screen.queryByRole("button", { name: "d@example.com の招待を取り消す" })).toBeNull();
  });

  it("まだユーザーでないメールなら招待リンクを出し、「リンクを写す」でクリップボードに写す。未承諾の一覧に載る", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "招待" }));
    const url = (await screen.findByLabelText("招待リンク")) as HTMLInputElement;
    expect(url.value).toMatch(/^http:\/\/test\/#\/invite\/tok-/);
    expect(url.readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "招待リンクを写す" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url.value));
    await waitFor(() => expect(toasts()).toContain("招待リンクを写しました"));
    expect(await screen.findByText("new@example.com")).toBeTruthy();
    expect(screen.getByText(/閲覧者|編集者/, { selector: ".share-sub" }).textContent).toMatch(/^編集者 · 期限 /);
  });

  it("クリップボードに写せなかったら、選んで写すよう伝える", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    await open();
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "招待" }));
    await screen.findByLabelText("招待リンク");
    fireEvent.click(screen.getByRole("button", { name: "招待リンクを写す" }));
    await waitFor(() => expect(toasts().some((t) => t.includes("写せませんでした"))).toBe(true));
  });

  it("未承諾の招待は取り消せる。期限切れは「期限切れ」と出す", async () => {
    server.shares.f1!.invitations = [
      { id: "i1", email: "old@example.com", role: "viewer", createdAt: Date.now() - 20 * 86_400_000, expiresAt: Date.now() - 6 * 86_400_000 },
      { id: "i2", email: "wait@example.com", role: "editor", createdAt: Date.now(), expiresAt: Date.now() + 5 * 86_400_000 },
    ];
    server.inviteTokens.t1 = { fileId: "f1", fileName: "業務", email: "old@example.com", role: "viewer", inviterName: "テスト太郎", expiresAt: 0, invitationId: "i1" };
    await open();
    expect(screen.getByText("閲覧者 · 期限切れ")).toBeTruthy();
    expect(screen.getByText(/^編集者 · 期限 /)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "old@example.com の招待を取り消す" }));
    await waitFor(() => expect(calls("DELETE", "/api/files/f1/invitations/i1")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("old@example.com")).toBeNull());
    expect(screen.getByText("wait@example.com")).toBeTruthy();
  });

  it("メールが空なら送らずに知らせる。自分のメールは 409 の文言をトーストに出す", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "招待" }));
    expect(toasts()).toContain("メールアドレスを入力してください");
    expect(calls("POST", "/api/files/f1/invitations")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), { target: { value: user.email } });
    fireEvent.click(screen.getByRole("button", { name: "招待" }));
    await waitFor(() => expect(toasts()).toContain("自分は所有者です"));
  });
});

describe("ShareDialog: リンクで閲覧", () => {
  const sw = () => screen.getByRole("switch", { name: "リンクを知っている人が閲覧できる" }) as HTMLInputElement;

  it("有効にすると URL を出して写せる。無効にするときは確認してから DELETE する", async () => {
    await open();
    expect(sw().checked).toBe(false);
    fireEvent.click(sw());
    const url = (await screen.findByLabelText("閲覧リンク")) as HTMLInputElement;
    expect(url.value).toMatch(/^http:\/\/test\/#\/link\/link-/);
    expect(calls("PUT", "/api/files/f1/link")[0]!.body).toEqual({});
    await waitFor(() => expect(sw().checked).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "閲覧リンクを写す" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url.value));

    // やめる: 確認で取り消すとそのまま
    fireEvent.click(sw());
    fireEvent.click(within(screen.getByRole("dialog", { name: "リンク閲覧をやめる" })).getByRole("button", { name: "キャンセル" }));
    expect(calls("DELETE", "/api/files/f1/link")).toHaveLength(0);
    expect(sw().checked).toBe(true);
    // 確定すると無効になり、URL も消える
    fireEvent.click(sw());
    fireEvent.click(within(screen.getByRole("dialog", { name: "リンク閲覧をやめる" })).getByRole("button", { name: "無効にする" }));
    await waitFor(() => expect(calls("DELETE", "/api/files/f1/link")).toHaveLength(1));
    await waitFor(() => expect(sw().checked).toBe(false));
    expect(screen.queryByLabelText("閲覧リンク")).toBeNull();
  });

  it("すでに有効で URL が無い (開き直したあと) ときは、「リンクを作り直す」で新しい URL を出す (確認あり)", async () => {
    server.shares.f1!.linkToken = "old-token";
    await open();
    expect(sw().checked).toBe(true);
    expect(screen.queryByLabelText("閲覧リンク")).toBeNull();
    expect(screen.getByText(/作ったときにしか表示できません/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "リンクを作り直す" }));
    const confirm = screen.getByRole("dialog", { name: "リンクを作り直す" });
    expect(confirm.textContent).toContain("古いリンクは使えなくなり");
    fireEvent.click(within(confirm).getByRole("button", { name: "キャンセル" }));
    expect(calls("PUT", "/api/files/f1/link")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "リンクを作り直す" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "リンクを作り直す" })).getByRole("button", { name: "作り直す" }));
    const url = (await screen.findByLabelText("閲覧リンク")) as HTMLInputElement;
    expect(calls("PUT", "/api/files/f1/link")[0]!.body).toEqual({ regenerate: true });
    expect(url.value).not.toContain("old-token");
    expect(server.shares.f1!.linkToken).not.toBe("old-token");
  });

  it("失敗はトーストに出す", async () => {
    server.overrides["PUT /api/files/f1/link"] = () => apiError(409, "in_trash", "ゴミ箱の中のファイルです");
    await open();
    fireEvent.click(sw());
    await waitFor(() => expect(toasts()).toContain("ゴミ箱の中のファイルです"));
    expect(sw().checked).toBe(false);
  });
});

describe("ShareDialog: 確認ダイアログとの関係", () => {
  it("確認を閉じたあと、共有ダイアログの Escape が引き続き効く", async () => {
    server.shares.f1!.linkToken = "x";
    await open();
    fireEvent.click(screen.getByRole("switch"));
    const confirm = screen.getByRole("dialog", { name: "リンク閲覧をやめる" });
    fireEvent.click(within(confirm).getByRole("button", { name: "キャンセル" }));
    await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "閉じる" }));
  });
});
