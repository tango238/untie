// クラウドファイル (同時編集) の画面: 接続の状態・メニュー・閲覧専用・他の人の選択
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadModel, rebuildModel } from "@untie/collab";
import type { Role } from "@untie/api";
import { fixedGroups } from "@untie/core/model/fixedBoards";
import { createHotelSample } from "@untie/core/sample";
import { attachCloudDoc } from "../../cloud/collab";
import { useSessionStore } from "../../cloud/session";
import { useUntieStore, type Peer } from "../../store";
import { memory } from "../../test/platform";
import { fakeServer, user, type FakeServer } from "../../test/server";
import { resetStore } from "../../test/utils";
import App from "../../App";
import { ElementList } from "../ElementList";
import { FixedBoard } from "../FixedBoard";
import { IssuePanel } from "../IssuePanel";
import { PropertyPanel } from "../PropertyPanel";
import { Toolbar } from "../Toolbar";
import { CardNode } from "../canvas/CardNode";
import { handleKeyDown } from "../useKeyboard";

// キャンバス (ResizeObserver を使う) とノードの持ち手 (ReactFlow の中でしか動かない) は代役にする
vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));
vi.mock("../canvas/NodeHandles", () => ({ NodeHandles: () => null }));

const st = () => useUntieStore.getState();
const el = (id: string) => st().model.elements.find((e) => e.id === id)!;

let doc: Y.Doc;
let detach: (() => void) | null = null;
let server: FakeServer | null = null;

/** クラウドファイルとして開いた状態にする */
function openCloud(role: Role = "editor", boardId = "board_overview") {
  doc = new Y.Doc();
  loadModel(doc, createHotelSample());
  act(() => {
    detach = attachCloudDoc(doc, { fileId: "f1", role });
    st().setCloudStatus("connected");
    st().setCurrentBoard(boardId);
  });
}
const peer = (overrides: Partial<Peer> & { clientId: number }): Peer => ({
  userId: `u${overrides.clientId}`,
  name: `参加者${overrides.clientId}`,
  color: "#3e63dd",
  boardId: "board_overview",
  selection: null,
  ...overrides,
});

beforeEach(() => {
  resetStore();
  useSessionStore.setState({ status: "signedIn", user, providers: [], hasServer: true, error: null });
});
afterEach(() => {
  act(() => detach?.());
  detach = null;
  server?.restore();
  server = null;
});

