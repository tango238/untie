import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderId } from "@untie/api";
import { createHotelSample } from "@untie/core/sample";
import { useFilesStore } from "../../../cloud/files";
import { useSessionStore } from "../../../cloud/session";
import * as doc from "../../../io/document";
import { useUntieStore } from "../../../store";
import { memory } from "../../../test/platform";
import { apiError, fakeServer, summary, user, type FakeServer } from "../../../test/server";
import { resetStore } from "../../../test/utils";
import Home from "../Home";
import { formatRelativeTime } from "../relativeTime";

let server: FakeServer;

const signedIn = () => useSessionStore.setState({ status: "signedIn", user, providers: ["dev"], hasServer: true, error: null });
const anonymous = (providers: ProviderId[], hasServer = true) =>
  useSessionStore.setState({ status: "anonymous", user: null, providers, hasServer, error: null });
const rowOf = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

beforeEach(() => {
  resetStore();
  window.location.hash = "";
  useFilesStore.getState().reset();
  useSessionStore.setState({ status: "unknown", user: null, providers: [], hasServer: false, error: null });
  server = fakeServer({
    mine: [summary({ id: "a", name: "ホテルの業務" }), summary({ id: "b", name: "経理", updatedAt: Date.now() - 2 * 3600_000, memberCount: 3 })],
    shared: [summary({ id: "s", name: "共有されたもの", role: "viewer", ownerId: "u2", ownerName: "山田", memberCount: 2 })],
    trash: [summary({ id: "t", name: "古いもの", deletedAt: Date.now() - 86_400_000 })],
  });
});
afterEach(() => {
  server.restore();
  vi.restoreAllMocks();
});

describe("Home: ログイン", () => {
  it("確認中は「確認中」を出す", () => {
    render(<Home />);
    expect(screen.getAllByText(/確認中/).length).toBeGreaterThan(0);
  });

  it("未ログインでは providers にあるボタンだけ出す", () => {
    anonymous(["dev"]);
    render(<Home />);
    expect(screen.getByRole("button", { name: "開発用ログイン (メールを入れるだけ)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Google でログイン" })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("google があれば「Google でログイン」が出て、押すと Platform の login に provider と戻り先が渡る", () => {
    anonymous(["google", "dev"]);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Google でログイン" }));
    expect(memory().logins).toEqual([{ provider: "google", returnTo: "#/" }]);
    expect(screen.getByRole("button", { name: "開発用ログイン (メールを入れるだけ)" })).toBeTruthy();
  });

  it("サーバーが設定されていなければその旨を出し、ログインのボタンは出さない", () => {
    anonymous([], false);
    render(<Home />);
    expect(screen.getByText("サーバーが設定されていないため、クラウドの機能は使えません")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ログイン \(|Google でログイン/ })).toBeNull();
    // ローカルの入口は使える
    expect(screen.getByRole("button", { name: "ローカルファイルを開く" })).toBeTruthy();
  });

  it("サーバーにつながらなかった理由を出す", () => {
    useSessionStore.setState({ status: "anonymous", providers: [], hasServer: true, error: "サーバーにつながりません: x" });
    render(<Home />);
    expect(screen.getByText(/サーバーにつながりません: x/)).toBeTruthy();
  });

  it("ヘッダーにアプリ名と、未ログインなら「ログイン」、ログイン済みなら名前とログアウトのメニュー", async () => {
    anonymous(["dev"]);
    const { unmount } = render(<Home />);
    expect(screen.getByRole("heading", { level: 1, name: "Untie" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ログイン" })).toBeTruthy();
    unmount();

    signedIn();
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: /テスト太郎/ }));
    const menu = screen.getByRole("menu", { name: "アカウント" });
    expect(within(menu).getByRole("menuitem", { name: "ログアウト" })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "すべての端末からログアウト" }));
    await waitFor(() => expect(useSessionStore.getState().status).toBe("anonymous"));
    expect(server.calls.some((c) => c.path === "/auth/logout-all")).toBe(true);
    // ログアウトすると一覧も空になり、ログイン欄に戻る
    await screen.findByRole("button", { name: "開発用ログイン (メールを入れるだけ)" });
  });
});

