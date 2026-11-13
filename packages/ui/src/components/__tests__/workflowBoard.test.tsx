import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addElement, addRelation, removeElement, removeRelation, type CommandResult } from "@untie/core/model/commands";
import type { Activity, UntieModel } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { handleKeyDown } from "../useKeyboard";
import { resetStore } from "../../test/utils";
import { PropertyPanel } from "../PropertyPanel";
import { WorkflowBoard } from "../workflow/WorkflowBoard";
import { Toolbar } from "../Toolbar";
import { ConfirmDialog } from "../ConfirmDialog";
import { canvasApi } from "../canvas/canvasApi";

const st = () => useUntieStore.getState();

beforeEach(() => {
  resetStore();
  useUntieStore.setState({ cloud: null });
  act(() => st().setMode("analysisSimple"));
});

const renderBoth = () =>
  render(
    <>
      <WorkflowBoard />
      <PropertyPanel />
    </>,
  );
const lane = (name: string) => screen.getByRole("region", { name: `登場人物 ${name} の行` });
const selectedId = () => {
  const sel = st().ui.selection;
  return sel?.type === "element" ? sel.id : null;
};

describe("ワークフローボードの描画", () => {
  it("登場人物ごとの行に、業務の枠・活動の枠・作業の縦の一覧が入れ子で出る", () => {
    render(<WorkflowBoard />);
    const front = lane("フロント担当");
    // 業務の枠は 3 つ。滞在中の対応の枠の中に、活動の枠が入り、その中に作業の一覧が出る
    const stay = within(front).getByRole("region", { name: /^業務 滞在中の対応/ });
    const dining = within(stay).getByRole("region", { name: "活動 飲食提供" });
    const stack = within(dining).getByRole("list", { name: "作業の一覧" });
    expect(within(stack).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("ルームサービスを提供する")]);
    // 業務に直接属する作業は、業務の枠の中に縦に並ぶ (モデルの順)
    const checkin = within(front).getByRole("region", { name: /^業務 チェックイン/ });
    const names = within(within(checkin).getAllByRole("list", { name: "作業の一覧" })[0]!).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names.slice(0, 2)).toEqual(["作業 到着を確認する (担当: フロント担当)", "作業 本人確認をする (担当: フロント担当、宿泊客)"]);
    // 作業の行には担当の名前を添える
    expect(within(checkin).getByRole("button", { name: /^作業 本人確認をする/ }).textContent).toContain("担当: フロント担当、宿泊客");
  });

  it("業務を 1 つも持たない登場人物も行に出る。担当の決まっていない業務と業務に属さない作業は別の区画に出る", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "actor", name: "新人", id: "actor_new" }));
      st().dispatch((m) => addElement(m, { kind: "business", name: "宙ぶらりんの業務", id: "biz_free" }));
      st().dispatch((m) => addElement(m, { kind: "activity", name: "迷子の作業", id: "act_lost" }));
    });
    render(<WorkflowBoard />);
    expect(within(lane("新人")).getByText("業務はまだありません")).toBeDefined();
    const unassigned = screen.getByRole("region", { name: "担当が決まっていない業務" });
    expect(within(unassigned).getByRole("button", { name: "業務 宙ぶらりんの業務" })).toBeDefined();
    const orphans = screen.getByRole("region", { name: "業務に属さない作業" });
    expect(within(orphans).getByRole("button", { name: /^作業 迷子の作業/ })).toBeDefined();
  });

  it("業務が複数の登場人物に結ばれているときは、どちらの行にも出て、知らせを添える", () => {
    act(() => void st().dispatch((m) => addRelation(m, { sourceId: "actor_manager", targetId: "biz_checkin" })));
    render(<WorkflowBoard />);
    for (const name of ["フロント担当", "支配人"]) expect(within(lane(name)).getByRole("button", { name: "業務 チェックイン" })).toBeDefined();
    expect(within(lane("支配人")).getByText(/主担当が複数います/)).toBeDefined();
  });

  it("用語はユーザー向けの言葉 (BUC・集約などを出さない)", () => {
    render(<WorkflowBoard />);
    expect(document.body.textContent).not.toMatch(/BUC|集約|境界づけ|ドメイン/);
  });
});

describe("選択", () => {
  it("カード・枠の見出し・作業の行を押すと選択してプロパティに出す。選択中は aria-current になる (キーボードで選べるボタン)", () => {
    renderBoth();
    for (const [name, id] of [
      ["登場人物 フロント担当", "actor_front"],
      ["業務 チェックイン", "biz_checkin"],
      ["活動 飲食提供", "buc_dining"],
      ["作業 鍵を渡す", "act_hand_key"],
    ] as const) {
      const button = screen.getAllByRole("button", { name: new RegExp(`^${name}`) }).find((b) => b.tagName === "BUTTON")!;
      expect(button.tagName).toBe("BUTTON");
      fireEvent.click(button);
      expect(selectedId()).toBe(id);
      expect(button.getAttribute("aria-current")).toBe("true");
      expect(screen.getByTestId("element-editor")).toBeDefined();
      expect((screen.getByLabelText("名前") as HTMLInputElement).value).toBe(name.split(" ")[1]);
    }
  });

  it("枠の余白を押しても、その枠を選ぶ。作業を押しても外側の枠は選ばない", () => {
    render(<WorkflowBoard />);
    fireEvent.click(screen.getByRole("region", { name: /^業務 滞在中の対応/ }));
    expect(selectedId()).toBe("biz_stay");
    fireEvent.click(screen.getByRole("button", { name: /^作業 客室の要望に応える/ }));
    expect(selectedId()).not.toBe("biz_stay");
  });
});