describe("ツールバー (クラウドファイル)", () => {
  it("名前の横に接続の状態と役割を出す", () => {
    openCloud("editor");
    render(<Toolbar />);
    const status = () => screen.getByRole("status", { name: "接続の状態" }).textContent;
    expect(status()).toBe("接続中");
    act(() => st().setCloudStatus("offline"));
    expect(status()).toBe("切断。再接続します");
    act(() => st().setCloudStatus("connecting"));
    expect(status()).toBe("接続しています…");
    expect(screen.getByText("編集者")).toBeTruthy();
    // 名前は上に出しているので、下の「ファイルの状態」欄は出さない (重複させない)
    expect(screen.getByText(st().model.meta.name)).toBeTruthy();
    expect(screen.queryByRole("status", { name: "ファイルの状態" })).toBeNull();
  });

  it("参加者を色玉で出し、title に名前を入れる。同じ人の複数のタブは 1 つにまとめる", () => {
    openCloud();
    render(<Toolbar />);
    expect(screen.queryAllByTestId("peer-dot")).toHaveLength(0);
    act(() =>
      st().setPeers([
        peer({ clientId: 1, name: "花子", color: "#e5484d", userId: "u2" }),
        peer({ clientId: 2, name: "花子", color: "#e5484d", userId: "u2" }),
        peer({ clientId: 3, name: "ゲスト 1", color: "#30a46c", userId: null }),
      ]),
    );
    const dots = screen.getAllByTestId("peer-dot");
    expect(dots.map((d) => d.getAttribute("title"))).toEqual(["花子", "ゲスト 1"]);
    // 読み上げ用に、グループと見えない名前を持つ
    const group = screen.getByRole("group", { name: "一緒に開いている人" });
    expect(within(group).getByText("花子").className).toContain("visually-hidden");
    expect((dots[0] as HTMLElement).style.background).toBe("rgb(229, 72, 77)");
  });

  it("ファイルのメニューは「ホーム」「JSON に書き出す」「クラウドへ保存 (複製)」だけ", () => {
    openCloud();
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    const names = within(screen.getByRole("menu", { name: "ファイル" }))
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(names).toEqual(["ホーム", "JSON に書き出す…⌘S", "クラウドへ保存 (複製)", "AI の設定…"]);
    for (const hidden of ["新規作成", "開く…", "最近開いたファイル", "保存", "別名で保存…", "プロンプトから作成…"]) {
      expect(screen.queryByRole("menuitem", { name: new RegExp(`^${hidden}`) })).toBeNull();
    }
  });

  it("「JSON に書き出す」は手元のモデルを保存先を選んで書く。ファイルの状態は変わらない", async () => {
    openCloud();
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^JSON に書き出す/ }));
    await vi.waitFor(() => expect(memory().saved).toHaveLength(1));
    const saved = memory().saved[0]!;
    expect(saved.path).toBeNull();
    expect(JSON.parse(saved.text).meta.name).toBe(st().model.meta.name);
    expect(st().file).toBeNull();
    expect(st().cloud).not.toBeNull();
  });

  it("「クラウドへ保存 (複製)」は手元のモデルを新しいクラウドファイルにする", async () => {
    server = fakeServer({});
    openCloud();
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "クラウドへ保存 (複製)" }));
    await vi.waitFor(() => expect(server!.calls.some((c) => c.method === "POST" && c.path === "/api/files")).toBe(true));
    expect((server.calls.find((c) => c.path === "/api/files")!.body as { model: { meta: { name: string } } }).model.meta.name).toBe(st().model.meta.name);
  });

  it("「ホーム」でファイル一覧へ戻る (保存の確認は要らない)", () => {
    openCloud();
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "ホーム" }));
    expect(window.location.hash).toBe("#/");
  });

  it("元に戻す・やり直すは無効で、理由を title に出す。編集しても保存していない変更の印は出ない", () => {
    openCloud();
    render(<Toolbar />);
    act(() => {
      st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "別の名前" } } }));
    });
    for (const name of ["元に戻す", "やり直す"]) {
      const b = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toBe("共有中は取り消せません");
    }
    expect(screen.queryByText(/保存していない変更/)).toBeNull();
  });

  it("名前が空のモデルを書き出すときのファイル名は「名前なし」にする", async () => {
    openCloud();
    act(() => {
      st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "" } } }));
    });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^JSON に書き出す/ }));
    await vi.waitFor(() => expect(memory().saved).toHaveLength(1));
    expect(memory().saved[0]!.name).toBe("名前なし.json");
  });

  it("つながっていない間の変更があるときの「ホーム」は、確かめてからクラウドを閉じずに戻る", async () => {
    openCloud();
    act(() => {
      st().setCloudStatus("offline");
      st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "切れている間" } } }));
    });
    memory().discard = false;
    window.location.hash = "#/f/f1";
    const confirm = vi.spyOn(memory(), "confirmDiscard");
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "ホーム" }));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0]![0]).toContain("つながっていない間の変更");
    await new Promise((r) => setTimeout(r, 10));
    expect(window.location.hash).toBe("#/f/f1");
    expect(st().cloud).not.toBeNull();
    memory().discard = true;
    fireEvent.click(screen.getByRole("button", { name: "ホーム" }));
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));
    // 画面を離れるときの後始末は CloudEditor の仕事。ここでは cloud を外さない
    expect(st().cloud).not.toBeNull();
  });

  it("編集者はボードの追加・名前変更・削除と AI を使える", () => {
    openCloud("editor");
    render(<Toolbar />);
    for (const name of ["＋ボード", "名前変更", "ボード削除", "AI"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "＋ボード" }));
    expect(rebuildModel(doc).boards.map((b) => b.name)).toContain("ボード 4");
  });

  it("閲覧者にはボードの追加・名前変更・削除と AI を出さない", () => {
    openCloud("viewer");
    render(<Toolbar />);
    for (const name of ["＋ボード", "名前変更", "ボード削除", "AI"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByText("閲覧者")).toBeTruthy();
    // 課題一覧・検証・ボードの切り替えは使える
    expect(screen.getByRole("button", { name: "課題一覧" })).toBeTruthy();
    expect(screen.getByLabelText("ボード")).toBeTruthy();
    // メニューに AI の設定も出さない
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    expect(screen.queryByRole("menuitem", { name: /AI の設定/ })).toBeNull();
  });

  it("ローカルのファイルのメニューは今までどおり", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    expect(screen.getByRole("menuitem", { name: /^開く/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^保存/ })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "接続の状態" })).toBeNull();
  });
});