describe("Home: クラウドのファイル", () => {
  it("ログイン済みなら一覧に名前・更新日時・役割・メンバー数が出る", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    const row = rowOf("ホテルの業務");
    expect(within(row).getByText("3 分前")).toBeTruthy();
    expect(within(row).getByText("所有者")).toBeTruthy();
    expect(within(row).getByText("1 人")).toBeTruthy();
    const second = rowOf("経理");
    expect(within(second).getByText("2 時間前")).toBeTruthy();
    expect(within(second).getByText("3 人")).toBeTruthy();
  });

  it("タブを切り替えると共有されたファイルとゴミ箱が出る。役割に応じた操作だけ出る", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    expect(screen.queryByText("共有されたもの")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /共有されたファイル/ }));
    const shared = rowOf("共有されたもの");
    expect(within(shared).getByText("閲覧者")).toBeTruthy();
    expect(within(shared).getByText("所有者: 山田")).toBeTruthy();
    // viewer は開く・複製・書き出しだけ。名前変更とゴミ箱は出ない
    expect(within(shared).getByRole("button", { name: "開く" })).toBeTruthy();
    expect(within(shared).getByRole("button", { name: "複製" })).toBeTruthy();
    expect(within(shared).getByRole("button", { name: "書き出す" })).toBeTruthy();
    expect(within(shared).queryByRole("button", { name: "名前を変える" })).toBeNull();
    expect(within(shared).queryByRole("button", { name: "ゴミ箱へ" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /ゴミ箱/ }));
    const trashed = rowOf("古いもの");
    expect(within(trashed).getByText("1 日前")).toBeTruthy();
    expect(within(trashed).getByRole("button", { name: "戻す" })).toBeTruthy();
    expect(within(trashed).getByRole("button", { name: "完全に消す" })).toBeTruthy();
    expect(within(trashed).queryByRole("button", { name: "開く" })).toBeNull();
  });

  it("空のときは文言を出す", async () => {
    server.mine = [];
    server.shared = [];
    server.trash = [];
    signedIn();
    render(<Home />);
    await screen.findByText(/まだファイルがありません/);
    fireEvent.click(screen.getByRole("tab", { name: /共有されたファイル/ }));
    expect(screen.getByText("共有されたファイルはありません。")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /ゴミ箱/ }));
    expect(screen.getByText("ゴミ箱は空です。")).toBeTruthy();
  });

  it("「開く」で #/f/<id> へ移る", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "開く" }));
    expect(window.location.hash).toBe("#/f/a");
  });

  it("名前を変える: インラインの入力で決定すると PATCH され、一覧に反映される", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "名前を変える" }));
    const input = screen.getByRole("textbox", { name: "新しい名前" }) as HTMLInputElement;
    expect(input.value).toBe("ホテルの業務");
    fireEvent.change(input, { target: { value: "ホテル運用" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("ホテル運用");
    expect(screen.queryByRole("textbox", { name: "新しい名前" })).toBeNull();
    const patch = server.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/api/files/a");
    expect(patch.body).toEqual({ name: "ホテル運用" });
  });

  it("名前変更は Escape で取り消せる。空の名前は送らずトーストを出す", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "名前を変える" }));
    let input = screen.getByRole("textbox", { name: "新しい名前" });
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.submit(input.closest("form")!);
    expect(useUntieStore.getState().toasts.slice(-1)[0]?.message).toBe("名前を入力してください");
    expect(server.calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "新しい名前" })).toBeNull();
    // もう一度開いて、同じ名前のまま決定しても送らない
    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "名前を変える" }));
    input = screen.getByRole("textbox", { name: "新しい名前" });
    fireEvent.submit(input.closest("form")!);
    expect(server.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("ゴミ箱へ: 確認ダイアログのあとで DELETE され、ゴミ箱タブに出る。戻すと自分のファイルに戻る", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "ゴミ箱へ" }));
    const dialog = screen.getByRole("dialog", { name: "ゴミ箱へ" });
    // 取り消しでは何も起きない
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(server.calls.some((c) => c.method === "DELETE")).toBe(false);

    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "ゴミ箱へ" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "ゴミ箱へ" })).getByRole("button", { name: "ゴミ箱へ入れる" }));
    await waitFor(() => expect(screen.queryByText("ホテルの業務")).toBeNull());
    expect(server.calls.some((c) => c.method === "DELETE" && c.path === "/api/files/a")).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: /ゴミ箱/ }));
    const trashed = rowOf("ホテルの業務");
    fireEvent.click(within(trashed).getByRole("button", { name: "戻す" }));
    await waitFor(() => expect(screen.queryByText("ホテルの業務")).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: /自分のファイル/ }));
    await screen.findByText("ホテルの業務");
  });

  it("完全に消す: 確認のあとで purge される", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(screen.getByRole("tab", { name: /ゴミ箱/ }));
    fireEvent.click(within(rowOf("古いもの")).getByRole("button", { name: "完全に消す" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "完全に消す" })).getByRole("button", { name: "完全に消す" }));
    await waitFor(() => expect(screen.queryByText("古いもの")).toBeNull());
    expect(server.calls.some((c) => c.method === "DELETE" && c.path === "/api/files/t/purge")).toBe(true);
  });

  it("複製と書き出し", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "複製" }));
    await screen.findByText("ホテルの業務 のコピー");
    fireEvent.click(within(rowOf("経理")).getByRole("button", { name: "書き出す" }));
    await waitFor(() => expect(memory().saved).toHaveLength(1));
    expect(memory().saved[0]!.name).toBe("経理.json");
  });

  it("新しいファイル: 名前を入れて作ると一覧に出る。名前が空ならトースト", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(screen.getByRole("button", { name: "新しいファイル" }));
    const input = screen.getByRole("textbox", { name: "新しいファイルの名前" });
    fireEvent.submit(input.closest("form")!);
    expect(useUntieStore.getState().toasts.slice(-1)[0]?.message).toBe("ファイルの名前を入力してください");
    fireEvent.change(input, { target: { value: "営業" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("営業");
    expect(server.calls.find((c) => c.method === "POST" && c.path === "/api/files")!.body).toEqual({ name: "営業" });
    expect(screen.queryByRole("textbox", { name: "新しいファイルの名前" })).toBeNull();
  });

  it("ローカルファイルをクラウドへ: 検証を通れば model を送り、通らなければトースト", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    const button = screen.getByRole("button", { name: "ローカルファイルをクラウドへ" });

    memory().opened = { path: null, name: "bad.json", text: "{not json" };
    fireEvent.click(button);
    await waitFor(() => expect(useUntieStore.getState().toasts.slice(-1)[0]?.message).toContain("「bad.json」を取り込めません"));
    expect(server.calls.some((c) => c.method === "POST")).toBe(false);

    memory().opened = { path: null, name: "ok.json", text: JSON.stringify(createHotelSample()) };
    fireEvent.click(button);
    await waitFor(() => expect(server.calls.some((c) => c.method === "POST" && c.path === "/api/files")).toBe(true));
    const post = server.calls.find((c) => c.method === "POST" && c.path === "/api/files")!;
    expect((post.body as { model: unknown }).model).toBeTruthy();
  });

  it("一覧を読めなかったときは理由を出す", async () => {
    server.overrides["GET /api/files"] = () => new Response(JSON.stringify({ error: { code: "internal", message: "サーバーでエラーが起きました" } }), { status: 500 });
    signedIn();
    render(<Home />);
    await screen.findByText(/一覧を読めませんでした: サーバーでエラーが起きました/);
  });
});