describe("足す", () => {
  it("＋登場人物 / ＋業務 / ＋活動 / ＋作業 で足し、足した直後に選んで名前の入力へ移れる", () => {
    renderBoth();
    const nonce = st().ui.nameFocusNonce;
    fireEvent.click(screen.getByRole("button", { name: "登場人物を足す" }));
    const actor = st().model.elements[st().model.elements.length - 1]!;
    expect(actor.kind).toBe("actor");
    expect(selectedId()).toBe(actor.id);
    expect(st().ui.nameFocusNonce).toBe(nonce + 1);
    expect(document.activeElement).toBe(screen.getByLabelText("名前"));

    fireEvent.click(screen.getByRole("button", { name: `「新しい登場人物」に業務を足す` }));
    const business = st().model.elements.find((e) => e.kind === "business" && e.name === "新しい業務")!;
    expect(st().model.relations.some((r) => r.kind === "actorBusiness" && r.sourceId === actor.id && r.targetId === business.id)).toBe(true);
    expect(selectedId()).toBe(business.id);

    fireEvent.click(screen.getByRole("button", { name: "「新しい業務」に作業を足す" }));
    const activity = st().model.elements.find((e) => e.kind === "activity" && e.name === "新しい作業") as Activity;
    expect(selectedId()).toBe(activity.id);
    // 業務に初めて活動を足すと、直接の作業は活動に移る。以後、業務の枠には作業を足すボタンが出ない
    fireEvent.click(screen.getByRole("button", { name: "「新しい業務」に活動を足す" }));
    const buc = st().model.elements.find((e) => e.kind === "buc" && !e.isDefault && e.name === "新しい活動")!;
    expect((st().model.elements.find((e) => e.id === activity.id) as Activity).bucId).toBe(buc.id);
    expect(screen.queryByRole("button", { name: "「新しい業務」に作業を足す" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "「新しい活動」に作業を足す" }));
    expect(st().model.elements.filter((e) => e.kind === "activity" && e.bucId === buc.id)).toHaveLength(2);
    // 足したものは undo で戻せる
    const past = st().history.past.length;
    act(() => st().undo());
    expect(st().history.past.length).toBe(past - 1);
  });

  it("活動のある業務の枠には、作業は活動の枠から足すという案内を出す (閲覧専用では出さない)", () => {
    render(<WorkflowBoard />);
    const front = lane("フロント担当");
    const stay = within(front).getByRole("region", { name: /^業務 滞在中の対応/ });
    expect(within(stay).getByText(/作業は活動の枠の「＋作業」から足します/)).toBeDefined();
    const checkin = within(front).getByRole("region", { name: /^業務 チェックイン/ });
    expect(within(checkin).queryByText(/活動の枠の「＋作業」から/)).toBeNull();
  });

  it("外部の登場人物には業務を足せない", () => {
    render(<WorkflowBoard />);
    expect(within(lane("宿泊客")).queryByRole("button", { name: /に業務を足す/ })).toBeNull();
  });

  it("閲覧専用では、足す操作を出さない", () => {
    // クラウドの閲覧者 (selectReadOnly) を模す
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    render(<WorkflowBoard />);
    expect(screen.queryByRole("button", { name: /を足す/ })).toBeNull();
    // 選ぶことはできる
    fireEvent.click(screen.getByRole("button", { name: /^作業 鍵を渡す/ }));
    expect(selectedId()).toBe("act_hand_key");
  });
});