describe("閲覧専用の帯", () => {
  it("閲覧者・ゲストには「閲覧専用です (役割: …)」の帯を出す", () => {
    openCloud("viewer");
    const { unmount } = render(<App />);
    const banner = () => screen.getByText(/^閲覧専用です/);
    expect(banner().textContent).toBe("閲覧専用です (役割: 閲覧者)");
    // 名前は付けず、本文をそのまま読ませる
    expect(banner().getAttribute("role")).toBe("status");
    expect(banner().hasAttribute("aria-label")).toBe(false);
    unmount();
    act(() => st().setCloudRole("guest"));
    render(<App />);
    expect(banner().textContent).toBe("閲覧専用です (役割: ゲスト)");
  });

  it("編集者・ローカルには出さない。閲覧者は AI のペインも開けない", () => {
    openCloud("editor");
    const { unmount } = render(<App />);
    expect(screen.queryByText(/^閲覧専用です/)).toBeNull();
    unmount();
    act(() => st().setCloudRole("viewer"));
    render(<App />);
    expect(screen.queryByRole("region", { name: "AI エージェント" })).toBeNull();
  });
});

describe("プロパティ欄", () => {
  const selectEl = (id: string) => act(() => st().select({ type: "element", id }));

  it("閲覧者は入力欄がすべて読み取り専用で、変更・削除・関係の追加のボタンが出ない", () => {
    openCloud("viewer", "fixed:activity");
    selectEl("act_hand_key");
    render(<PropertyPanel />);
    expect((screen.getByLabelText("名前") as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText("説明") as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByLabelText("時間") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
    expect(screen.queryByLabelText("関係を追加")).toBeNull();
    expect(screen.queryByRole("button", { name: "課題を追加" })).toBeNull();
    expect(screen.queryByLabelText("リンクの URL")).toBeNull();
    expect(screen.getByText("閲覧専用のため、内容は変えられません。")).toBeTruthy();
    // 入力しても Doc は変わらない
    const before = rebuildModel(doc);
    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "書き換え" } });
    fireEvent.blur(screen.getByLabelText("名前"));
    expect(rebuildModel(doc)).toEqual(before);
  });

  it("閲覧者の課題の欄: 重要度・対象は無効、分析は読み取り専用、AI での深掘りは出ない。関係の線の付け根も無効", () => {
    openCloud("viewer", "board_overview");
    selectEl("issue_manual_entry");
    const { unmount } = render(<PropertyPanel />);
    // 無効の fieldset の中にあるので、:disabled に当たる
    expect(screen.getByLabelText("重要度").matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("対象を追加").matches(":disabled")).toBe(true);
    expect((screen.getByLabelText("現象") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "AI と深掘りする" })).toBeNull();
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
    unmount();

    // 両端がそのボードに載っている関係を探す
    const m = st().model;
    const found = m.boards.flatMap((b) => m.relations.filter((r) => [r.sourceId, r.targetId].every((id) => b.nodes.some((n) => n.elementId === id))).map((r) => ({ b, r })))[0]!;
    act(() => {
      st().setCurrentBoard(found.b.id);
      st().select({ type: "relation", id: found.r.id });
    });
    render(<PropertyPanel />);
    expect(document.querySelector<HTMLFieldSetElement>("fieldset.edge-sides")!.disabled).toBe(true);
  });

  it("編集者は編集でき、名前の変更が Doc に入る", () => {
    openCloud("editor", "fixed:activity");
    selectEl("act_hand_key");
    render(<PropertyPanel />);
    const input = screen.getByLabelText("名前") as HTMLInputElement;
    expect(input.readOnly).toBe(false);
    fireEvent.change(input, { target: { value: "受付" } });
    fireEvent.blur(input);
    expect(el("act_hand_key").name).toBe("受付");
    expect(rebuildModel(doc).elements.find((e) => e.id === "act_hand_key")?.name).toBe("受付");
    expect(screen.getByRole("button", { name: "削除" })).toBeTruthy();
  });

  it("他の人の変更が届くと、フォーカスしていない入力欄の値が変わる。入力途中の文字は消えない", () => {
    openCloud("editor", "fixed:activity");
    selectEl("act_hand_key");
    render(<PropertyPanel />);
    const input = screen.getByLabelText("名前") as HTMLInputElement;
    const remote = (name: string) =>
      act(() => {
        const e = doc.getMap<Y.Map<unknown>>("elements").get("act_hand_key")!;
        doc.transact(() => e.set("name", name), "peer");
      });
    remote("相手が変えた名前");
    expect(input.value).toBe("相手が変えた名前");
    // 入力途中 (未確定) に届いても、打っている文字は消さない
    input.focus();
    fireEvent.change(input, { target: { value: "打っている途中" } });
    remote("また相手が変えた");
    expect(input.value).toBe("打っている途中");
    fireEvent.blur(input);
    expect(el("act_hand_key").name).toBe("打っている途中");
  });

  it("他の人が同じ要素を選んでいるときは、名前の欄の上に知らせる (同じボードの人だけ)", () => {
    openCloud("editor", "fixed:activity");
    selectEl("act_hand_key");
    render(<PropertyPanel />);
    expect(screen.queryByTestId("peer-note")).toBeNull();
    act(() =>
      st().setPeers([
        peer({ clientId: 1, name: "花子", boardId: "fixed:activity", selection: { type: "element", id: "act_hand_key" } }),
        peer({ clientId: 2, name: "別のボード", boardId: "board_flow", selection: { type: "element", id: "act_hand_key" } }),
      ]),
    );
    expect(screen.getByTestId("peer-note").textContent).toBe("花子さんも選択中");
    // 同じ人が複数のタブで選んでいても 1 回
    act(() =>
      st().setPeers([
        peer({ clientId: 1, userId: "u2", name: "花子", boardId: "fixed:activity", selection: { type: "element", id: "act_hand_key" } }),
        peer({ clientId: 5, userId: "u2", name: "花子", boardId: "fixed:activity", selection: { type: "element", id: "act_hand_key" } }),
      ]),
    );
    expect(screen.getByTestId("peer-note").textContent).toBe("花子さんも選択中");
  });
});