describe("Home: できないこと・失敗・操作性", () => {
  it("editor の行には名前を変えるは出るが、ゴミ箱へは出ない", async () => {
    server.shared = [summary({ id: "e", name: "編集できる", role: "editor", ownerId: "u2", ownerName: "山田" })];
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(screen.getByRole("tab", { name: /共有されたファイル/ }));
    const row = rowOf("編集できる");
    expect(within(row).getByText("編集者")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "名前を変える" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "複製" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "ゴミ箱へ" })).toBeNull();
  });

  it("使っている途中で 401 を受けたらログイン欄に戻り、一覧は消える", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    server.signedIn = false;
    server.unauthorizedCode = "session_expired";
    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "複製" }));
    await screen.findByRole("button", { name: "開発用ログイン (メールを入れるだけ)" });
    expect(screen.queryByText("ホテルの業務")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "ログイン" })).toBeTruthy();
    expect(useUntieStore.getState().toasts.map((t) => t.message)).toContain("ログインの有効期限が切れました。もう一度ログインしてください");
  });

  it("ゴミ箱へ入れるのが 403 なら、サーバーの文言をトーストに出して一覧はそのまま", async () => {
    server.overrides["DELETE /api/files/a"] = () =>
      new Response(JSON.stringify({ error: { code: "forbidden", message: "この操作をする権限がありません" } }), { status: 403 });
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "ゴミ箱へ" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "ゴミ箱へ" })).getByRole("button", { name: "ゴミ箱へ入れる" }));
    await waitFor(() => expect(useUntieStore.getState().toasts.map((t) => t.message)).toContain("この操作をする権限がありません"));
    expect(screen.getByText("ホテルの業務")).toBeTruthy();
  });

  it("最初の読み込み中は「読み込み中…」を出し、読み終えたら空の文言に替わる", async () => {
    server.mine = [];
    signedIn();
    render(<Home />);
    expect(screen.getByText("読み込み中…", { selector: "p" })).toBeTruthy();
    expect(screen.queryByText(/まだファイルがありません/)).toBeNull();
    await screen.findByText(/まだファイルがありません/);
    expect(screen.queryByText("読み込み中…", { selector: "p" })).toBeNull();
  });

  it("タブは aria で結ばれ、← → Home End で移れる", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    const [mine, shared, trash] = screen.getAllByRole("tab");
    expect(mine!.getAttribute("aria-selected")).toBe("true");
    expect(mine!.getAttribute("tabindex")).toBe("0");
    expect(shared!.getAttribute("tabindex")).toBe("-1");
    const panel = screen.getByRole("tabpanel");
    expect(mine!.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(mine!.id);

    fireEvent.keyDown(mine!, { key: "ArrowRight" });
    expect(shared!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(shared);
    fireEvent.keyDown(shared!, { key: "End" });
    expect(trash!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(trash!, { key: "ArrowRight" });
    expect(mine!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(mine!, { key: "ArrowLeft" });
    expect(trash!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(trash!, { key: "Home" });
    expect(document.activeElement).toBe(mine);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(mine!.id);
  });

  it("名前変更の「決定」は送っている間は押せない", async () => {
    let release!: () => void;
    server.overrides["PATCH /api/files/a"] = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify(summary({ id: "a", name: "新名" })), { status: 200 }));
      });
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "名前を変える" }));
    const input = screen.getByRole("textbox", { name: "新しい名前" });
    fireEvent.change(input, { target: { value: "新名" } });
    fireEvent.submit(input.closest("form")!);
    const submit = await screen.findByRole("button", { name: "決定" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(input.closest("form")!);
    release();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "新しい名前" })).toBeNull());
    expect(server.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("ヘッダーの「ログイン」はログイン欄のボタンへフォーカスを移す", () => {
    anonymous(["google", "dev"]);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    expect(document.activeElement?.closest(".home-login-buttons")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Google でログイン");
  });

  it("ログイン方法を取得できなかったときは、その旨をエラーで出す", () => {
    useSessionStore.setState({ status: "anonymous", providers: [], hasServer: true, error: "ログイン方法を取得できませんでした" });
    render(<Home />);
    expect(screen.getByText(/ログイン方法を取得できませんでした/)).toBeTruthy();
  });
});