describe("プロパティからの関連の追加・削除と、削除の確認", () => {
  const select = (name: string) => fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^${name}`) })[0]!);
  const dialog = () => screen.queryByRole("dialog", { name: "削除の確認" });

  it("プロパティで、関連の追加 (登場人物に業務を主担当として結ぶ) と削除ができる", () => {
    act(() => void st().dispatch((m) => addElement(m, { kind: "business", name: "宙ぶらりんの業務", id: "biz_free" })));
    renderBoth();
    select("業務 宙ぶらりんの業務");
    fireEvent.change(screen.getByLabelText("関係を追加"), { target: { value: "actor_front>biz_free" } });
    expect(st().model.relations.some((r) => r.kind === "actorBusiness" && r.sourceId === "actor_front" && r.targetId === "biz_free")).toBe(true);
    // 子の無い業務なので、外すのに確認は出ない
    fireEvent.click(screen.getByRole("button", { name: /^関係「主担当 フロント担当」を削除$/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(st().model.relations.some((r) => r.targetId === "biz_free")).toBe(false);
  });

  it("子の無いオブジェクトは確認なしで消える", () => {
    act(() => void st().dispatch((m) => addElement(m, { kind: "activity", name: "子なしの作業", id: "act_leaf" })));
    renderBoth();
    select("作業 子なしの作業");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(st().model.elements.some((e) => e.id === "act_leaf")).toBe(false);
  });

  it("業務に子 (活動・作業) があれば確認を出し、件数と、消える・残るものを書く。キャンセルすれば何も消えない", () => {
    renderBoth();
    select("業務 滞在中の対応");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const d = within(dialog()!);
    expect(d.getByText(/活動 3 件: 一緒に削除されます/)).toBeDefined();
    expect(d.getByText(/作業 \d+ 件: 削除されず残ります \(業務に属さない作業になります\)/)).toBeDefined();
    const before = st().model;
    fireEvent.click(d.getByRole("button", { name: "キャンセル" }));
    expect(dialog()).toBeNull();
    expect(st().model).toBe(before);
    // 削除する
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.click(within(dialog()!).getByRole("button", { name: "削除する" }));
    expect(st().model.elements.some((e) => e.id === "biz_stay")).toBe(false);
    // 作業は残り、業務に属さない作業の区画に出る
    expect(st().model.elements.some((e) => e.id === "act_room_request")).toBe(true);
  });

  it("登場人物を消すときは、担当している業務・作業が残ること (主担当が外れること) を書く", () => {
    renderBoth();
    const businesses = st().model.elements.filter((e) => e.kind === "business").length;
    select("登場人物 フロント担当");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const d = within(dialog()!);
    expect(d.getByText(/業務 3 件: 削除されず残ります \(主担当が外れます/)).toBeDefined();
    expect(d.getByText(/作業 \d+ 件: 削除されず残ります \(担当が外れます\)/)).toBeDefined();
    fireEvent.click(d.getByRole("button", { name: "削除する" }));
    expect(st().model.elements.some((e) => e.id === "actor_front")).toBe(false);
    expect(st().model.elements.filter((e) => e.kind === "business")).toHaveLength(businesses);
  });

  it("活動を消すときは、作業が業務に直接属する作業に戻ることを書く", () => {
    renderBoth();
    select("活動 飲食提供");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    // ほかの活動が残る業務では、戻った作業が業務直下と活動の混在になることを添える
    expect(within(dialog()!).getByText(/作業 1 件: 削除されず残ります \(業務に直接属する作業に戻ります \(この業務にはほかの活動があるので、どれかの活動へ移してください\)\)/)).toBeDefined();
  });

  it("業務の最後の活動を消すときは、注記なしで業務に戻ると書く", () => {
    act(() => {
      st().dispatch((m) => removeElement(m, { id: "buc_room_care" }));
      st().dispatch((m) => removeElement(m, { id: "buc_extra_charge" }));
    });
    renderBoth();
    select("活動 飲食提供");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const text = within(dialog()!).getByText(/作業 1 件: 削除されず残ります/).textContent!;
    expect(text).toContain("業務に直接属する作業に戻ります");
    expect(text).not.toContain("ほかの活動");
  });

  it("簡易モードのボードで直せない種類 (システム・帳票など) は、簡易モードでは名前・説明などだけ。削除・関係の編集は出さず、詳細で直すよう案内する", () => {
    renderBoth();
    for (const id of ["sys_pms", "ldg_guest_register"]) {
      const el = st().model.elements.find((e) => e.id === id);
      expect(el).toBeDefined();
      act(() => st().select({ type: "element", id }));
      expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
      expect(screen.queryByLabelText("関係を追加")).toBeNull();
      expect(screen.getByText(/分析（詳細）で直せます/)).toBeDefined();
    }
    expect(st().model.elements.some((e) => e.id === "sys_pms")).toBe(true);
  });

  it("簡易モードでは、アクター・外部アクターの種別を「登場人物」「外部の登場人物」と呼ぶ。詳細では今までどおり", () => {
    const { unmount } = renderBoth();
    select("登場人物 フロント担当");
    const editor = screen.getByTestId("element-editor");
    expect(within(editor).getByText("登場人物", { selector: ".kind-line" })).toBeDefined();
    // 関係の一覧の種別チップも揃える (担当する作業 ← 外部の登場人物)
    select("作業 本人確認をする");
    expect(within(screen.getByTestId("element-editor")).getByText("外部の登場人物")).toBeDefined();
    unmount();
    act(() => st().setMode("analysis"));
    act(() => st().select({ type: "element", id: "actor_front" }));
    render(<PropertyPanel />);
    expect(screen.getByText("アクター", { selector: ".kind-line" })).toBeDefined();
  });

  it("主担当の結び付きを外すとき、業務に子があれば確認を出す", () => {
    renderBoth();
    select("業務 滞在中の対応");
    fireEvent.click(screen.getByRole("button", { name: /^関係「主担当 フロント担当」を削除$/ }));
    const d = within(screen.getByRole("dialog", { name: "主担当を外す確認" }));
    expect(d.getByText(/活動 3 件: 削除されず残ります \(業務ごと残り、「担当が決まっていない業務」に移ります\)/)).toBeDefined();
    fireEvent.click(d.getByRole("button", { name: "キャンセル" }));
    expect(st().model.relations.some((r) => r.kind === "actorBusiness" && r.targetId === "biz_stay")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^関係「主担当 フロント担当」を削除$/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "主担当を外す確認" })).getByRole("button", { name: "外す" }));
    expect(st().model.relations.some((r) => r.kind === "actorBusiness" && r.targetId === "biz_stay")).toBe(false);
    // 外すと、担当なしの区画に出る
    expect(st().model.elements.some((e) => e.id === "biz_stay")).toBe(true);
  });

  it("Delete キーは簡易モードでは何も消さない (確認を通さない削除経路は無い)", () => {
    renderBoth();
    select("業務 滞在中の対応");
    const before = st().model;
    handleKeyDown(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(st().model).toBe(before);
  });

  it("削除したあと、選択は外れてボードから消える", () => {
    renderBoth();
    select("作業 鍵を渡す");
    act(() => void st().dispatch((m) => removeElement(m, { id: "act_hand_key" })));
    expect(selectedId()).toBeNull();
    expect(screen.queryByRole("button", { name: /^作業 鍵を渡す/ })).toBeNull();
  });
});

describe("ツールバー", () => {
  it("簡易モードではボードの選択肢は簡易ボードの 3 枚だけで、ボードの追加・名前変更・削除は出さない。詳細・設計ではワークフローを出さない", () => {
    render(<Toolbar />);
    const options = () => within(screen.getByLabelText("ボード")).getAllByRole("option").map((o) => o.textContent);
    expect(options()).toEqual(["ワークフロー", "システム操作", "情報と状態"]);
    expect(screen.queryByRole("button", { name: "＋ボード" })).toBeNull();
    expect(screen.queryByRole("button", { name: "名前変更" })).toBeNull();
    act(() => st().setMode("analysis"));
    expect(options()).not.toContain("ワークフロー");
    expect(options()).not.toContain("システム操作");
    // サンプルには同じ名前の自由ボード「情報と状態」があるので、簡易ボードかどうかは値 (id) で見る
    const values = () => within(screen.getByLabelText("ボード")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(values().some((v) => v.startsWith("simple:"))).toBe(false);
    act(() => st().enterDesign("sys_pms"));
    expect(options()).not.toContain("ワークフロー");
    expect(options()).not.toContain("システム操作");
    expect(values().some((v) => v.startsWith("simple:"))).toBe(false);
  });

  it("モードのメニューで簡易に切り替えると、ワークフローが開く", () => {
    act(() => st().setMode("analysis"));
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /^モード/ }));
    fireEvent.click(within(screen.getByRole("menu", { name: "モード" })).getByRole("menuitemradio", { name: "分析（簡易）" }));
    expect(st().ui.mode).toBe("analysisSimple");
    expect(st().ui.currentBoardId).toBe("simple:workflow");
  });
});

describe("片付けと確認ダイアログ", () => {
  it("canvasApi.focus はボードを出している間だけ登録され、片付けで外れる。呼ぶと該当の要素へスクロールする", () => {
    const { unmount } = render(<WorkflowBoard />);
    expect(canvasApi.focus).toBeDefined();
    const target = document.querySelector('[data-workflow-el="act_hand_key"]') as HTMLElement;
    let scrolled = false;
    target.scrollIntoView = () => {
      scrolled = true;
    };
    canvasApi.focus!("act_hand_key");
    expect(scrolled).toBe(true);
    unmount();
    expect(canvasApi.focus).toBeUndefined();
  });

  it("確認ダイアログは、見出し付きの区切り (detailGroups) を、箇条書きとは別の見出しで出す", () => {
    render(<ConfirmDialog title="削除の確認" message="m" details={["活動 3 件: 一緒に削除されます"]} detailGroups={[{ title: "消える設計データ", items: ["設計 A"] }]} onConfirm={() => {}} onCancel={() => {}} />);
    const dialog = within(screen.getByRole("dialog", { name: "削除の確認" }));
    expect(dialog.getByRole("heading", { name: "消える設計データ" })).toBeDefined();
    expect(dialog.getByText("設計 A")).toBeDefined();
    expect(dialog.getByText("活動 3 件: 一緒に削除されます")).toBeDefined();
  });

  it("既定の活動 (業務に付く内部の枠) を選んでも、「詳細で直せます」の案内は出さない", () => {
    render(<PropertyPanel />);
    act(() => st().select({ type: "element", id: "buc_default_stay" }));
    expect(screen.queryByText(/分析（詳細）で直せます/)).toBeNull();
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
  });
});

describe("トレース表の「移動」", () => {
  const moveLabel = (layer: string) => `固定ボード「${layer}」へ移る`;
  const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

  it("簡易モード (ワークフロー): 登場人物〜作業の行には「移動」が無く、操作・画面・条件・情報・状態・バリエーションの行には、そのレイヤーを見る簡易ボードへ移る「移動」がある。固定ボードへは移らない。行のセルは残る", () => {
    act(() => st().select({ type: "element", id: "act_room_request" }));
    const { unmount } = render(<PropertyPanel />);
    for (const layer of ["登場人物", "業務", "活動", "作業"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${layer}を.*ボードで見る`) })).toBeNull();
      expect(screen.getByRole("rowheader", { name: new RegExp(layer) })).toBeDefined();
    }
    for (const [layer, board] of [["操作", "システム操作"], ["画面", "システム操作"], ["条件", "システム操作"], ["情報", "情報と状態"], ["状態", "情報と状態"], ["バリエーション", "情報と状態"]] as const) {
      expect(screen.getByRole("button", { name: `${layer}を${board}ボードで見る` })).toBeDefined();
      expect(screen.queryByRole("button", { name: moveLabel(layer) })).toBeNull();
    }
    // ボタンの無い行も、要素と「移動」の 2 つのセル (cell。レイヤー名は rowheader) を持つ (列が崩れない)
    expect(rows().every((r) => within(r).getAllByRole("cell").length === 2)).toBe(true);
    // 要素を押して選ぶ動きは残る
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: /フロント担当/ }));
    expect(selectedId()).toBe("actor_front");
    unmount();
    // 簡易ボードに対応しない非機能要件の「移動」は、今までどおり固定ボードへ移る
    act(() => void st().dispatch((m) => addElement(m, { kind: "nfr", name: "速く応答する", id: "nfr_fast", init: { systemId: "sys_pms" } })));
    act(() => st().select({ type: "element", id: "nfr_fast" }));
    render(<PropertyPanel />);
    expect(screen.getByRole("button", { name: moveLabel("非機能要件") })).toBeDefined();
  });

  it("詳細モードでは、統合された各レイヤーにも「移動」がある", () => {
    act(() => st().setMode("analysis"));
    act(() => st().select({ type: "element", id: "act_room_request" }));
    render(<PropertyPanel />);
    for (const layer of ["登場人物", "業務", "活動", "作業", "操作", "画面", "条件", "状態"]) expect(screen.getByRole("button", { name: moveLabel(layer) })).toBeDefined();
  });

  it("課題の対象の「移動」: 簡易モード (ワークフロー) では、作業にはいまのボードなので無く、操作にはシステム操作ボードへ移る「移動」がある。詳細モードでは固定ボードへ移る", () => {
    act(() => st().select({ type: "element", id: "issue_extra_missing" }));
    const { unmount } = render(<PropertyPanel />);
    expect(screen.queryByRole("button", { name: /^「追加料金を記録する」を.*ボードで見る/ })).toBeNull();
    expect(screen.getByRole("button", { name: "「追加料金を登録する」をシステム操作ボードで見る" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /固定ボードへ移る/ })).toBeNull();
    unmount();
    act(() => st().setMode("analysis"));
    act(() => st().select({ type: "element", id: "issue_extra_missing" }));
    render(<PropertyPanel />);
    expect(screen.getByRole("button", { name: "「追加料金を記録する」の固定ボードへ移る" })).toBeDefined();
    expect(screen.getByRole("button", { name: "「追加料金を登録する」の固定ボードへ移る" })).toBeDefined();
  });

  it("上下に何もつながらないときの案内: 簡易モードでは「そのレイヤーを見るボード」、詳細モードでは「固定ボード」へ移る旨を出す", () => {
    act(() => void st().dispatch((m) => addElement(m, { kind: "actor", name: "ひとり", id: "actor_alone" })));
    act(() => st().select({ type: "element", id: "actor_alone" }));
    const { unmount } = render(<PropertyPanel />);
    expect(screen.getByText(/上下のレイヤーにつながる要素はありません/)).toBeDefined();
    expect(screen.getByText(/「移動」でそのレイヤーを見るボードへ移って結べます/)).toBeDefined();
    expect(screen.queryByText(/「移動」でそのレイヤーの固定ボードへ移って結べます/)).toBeNull();
    unmount();
    act(() => st().setMode("analysis"));
    act(() => st().select({ type: "element", id: "actor_alone" }));
    render(<PropertyPanel />);
    expect(screen.getByText(/「移動」でそのレイヤーの固定ボードへ移って結べます/)).toBeDefined();
  });
});