describe("固定ボード", () => {
  it("編集者には追加・紐づけ・名前の変更が出る", () => {
    openCloud("editor", "fixed:activity");
    render(<FixedBoard layer="activity" />);
    expect(screen.getAllByRole("button", { name: /に作業を追加/ }).length).toBeGreaterThan(0);
    expect(document.querySelector(".fixed-card-name.is-renamable")).toBeTruthy();
  });

  it("閲覧者には追加・既存から足す・外す・名前の変更を出さない (選ぶことはできる)", () => {
    openCloud("viewer", "fixed:activity");
    render(<FixedBoard layer="activity" />);
    expect(screen.queryAllByRole("button", { name: /を追加/ })).toHaveLength(0);
    expect(screen.queryAllByRole("combobox", { name: /既存の/ })).toHaveLength(0);
    expect(document.querySelector(".fixed-unlink")).toBeNull();
    expect(document.querySelector(".fixed-card-name.is-renamable")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /鍵を渡す/ }));
    expect(st().ui.selection).toEqual({ type: "element", id: "act_hand_key" });
  });

  it("閲覧者のコンテキストの板には「＋コンテキスト」を出さない", () => {
    openCloud("viewer", "fixed:context");
    const { unmount } = render(<FixedBoard layer="context" />);
    expect(screen.queryByRole("button", { name: "＋コンテキスト" })).toBeNull();
    unmount();
    act(() => st().setCloudRole("editor"));
    render(<FixedBoard layer="context" />);
    expect(screen.getByRole("button", { name: "＋コンテキスト" })).toBeTruthy();
  });

  it("他の人が選んでいるカードと枠を、その人の色の縁と名前で示す (同じボードにいる人だけ)", () => {
    openCloud("editor", "fixed:activity");
    render(<FixedBoard layer="activity" />);
    const card = () => document.querySelector<HTMLElement>('[data-fixed-card="act_hand_key"]')!;
    const group = () => screen.getByRole("region", { name: "チェックイン" });
    // 枠の見出し (上位の要素) を選んでいる人
    const checkinParent = fixedGroups(st().model, "activity").find((g) => g.title === "チェックイン")!.parentId!;
    expect(within(card()).queryByTestId("peer-label")).toBeNull();
    act(() =>
      st().setPeers([
        peer({ clientId: 1, name: "花子", color: "#e5484d", boardId: "fixed:activity", selection: { type: "element", id: "act_hand_key" } }),
        peer({ clientId: 2, name: "次郎", color: "#30a46c", boardId: "fixed:activity", selection: { type: "element", id: checkinParent } }),
        peer({ clientId: 3, name: "別のボード", color: "#8e4ec6", boardId: "board_flow", selection: { type: "element", id: "act_hand_key" } }),
      ]),
    );
    expect(within(card()).getByTestId("peer-label").textContent).toBe("花子");
    expect(card().style.getPropertyValue("--peer-ring")).toContain("#e5484d");
    expect(card().style.getPropertyValue("--peer-ring")).toContain("2px");
    expect(within(group()).getAllByTestId("peer-label").map((l) => l.textContent)).toContain("次郎");
    expect(group().style.getPropertyValue("--peer-ring")).toContain("#30a46c");
    expect(screen.queryByText("別のボード")).toBeNull();
    // 同じ要素を 2 人が選んでいれば、縁を重ね、ラベルに人数を添える
    act(() =>
      st().setPeers([
        peer({ clientId: 1, name: "花子", color: "#e5484d", boardId: "fixed:activity", selection: { type: "element", id: "act_hand_key" } }),
        peer({ clientId: 2, name: "次郎", color: "#30a46c", boardId: "fixed:activity", selection: { type: "element", id: "act_hand_key" } }),
      ]),
    );
    expect(within(card()).getByTestId("peer-label").textContent).toBe("花子 +1");
    expect(card().style.getPropertyValue("--peer-ring")).toContain("4px");
  });
});