describe("Home: 共有", () => {
  it("「共有」は所有者の行にだけ出る (共有されたファイルの行には出ない)", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    expect(within(rowOf("ホテルの業務")).getByRole("button", { name: "共有" })).toBeTruthy();
    expect(within(rowOf("ホテルの業務")).queryByRole("button", { name: "共有をやめる" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /共有されたファイル/ }));
    expect(within(rowOf("共有されたもの")).queryByRole("button", { name: "共有" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /ゴミ箱/ }));
    expect(within(rowOf("古いもの")).queryByRole("button", { name: "共有" })).toBeNull();
  });

  it("「共有」で共有ダイアログが開き、閉じるとホームに戻る", async () => {
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "共有" }));
    await screen.findByRole("dialog", { name: "「ホテルの業務」を共有" });
    expect(server.calls.some((c) => c.method === "GET" && c.path === "/api/files/a")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("共有ダイアログでの変更は、ホームの一覧 (メンバーの数) にも反映される", async () => {
    server.users = [{ id: "u2", email: "b@example.com", name: "田中" }];
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(within(rowOf("ホテルの業務")).getByRole("button", { name: "共有" }));
    const input = await screen.findByLabelText("招待するメールアドレス");
    fireEvent.change(input, { target: { value: "b@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "招待" }));
    await screen.findByText("田中さんをメンバーに加えました");
    await waitFor(() => expect(within(rowOf("ホテルの業務")).getByText("2 人")).toBeTruthy());
  });

  it("共有されたファイルの「共有をやめる」: 確認のあとで自分を外し、一覧から消える。取り消せば何もしない", async () => {
    server.shares.s = {
      members: [{ userId: "u2", email: "y@example.com", name: "山田", role: "owner", addedAt: 0 }, { userId: "u1", email: user.email, name: user.name, role: "viewer", addedAt: 0 }],
      invitations: [],
      linkToken: null,
    };
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(screen.getByRole("tab", { name: /共有されたファイル/ }));
    fireEvent.click(within(rowOf("共有されたもの")).getByRole("button", { name: "共有をやめる" }));
    const dialog = screen.getByRole("dialog", { name: "共有をやめる" });
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(server.calls.some((c) => c.method === "DELETE")).toBe(false);

    fireEvent.click(within(rowOf("共有されたもの")).getByRole("button", { name: "共有をやめる" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "共有をやめる" })).getByRole("button", { name: "共有をやめる" }));
    await waitFor(() => expect(screen.queryByText("共有されたもの")).toBeNull());
    expect(server.calls.some((c) => c.method === "DELETE" && c.path === "/api/files/s/members/u1")).toBe(true);
    expect(useUntieStore.getState().toasts.map((t) => t.message)).toContain("「共有されたもの」の共有をやめました");
  });

  it("editor の行にも「共有をやめる」が出る。失敗したらサーバーの文言をトーストに出して一覧はそのまま", async () => {
    server.shared = [summary({ id: "e", name: "編集できる", role: "editor", ownerId: "u2", ownerName: "山田" })];
    server.overrides["DELETE /api/files/e/members/u1"] = () => apiError(409, "conflict", "いま外せません");
    signedIn();
    render(<Home />);
    await screen.findByText("ホテルの業務");
    fireEvent.click(screen.getByRole("tab", { name: /共有されたファイル/ }));
    fireEvent.click(within(rowOf("編集できる")).getByRole("button", { name: "共有をやめる" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "共有をやめる" })).getByRole("button", { name: "共有をやめる" }));
    await waitFor(() => expect(useUntieStore.getState().toasts.map((t) => t.message)).toContain("いま外せません"));
    expect(screen.getByText("編集できる")).toBeTruthy();
  });
});