describe("外部の登場人物の行: 担当する作業のある業務", () => {
  const assignedActs = (actorId: string) => st().model.relations.filter((r) => r.kind === "actorActivity" && r.sourceId === actorId).map((r) => r.targetId);

  it("外部の登場人物の行に、担当する作業のある業務の枠が出て、中にはその人が担当する作業だけが並ぶ。担当の表示はこれまでどおり", () => {
    render(<WorkflowBoard />);
    const guest = lane("宿泊客");
    const mine = assignedActs("ext_guest");
    expect(mine.length).toBeGreaterThan(1);
    const frames = within(guest).getAllByRole("region", { name: /^業務 / });
    expect(frames.length).toBeGreaterThan(1);
    const shownActs = [...guest.querySelectorAll("[data-workflow-el^='act_']")].map((e) => e.getAttribute("data-workflow-el"));
    expect(new Set(shownActs)).toEqual(new Set(mine));
    // 担当でない作業は出ない (予約受付の「予約を受け付ける」は旅行会社の担当で、宿泊客は予約内容の確認をしない)
    expect(within(guest).queryByRole("button", { name: /^作業 予約内容を確認する/ })).toBeNull();
    expect(within(guest).getByRole("button", { name: /^作業 本人確認をする \(担当: フロント担当、宿泊客\)/ })).toBeDefined();
  });

  it("枠には「担当する作業 (主担当: ○○)」を添え、主担当のいない業務は「主担当は決まっていません」。破線の枠で、主担当の行の枠と見分ける", () => {
    act(() => void st().dispatch((m) => removeRelationOf(m, "actor_front", "biz_checkin")));
    render(<WorkflowBoard />);
    const guest = lane("宿泊客");
    const checkin = within(guest).getByRole("region", { name: /^業務 チェックイン/ });
    expect(within(checkin).getByText("担当する作業 (主担当は決まっていません)")).toBeDefined();
    expect(checkin.classList.contains("is-assigned")).toBe(true);
    const reservation = within(guest).getByRole("region", { name: /^業務 予約受付/ });
    expect(within(reservation).getByText("担当する作業 (主担当: 予約担当)")).toBeDefined();
    // 主担当の行の同じ業務の枠は、これまでどおり (実線・担当でない作業も出る)
    const own = within(lane("予約担当")).getByRole("region", { name: /^業務 予約受付/ });
    expect(own.classList.contains("is-assigned")).toBe(false);
    expect(within(own).getByRole("button", { name: /^作業 予約内容を確認する/ })).toBeDefined();
    // 主担当のいない業務は、「担当が決まっていない業務」の区画にも今までどおり出る
    expect(within(screen.getByRole("region", { name: "担当が決まっていない業務" })).getByRole("button", { name: "業務 チェックイン" })).toBeDefined();
  });

  it("同じ業務はどの行でも同じ業務。選択は全行で共通", () => {
    render(<WorkflowBoard />);
    fireEvent.click(within(lane("宿泊客")).getByRole("button", { name: /^業務 予約受付/ }));
    expect(selectedId()).toBe("biz_reservation");
    expect(within(lane("予約担当")).getByRole("button", { name: /^業務 予約受付/ }).getAttribute("aria-current")).toBe("true");
  });

  it("活動の入れ子: 活動のある業務は、担当する作業のある活動の枠だけが入る。業務に属さない作業を担当していても、行に「業務に属さない作業」で出る", () => {
    act(() => {
      st().dispatch((m) => addRelationOf(m, "ext_guest", "act_room_service"));
      st().dispatch((m) => addElement(m, { kind: "activity", name: "迷子の作業", id: "act_lost" }));
      st().dispatch((m) => addRelationOf(m, "ext_guest", "act_lost"));
    });
    render(<WorkflowBoard />);
    const stay = within(lane("宿泊客")).getByRole("region", { name: /^業務 滞在中の対応/ });
    expect(within(stay).getByRole("region", { name: "活動 飲食提供 (宿泊客 が担当する作業)" })).toBeDefined();
    expect(within(stay).queryByRole("region", { name: /^活動 客室対応/ })).toBeNull();
    const orphan = within(lane("宿泊客")).getByRole("region", { name: /^業務に属さない作業/ });
    expect(within(orphan).getByRole("button", { name: /^作業 迷子の作業/ })).toBeDefined();
    // 社内の登場人物の行には出ない
    expect(within(lane("フロント担当")).queryByRole("region", { name: /^業務に属さない作業/ })).toBeNull();
  });

  it("担当する作業が無い外部の登場人物は、枠を出さず、案内を出す。社内の登場人物の行は、主担当の業務だけ (担当の作業だけの社内の人の行は空のまま)", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "externalActor", name: "新しい取引先", id: "ext_new" }));
      st().dispatch((m) => addElement(m, { kind: "actor", name: "手伝いの人", id: "actor_helper" }));
      st().dispatch((m) => addRelationOf(m, "actor_helper", "act_hand_key"));
    });
    render(<WorkflowBoard />);
    expect(within(lane("新しい取引先")).queryAllByRole("region")).toHaveLength(0);
    expect(within(lane("新しい取引先")).getByText("担当する作業はまだありません")).toBeDefined();
    expect(within(lane("手伝いの人")).queryAllByRole("region")).toHaveLength(0);
    expect(within(lane("手伝いの人")).getByText("業務はまだありません")).toBeDefined();
  });
});