describe("自由ボードのカード", () => {
  const props = (elementId: string) =>
    ({
      data: { kind: "actor", elementId, name: "フロント担当", issueCount: 0, maxSeverity: 0 },
      selected: false,
    }) as unknown as Parameters<typeof CardNode>[0];

  it("他の人が選んでいるカードに、その人の色の縁と名前を出す", () => {
    openCloud("editor", "board_overview");
    const { container } = render(<CardNode {...props("actor_front")} />);
    const card = container.querySelector<HTMLElement>(".card-node")!;
    expect(card.style.getPropertyValue("--peer-ring")).toBe("");
    act(() => st().setPeers([peer({ clientId: 1, name: "花子", color: "#3e63dd", boardId: "board_overview", selection: { type: "element", id: "actor_front" } })]));
    // 縁は変数で渡し、カードの既定の影を消さない
    expect(card.style.getPropertyValue("--peer-ring")).toBe("0 0 0 2px #3e63dd");
    expect(card.style.boxShadow).toBe("");
    expect(within(card).getByTestId("peer-label").textContent).toBe("花子");
    // 別のボードにいる人・別の要素を選んでいる人は出さない
    act(() =>
      st().setPeers([
        peer({ clientId: 2, boardId: "board_flow", selection: { type: "element", id: "actor_front" } }),
        peer({ clientId: 3, boardId: "board_overview", selection: { type: "element", id: "actor_manager" } }),
        peer({ clientId: 4, boardId: "board_overview", selection: { type: "relation", id: "actor_front" } }),
      ]),
    );
    expect(card.style.getPropertyValue("--peer-ring")).toBe("");
    expect(within(card).queryByTestId("peer-label")).toBeNull();
  });
});