describe("Home: ローカル", () => {
  it("「ローカルファイルを開く」: 開けたら #/local へ。取り消したら移らない", async () => {
    anonymous([]);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "ローカルファイルを開く" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(window.location.hash).toBe("");

    memory().opened = { path: "/docs/a.json", name: "a.json", text: JSON.stringify(createHotelSample()) };
    fireEvent.click(screen.getByRole("button", { name: "ローカルファイルを開く" }));
    await waitFor(() => expect(window.location.hash).toBe("#/local"));
    expect(useUntieStore.getState().file?.name).toBe("a.json");
  });

  it("「新規作成 (ローカル)」と「サンプルを開く」は #/local へ移る", async () => {
    anonymous([]);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "新規作成 (ローカル)" }));
    await waitFor(() => expect(window.location.hash).toBe("#/local"));
    expect(useUntieStore.getState().model.elements).toHaveLength(0);

    window.location.hash = "";
    fireEvent.click(screen.getByRole("button", { name: "サンプルを開く" }));
    await waitFor(() => expect(window.location.hash).toBe("#/local"));
    expect(useUntieStore.getState().model.elements.length).toBeGreaterThan(0);
  });

  it("未保存の変更があって破棄を断ったら移らない", async () => {
    anonymous([]);
    useUntieStore.setState({ savedModel: createHotelSample() });
    memory().discard = false;
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "新規作成 (ローカル)" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(window.location.hash).toBe("");
    expect(useUntieStore.getState().model.elements.length).toBeGreaterThan(0);
  });

  it("最近開いたローカルファイルを並べ、押すと開いて #/local へ移る", async () => {
    anonymous([]);
    const sample = createHotelSample();
    memory().contents.set("/docs/r.json", JSON.stringify(sample));
    await memory().recentFiles.add({ path: "/docs/r.json", name: "r.json" });
    const open = vi.spyOn(doc, "openRecentDocument");
    render(<Home />);
    fireEvent.click(await screen.findByRole("button", { name: "r.json" }));
    await waitFor(() => expect(window.location.hash).toBe("#/local"));
    expect(open).toHaveBeenCalledOnce();
    expect(useUntieStore.getState().file?.path).toBe("/docs/r.json");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 9, 31, 12, 0, 0);
  it("経過時間で表し方を変える", () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe("たった今");
    expect(formatRelativeTime(now + 5_000, now)).toBe("たった今");
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe("3 分前");
    expect(formatRelativeTime(now - 5 * 3600_000, now)).toBe("5 時間前");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2 日前");
    expect(formatRelativeTime(now - 90 * 86_400_000, now)).toMatch(/^2026\/\d+\/\d+$/);
  });
});