describe("外部の登場人物の行から作業を足す", () => {
  it("枠の「＋作業」は、その業務に作業を作って、その外部の登場人物を担当に結ぶ (1 件の履歴で undo できる)。活動のある業務の枠には出さず、活動の枠から足す。「＋業務」「＋活動」は出さない", () => {
    renderBoth();
    const guest = lane("宿泊客");
    expect(within(guest).queryByRole("button", { name: /に業務を足す|に活動を足す/ })).toBeNull();
    const checkin = within(guest).getByRole("region", { name: /^業務 チェックイン/ });
    const past = st().history.past.length;
    fireEvent.click(within(checkin).getByRole("button", { name: "「チェックイン」に宿泊客が担当する作業を足す" }));
    const added = st().model.elements.find((e) => e.kind === "activity" && e.name === "新しい作業")!;
    expect(st().model.relations.some((r) => r.kind === "actorActivity" && r.sourceId === "ext_guest" && r.targetId === added.id)).toBe(true);
    expect((added as { bucId: string | null }).bucId).toBe("buc_default_checkin");
    expect(selectedId()).toBe(added.id);
    expect(document.activeElement).toBe(screen.getByLabelText("名前"));
    expect(st().history.past.length).toBe(past + 1);
    // 足した作業は、外部の登場人物の行に出る
    expect(within(lane("宿泊客")).getByRole("button", { name: /^作業 新しい作業 \(担当: 宿泊客\)/ })).toBeDefined();
    act(() => st().undo());
    expect(st().model.elements.some((e) => e.id === added.id)).toBe(false);
    expect(st().model.relations.some((r) => r.sourceId === "ext_guest" && r.targetId === added.id)).toBe(false);
    // 活動のある業務の枠 (滞在中の対応) には、業務への「＋作業」は出ない
    act(() => void st().dispatch((m) => addRelationOf(m, "ext_guest", "act_room_service")));
    const stay = within(lane("宿泊客")).getByRole("region", { name: /^業務 滞在中の対応/ });
    expect(within(stay).queryByRole("button", { name: /「滞在中の対応」に.*作業を足す/ })).toBeNull();
    fireEvent.click(within(stay).getByRole("button", { name: "「飲食提供」に宿泊客が担当する作業を足す" }));
    const inBuc = st().model.elements.find((e) => e.kind === "activity" && e.name === "新しい作業") as { bucId: string | null; id: string };
    expect(inBuc.bucId).toBe("buc_dining");
    expect(st().model.relations.some((r) => r.kind === "actorActivity" && r.sourceId === "ext_guest" && r.targetId === inBuc.id)).toBe(true);
  });

  it("カードの「＋作業 (業務・活動を選ぶ)」で、担当の作業がまだ無くても、選んだ業務・活動に作業を作って担当に結べる。業務が 1 つも無ければ出さず、案内を出す", () => {
    act(() => void st().dispatch((m) => addElement(m, { kind: "externalActor", name: "新しい取引先", id: "ext_new" })));
    renderBoth();
    const select = within(lane("新しい取引先")).getByRole("combobox", { name: "「新しい取引先」に作業を足す (業務・活動を選ぶ)" });
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("＋作業 (業務・活動を選ぶ)");
    expect(options).toContain("チェックイン");
    expect(options).toContain("滞在中の対応 / 飲食提供");
    // 活動のある業務そのものは足し先に出ない (活動の中に足す)
    expect(options).not.toContain("滞在中の対応");
    fireEvent.change(select, { target: { value: "buc_dining" } });
    const added = st().model.elements.find((e) => e.kind === "activity" && e.name === "新しい作業")!;
    expect(st().model.relations.some((r) => r.kind === "actorActivity" && r.sourceId === "ext_new" && r.targetId === added.id)).toBe(true);
    expect(within(lane("新しい取引先")).getByRole("region", { name: /^業務 滞在中の対応/ })).toBeDefined();
  });

  it("業務が 1 つも無いと、セレクトは出さず「先に業務を作ってください」と案内する。閲覧専用では、セレクトも「＋作業」も出さない", () => {
    act(() => {
      useUntieStore.setState((s) => ({ model: { ...s.model, elements: s.model.elements.filter((e) => !["business", "buc", "activity"].includes(e.kind)), relations: [] } }));
    });
    const { unmount } = render(<WorkflowBoard />);
    expect(within(lane("宿泊客")).queryByRole("combobox")).toBeNull();
    expect(within(lane("宿泊客")).getByText("作業を足すには、先に業務を作ってください")).toBeDefined();
    unmount();
    resetStore();
    act(() => st().setMode("analysisSimple"));
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    render(<WorkflowBoard />);
    expect(within(lane("宿泊客")).queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /に作業を足す/ })).toBeNull();
  });
});