describe("課題一覧・要素一覧", () => {
  it("閲覧者には「＋課題」を出さない (編集者には出す)", () => {
    openCloud("viewer");
    const { unmount } = render(<IssuePanel />);
    expect(screen.queryAllByRole("button", { name: /＋課題/ })).toHaveLength(0);
    // 対象ごとの並びでも出さない
    fireEvent.click(screen.getByRole("button", { name: "対象ごと" }));
    expect(screen.queryAllByRole("button", { name: /課題を追加/ })).toHaveLength(0);
    unmount();
    act(() => st().setCloudRole("editor"));
    render(<IssuePanel />);
    expect(screen.getByRole("button", { name: "＋課題" })).toBeTruthy();
  });

  it("閲覧者の要素一覧は、ドラッグも「置く」もできない", () => {
    openCloud("viewer", "board_flow");
    const { unmount } = render(<ElementList />);
    expect(document.querySelectorAll('.row[draggable="true"]')).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /をボードに置く/ })).toHaveLength(0);
    unmount();
    act(() => st().setCloudRole("editor"));
    render(<ElementList />);
    expect(document.querySelectorAll('.row[draggable="true"]').length).toBeGreaterThan(0);
  });
});

describe("キーボード", () => {
  const key = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
    // dispatch しないので、target は自分で決める (フォーカスなし = body)
    Object.defineProperty(e, "target", { value: document.body });
    handleKeyDown(e);
    return e;
  };

  it("Cmd/Ctrl+S は JSON への書き出しになる。開く・Undo・Redo は無視する", async () => {
    openCloud("editor");
    const open = vi.fn(async () => null);
    memory().openTextFile = open;
    const undo = vi.spyOn(st(), "undo");
    key({ key: "s", ctrlKey: true });
    await vi.waitFor(() => expect(memory().saved).toHaveLength(1));
    expect(memory().saved[0]!.path).toBeNull();
    key({ key: "o", ctrlKey: true });
    key({ key: "z", ctrlKey: true });
    key({ key: "z", ctrlKey: true, shiftKey: true });
    key({ key: "y", ctrlKey: true });
    expect(open).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(memory().saved).toHaveLength(1);
  });

  it("閲覧者の Delete は何もしない。編集者は自由ボードからカードを外せる", () => {
    openCloud("viewer", "board_overview");
    const onBoard = st().model.boards.find((b) => b.id === "board_overview")!.nodes[0]!.elementId;
    act(() => st().select({ type: "element", id: onBoard }));
    const before = st().model;
    key({ key: "Delete" });
    expect(st().model).toBe(before);

    act(() => st().setCloudRole("editor"));
    key({ key: "Delete" });
    expect(st().model.boards.find((b) => b.id === "board_overview")!.nodes.some((n) => n.elementId === onBoard)).toBe(false);
    expect(rebuildModel(doc).boards.find((b) => b.id === "board_overview")!.nodes.some((n) => n.elementId === onBoard)).toBe(false);
  });
});

describe("閉じる前の確認", () => {
  it("クラウドファイルでは、変更があっても確認しない", async () => {
    const { default: Root } = await import("../../Root");
    const { unmount } = render(<Root />);
    const [guard] = [...memory().closeGuards];
    openCloud("editor");
    act(() => {
      st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "変えた" } } }));
    });
    expect(guard!()).toBe(false);
    unmount();
  });
});