const addRelationOf = (m: UntieModel, sourceId: string, targetId: string): CommandResult => addRelation(m, { sourceId, targetId });
const removeRelationOf = (m: UntieModel, sourceId: string, targetId: string): CommandResult => {
  const rel = m.relations.find((r) => r.sourceId === sourceId && r.targetId === targetId);
  return rel ? removeRelation(m, { id: rel.id }) : { ok: false, reason: "関係が無い" };
};

describe("外部の登場人物の行: 足した直後のスクロール・読み上げ名・足せない理由", () => {
  it("足した直後は、押した行の中の要素へスクロールする (主担当の行の同じ業務・作業へは飛ばない)", () => {
    vi.useFakeTimers();
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      renderBoth();
      const guest = lane("宿泊客");
      const checkin = within(guest).getByRole("region", { name: /^業務 チェックイン/ });
      fireEvent.click(within(checkin).getByRole("button", { name: "「チェックイン」に宿泊客が担当する作業を足す" }));
      vi.advanceTimersByTime(100);
      expect(scrolled.length).toBeGreaterThan(0);
      const added = st().model.elements.find((e) => e.kind === "activity" && e.name === "新しい作業")!;
      const target = scrolled[scrolled.length - 1]!;
      expect(target.getAttribute("data-workflow-el")).toBe(added.id);
      expect(target.closest("[data-workflow-lane]")?.getAttribute("data-workflow-lane")).toBe("ext_guest");
      // 主担当が複数いる業務でも、押した行の中へ
      scrolled.length = 0;
      act(() => void st().dispatch((m) => addRelation(m, { sourceId: "actor_manager", targetId: "biz_checkin" })));
      fireEvent.click(within(within(lane("支配人")).getByRole("region", { name: /^業務 チェックイン/ })).getByRole("button", { name: "「チェックイン」に作業を足す" }));
      vi.advanceTimersByTime(100);
      expect(scrolled[scrolled.length - 1]!.closest("[data-workflow-lane]")?.getAttribute("data-workflow-lane")).toBe("actor_manager");
    } finally {
      Element.prototype.scrollIntoView = original;
      vi.useRealTimers();
    }
  });

  it("担当の枠と主担当の枠は、読み上げ名で区別できる (担当に結ばれることが伝わる)。活動の枠も同じ", () => {
    act(() => void st().dispatch((m) => addRelation(m, { sourceId: "ext_guest", targetId: "act_room_service" })));
    render(<WorkflowBoard />);
    expect(within(lane("フロント担当")).getByRole("region", { name: "業務 チェックイン (フロント担当 の行)" })).toBeDefined();
    expect(within(lane("宿泊客")).getByRole("region", { name: "業務 チェックイン (宿泊客 が担当する作業)" })).toBeDefined();
    expect(within(lane("宿泊客")).getByRole("button", { name: "「チェックイン」に宿泊客が担当する作業を足す" })).toBeDefined();
    expect(within(lane("宿泊客")).getByRole("region", { name: "活動 飲食提供 (宿泊客 が担当する作業)" })).toBeDefined();
    expect(within(lane("宿泊客")).getByRole("button", { name: "「飲食提供」に宿泊客が担当する作業を足す" })).toBeDefined();
    expect(within(lane("フロント担当")).getByRole("button", { name: "「チェックイン」に作業を足す" })).toBeDefined();
  });

  it("活動のある業務の直下の作業だけを担当しているとき、担当の枠に足せない理由 (活動に足す・カードのセレクト) を出す。読み取り専用では出さない", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "activity", name: "直下の作業", id: "act_direct", init: { bucId: "buc_default_stay" } }));
      st().dispatch((m) => addRelation(m, { sourceId: "ext_guest", targetId: "act_direct" }));
    });
    const { unmount } = render(<WorkflowBoard />);
    const stay = within(lane("宿泊客")).getByRole("region", { name: /^業務 滞在中の対応/ });
    expect(within(stay).getByText(/この業務には活動があるので、作業は活動に足します。カードの「＋作業 \(業務・活動を選ぶ\)」から活動を選んでください/)).toBeDefined();
    expect(within(stay).queryByRole("button", { name: /に.*作業を足す/ })).toBeNull();
    unmount();
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    render(<WorkflowBoard />);
    expect(within(lane("宿泊客")).getByRole("region", { name: /^業務 滞在中の対応/ }).textContent).not.toContain("活動に足します");
  });

  it("「担当が決まっていない業務」の区画に、外部の登場人物が担当する作業はその人の行にも出る旨を添える", () => {
    act(() => void st().dispatch((m) => removeRelationOf(m, "actor_front", "biz_checkin")));
    render(<WorkflowBoard />);
    expect(within(screen.getByRole("region", { name: "担当が決まっていない業務" })).getByText(/外部の登場人物が担当する作業は、その人の行にも出ます/)).toBeDefined();
  });

  it("既定の活動が 2 つある業務の作業を外部の登場人物が担当しているとき、行の「業務に属さない作業」と全体の区画に 1 回ずつ出る", () => {
    act(() => {
      useUntieStore.setState((s) => ({ model: { ...s.model, elements: [...s.model.elements, { id: "buc_default_twin", kind: "buc", name: "二つ目", businessId: "biz_checkin", isDefault: true }, { id: "act_twin", kind: "activity", name: "二つ目の作業", bucId: "buc_default_twin" }] as typeof s.model.elements, relations: [...s.model.relations, { id: "rel_twin", kind: "actorActivity", sourceId: "ext_guest", targetId: "act_twin" }] as typeof s.model.relations } }));
    });
    render(<WorkflowBoard />);
    const buttons = screen.getAllByRole("button", { name: /^作業 二つ目の作業/ });
    expect(buttons).toHaveLength(2);
    expect(within(lane("宿泊客")).getAllByRole("button", { name: /^作業 二つ目の作業/ })).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "業務に属さない作業" })).getAllByRole("button", { name: /^作業 二つ目の作業/ })).toHaveLength(1);
  });
});
