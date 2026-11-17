import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { addElement, addRelation, removeElement, removeRelation } from "@untie/core/model/commands";
import type { Activity } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { handleKeyDown } from "../useKeyboard";
import { resetStore } from "../../test/utils";
import { PropertyPanel } from "../PropertyPanel";
import { buildWorkflow } from "@untie/core/model/workflow";
import { Pick, WorkflowBoard } from "../workflow/WorkflowBoard";
import { Toolbar } from "../Toolbar";
import { ConfirmDialog } from "../ConfirmDialog";
import { canvasApi } from "../canvas/canvasApi";
import { NAME_MAX_LENGTH } from "@untie/core/model/limits";

const st = () => useUntieStore.getState();

beforeEach(() => {
  resetStore();
  useUntieStore.setState({ cloud: null });
  act(() => st().setMode("analysisSimple"));
  // 情報整理モードの最初は登場人物 (固定ボード)。ここでは業務一覧を開いて確かめる
  act(() => st().setCurrentBoard("simple:workflow"));
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

describe("業務一覧ボードの描画", () => {
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
    expect(names.slice(0, 2)).toEqual(["作業 到着を確認する (担当: フロント担当)", "作業 本人確認をする (担当: フロント担当)"]);
    // 作業の行には担当の名前を添える
    expect(within(checkin).getByRole("button", { name: /^作業 本人確認をする/ }).textContent).toContain("担当: フロント担当");
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
    // 外部の登場人物は行ではなく、「外部の登場人物とシステム」の区画の列。業務を足すボタンは無い
    expect(screen.queryByRole("region", { name: "登場人物 宿泊客 の行" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "外部の登場人物 宿泊客 の列" })).queryByRole("button", { name: /に業務を足す/ })).toBeNull();
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

  it("情報整理モードのボードで直せない種類 (システム・帳票など) は、情報整理モードでは名前・説明などだけ。削除・関係の編集は出さず、詳細調整で直すよう案内する", () => {
    renderBoth();
    for (const id of ["ldg_guest_register"]) {
      const el = st().model.elements.find((e) => e.id === id);
      expect(el).toBeDefined();
      act(() => st().select({ type: "element", id }));
      expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
      expect(screen.queryByLabelText("関係を追加")).toBeNull();
      expect(screen.getByText(/詳細調整で直せます/)).toBeDefined();
    }
    expect(st().model.elements.some((e) => e.id === "sys_pms")).toBe(true);
  });

  it("情報整理モードでは、アクター・外部アクターの種別を「登場人物」「外部の登場人物」と呼ぶ。詳細調整では今までどおり", () => {
    const { unmount } = renderBoth();
    select("登場人物 フロント担当");
    const editor = screen.getByTestId("element-editor");
    expect(within(editor).getByText("登場人物", { selector: ".kind-line" })).toBeDefined();
    select("外部の登場人物 宿泊客");
    expect(within(screen.getByTestId("element-editor")).getByText("外部の登場人物", { selector: ".kind-line" })).toBeDefined();
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

  it("Delete キーは情報整理モードでは何も消さない (確認を通さない削除経路は無い)", () => {
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
  it("情報整理モードではボードの選択肢は登場人物と情報整理のボードの 4 枚と分析ボードで、ボードの追加・名前変更・削除は出さない。詳細調整・設計では業務一覧を出さない", () => {
    render(<Toolbar />);
    const options = () => within(screen.getByLabelText("ボード")).getAllByRole("option").map((o) => o.textContent);
    expect(options()).toEqual(["登場人物", "業務一覧", "業務フロー", "システム操作", "情報と状態", "課題の分布", "担当別の作業一覧", "情報の所在"]);
    // 「ボード」のグループの先頭が登場人物 (固定ボード)。ほかの固定ボードは出さない
    const group = screen.getByLabelText("ボード").querySelector('optgroup[label="ボード"]')!;
    expect(Array.from(group.querySelectorAll("option")).map((o) => o.value)).toEqual(["fixed:actor", "simple:workflow", "simple:flow", "simple:operation", "simple:information"]);
    expect(screen.queryByRole("option", { name: "業務" })).toBeNull();
    expect(screen.queryByRole("button", { name: "＋ボード" })).toBeNull();
    expect(screen.queryByRole("button", { name: "名前変更" })).toBeNull();
    act(() => st().setMode("analysis"));
    expect(options()).not.toContain("業務一覧");
    expect(options()).not.toContain("システム操作");
    // サンプルには同じ名前の自由ボード「情報と状態」があるので、情報整理のボードかどうかは値 (id) で見る
    const values = () => within(screen.getByLabelText("ボード")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(values().some((v) => v.startsWith("simple:"))).toBe(false);
    act(() => st().enterDesign("sys_pms"));
    expect(options()).not.toContain("業務一覧");
    expect(options()).not.toContain("システム操作");
    expect(values().some((v) => v.startsWith("simple:"))).toBe(false);
  });

  it("モードの select で情報整理に切り替えると、登場人物が開く。ボードの select も登場人物を選んでいる", () => {
    act(() => st().setMode("analysis"));
    render(<Toolbar />);
    fireEvent.change(screen.getByLabelText("モード"), { target: { value: "analysisSimple" } });
    expect(st().ui.mode).toBe("analysisSimple");
    expect(st().ui.currentBoardId).toBe("fixed:actor");
    expect((screen.getByLabelText("ボード") as HTMLSelectElement).value).toBe("fixed:actor");
  });

  it("ボードの select で登場人物を選んでも、情報整理モードのまま。ほかの固定ボードは詳細調整のボードの選択肢にある", () => {
    render(<Toolbar />);
    fireEvent.change(screen.getByLabelText("ボード"), { target: { value: "fixed:actor" } });
    expect(st().ui.mode).toBe("analysisSimple");
    expect(st().ui.currentBoardId).toBe("fixed:actor");
    expect(screen.queryByRole("option", { name: "操作" })).toBeNull();
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

  it("既定の活動 (業務に付く内部の枠) を選んでも、「詳細調整で直せます」の案内は出さない", () => {
    render(<PropertyPanel />);
    act(() => st().select({ type: "element", id: "buc_default_stay" }));
    expect(screen.queryByText(/詳細調整で直せます/)).toBeNull();
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
  });
});

describe("トレース表の「移動」", () => {
  const moveLabel = (layer: string) => `固定ボード「${layer}」へ移る`;
  const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

  it("情報整理モード (業務一覧): 登場人物〜作業の行には「移動」が無く、操作・画面・条件・情報・状態・バリエーションの行には、そのレイヤーを見る情報整理のボードへ移る「移動」がある。固定ボードへは移らない。行のセルは残る", () => {
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
    // 情報整理のボードに対応しない非機能要件の「移動」は、今までどおり固定ボードへ移る
    act(() => void st().dispatch((m) => addElement(m, { kind: "nfr", name: "速く応答する", id: "nfr_fast", init: { systemId: "sys_pms" } })));
    act(() => st().select({ type: "element", id: "nfr_fast" }));
    render(<PropertyPanel />);
    expect(screen.getByRole("button", { name: moveLabel("非機能要件") })).toBeDefined();
  });

  it("詳細調整モードでは、統合された各レイヤーにも「移動」がある", () => {
    act(() => st().setMode("analysis"));
    act(() => st().select({ type: "element", id: "act_room_request" }));
    render(<PropertyPanel />);
    for (const layer of ["登場人物", "業務", "活動", "作業", "操作", "画面", "条件", "状態"]) expect(screen.getByRole("button", { name: moveLabel(layer) })).toBeDefined();
  });

  it("課題の対象の「移動」: 情報整理モード (業務一覧) では、作業にはいまのボードなので無く、操作にはシステム操作ボードへ移る「移動」がある。詳細調整モードでは固定ボードへ移る", () => {
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

  it("上下に何もつながらないときの案内: 情報整理モードでは「そのレイヤーを見るボード」、詳細調整モードでは「固定ボード」へ移る旨を出す", () => {
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

describe("外部の登場人物とシステムの区画", () => {
  const outsider = (kind: string, name: string) => screen.getByRole("region", { name: `${kind} ${name} の列` });
  const sectionNames = () => Array.from(document.querySelectorAll(".wf-lane, .wf-section")).map((e) => e.getAttribute("aria-label") ?? "");

  it("社内の登場人物の行がすべて先、そのあとに「外部の登場人物とシステム」の区画。列は外部の登場人物が先、続けてシステム", () => {
    render(<WorkflowBoard />);
    const names = sectionNames();
    const idx = names.indexOf("外部の登場人物とシステム");
    expect(idx).toBeGreaterThan(0);
    expect(names.slice(0, idx).every((n) => /^登場人物 .* の行$/.test(n))).toBe(true);
    const cols = Array.from(document.querySelectorAll(".wf-outsider")).map((e) => e.getAttribute("aria-label"));
    const firstSystem = cols.findIndex((n) => n!.startsWith("システム"));
    expect(cols.slice(0, firstSystem).every((n) => n!.startsWith("外部の登場人物"))).toBe(true);
    expect(cols.slice(firstSystem).every((n) => n!.startsWith("システム"))).toBe(true);
    expect(screen.queryByRole("region", { name: /^帳票/ })).toBeNull();
    // 注記は区画の説明文 1 か所だけ
    expect(screen.getAllByText(/業務の主担当にも、作業の担当にもなれません/)).toHaveLength(1);
  });

  it("列には、カードと、発生させるイベントの縦の一覧 (1 行 1 イベント)。イベントが無ければ「イベントはまだありません」", () => {
    render(<WorkflowBoard />);
    const guest = outsider("外部の登場人物", "宿泊客");
    expect(within(within(guest).getByRole("list", { name: "発生させるイベントの一覧" })).getAllByRole("listitem").map((li) => li.textContent)).toContain("イベント宿泊の申込が届いた");
    expect(screen.queryByText(/発生させるイベント: /)).toBeNull();
    act(() => void st().dispatch((m) => addElement(m, { kind: "system", name: "空のシステム", id: "sys_empty" })));
    expect(within(outsider("システム", "空のシステム")).getByText("イベントはまだありません")).toBeDefined();
  });

  it("「＋イベント」: 外部の登場人物・システムそれぞれで、発生元に結んだイベントを足し (履歴 1 件)、選び、その列の中で名前欄へフォーカスする", () => {
    renderBoth();
    for (const [kind, name, id, rel] of [["外部の登場人物", "宿泊客", "ext_guest", "externalActorEvent"], ["システム", "宿泊管理システム", "sys_pms", "systemEvent"]] as const) {
      const before = st().history.past.length;
      fireEvent.click(within(outsider(kind, name)).getByRole("button", { name: `「${name}」にイベントを足す` }));
      expect(st().history.past.length).toBe(before + 1);
      const sel = selectedId()!;
      const ev = st().model.elements.find((e) => e.id === sel)!;
      expect(ev).toMatchObject({ kind: "event", name: "新しいイベント" });
      expect(st().model.relations.some((r) => r.kind === rel && r.sourceId === id && r.targetId === sel)).toBe(true);
      expect(within(outsider(kind, name)).getByRole("button", { name: "イベント 新しいイベント" })).toBeDefined();
      expect(document.activeElement).toBe(within(screen.getByTestId("element-editor")).getByLabelText("名前"));
    }
  });

  it("「＋外部の登場人物」「＋システム」で列を足せる", () => {
    render(<WorkflowBoard />);
    fireEvent.click(screen.getByRole("button", { name: "外部の登場人物を足す" }));
    expect(screen.getByRole("region", { name: "外部の登場人物 新しい外部の登場人物 の列" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "システムを足す" }));
    expect(screen.getByRole("region", { name: "システム 新しいシステム の列" })).toBeDefined();
  });

  it("閲覧専用では、足すボタンを出さない。選ぶことはできる", () => {
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    render(<WorkflowBoard />);
    expect(screen.queryByRole("button", { name: /にイベントを足す/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "システムを足す" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "システム 宿泊管理システム" }));
    expect(selectedId()).toBe("sys_pms");
  });

  it("システム・イベントの名前をクリックすると、その場で直せる", () => {
    render(<WorkflowBoard />);
    fireEvent.click(screen.getByRole("button", { name: "システム 宿泊管理システム" }).querySelector(".wf-name")!);
    fireEvent.change(screen.getByLabelText("システムの名前"), { target: { value: "新宿泊システム" } });
    fireEvent.submit(screen.getByLabelText("システムの名前").closest("form")!);
    expect(st().model.elements.find((e) => e.id === "sys_pms")!.name).toBe("新宿泊システム");
    fireEvent.click(screen.getAllByRole("button", { name: "イベント 宿泊の申込が届いた" })[0]!.querySelector(".wf-name")!);
    expect(screen.getByLabelText("イベントの名前")).toBeDefined();
  });

  it("プロパティから、業務一覧ボードで足せるもの (システム・イベント) を消せ、システム・イベントは「詳細調整で直せます」の案内にならない", () => {
    renderBoth();
    fireEvent.click(screen.getByRole("button", { name: "システム 宿泊管理システム" }));
    expect(screen.queryByText(/詳細調整で直せます/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const ok = screen.queryByRole("button", { name: "削除する" });
    if (ok) fireEvent.click(ok);
    expect(st().model.elements.some((e) => e.id === "sys_pms")).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "イベント 宿泊の申込が届いた" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const ok2 = screen.queryByRole("button", { name: "削除する" });
    if (ok2) fireEvent.click(ok2);
    expect(st().model.elements.some((e) => e.id === "ev_stay_requested")).toBe(false);
  });
});

describe("外部の登場人物: 発生させるイベントの編集 (情報整理モード)", () => {
  beforeEach(() => {
    resetStore();
    act(() => st().setMode("analysisSimple"));
    act(() => st().setCurrentBoard("simple:workflow"));
  });

  it("外部の登場人物を選ぶと「発生させるイベント」が出て、足す・外す・新しく作るができる。作成と結び付けは 1 件の履歴", () => {
    act(() => st().select({ type: "element", id: "ext_guest" }));
    render(<PropertyPanel />);
    const section = () => within(screen.getByTestId("external-events-section"));
    expect(section().getByText("宿泊の申込が届いた")).toBeDefined();
    // 外す → 既にあるイベントから足す
    fireEvent.click(section().getByRole("button", { name: "発生させるイベント「宿泊の申込が届いた」を外す" }));
    expect(st().model.relations.some((r) => r.kind === "externalActorEvent" && r.sourceId === "ext_guest")).toBe(false);
    fireEvent.change(section().getByLabelText("発生させるイベントを追加"), { target: { value: "ev_stay_requested" } });
    expect(st().model.relations.some((r) => r.kind === "externalActorEvent" && r.sourceId === "ext_guest" && r.targetId === "ev_stay_requested")).toBe(true);
    // 新しく作る: 作って結び、選ぶ。元に戻すと 1 回で作成も結び付きも戻る
    const before = st().model.elements.length;
    fireEvent.click(section().getByRole("button", { name: "＋新しいイベントを作る" }));
    expect(st().model.elements.length).toBe(before + 1);
    const created = st().model.elements[st().model.elements.length - 1]!;
    expect(created.kind).toBe("event");
    expect(st().ui.selection).toEqual({ type: "element", id: created.id });
    expect(st().model.relations.some((r) => r.kind === "externalActorEvent" && r.sourceId === "ext_guest" && r.targetId === created.id)).toBe(true);
    act(() => st().undo());
    expect(st().model.elements.length).toBe(before);
    expect(st().model.relations.some((r) => r.kind === "externalActorEvent" && r.targetId === created.id)).toBe(false);
  });

  it("社内の登場人物には出ない。閲覧専用では出さない", () => {
    act(() => st().select({ type: "element", id: "actor_front" }));
    const { unmount } = render(<PropertyPanel />);
    expect(screen.queryByTestId("external-events-section")).toBeNull();
    unmount();
  });
});

describe("業務一覧ボード: 作業の担当の見せ方", () => {
  const rel = (kind: string, s: string, t: string) => st().model.relations.find((r) => r.kind === kind && r.sourceId === s && r.targetId === t)!;

  it("作業の担当を外しても、カードは業務の主担当の行の枠に残り、担当の表示だけが変わる。行の決まりを枠に添える", () => {
    render(<WorkflowBoard />);
    const reserve = within(lane("予約担当")).getByRole("region", { name: /^業務 予約受付/ });
    expect(within(reserve).getByText(/行は業務の主担当 \(予約担当\)/)).toBeDefined();
    expect(within(reserve).getByRole("button", { name: "作業 予約内容を確認する (担当: 予約担当)" })).toBeDefined();
    act(() => {
      st().dispatch((m) => removeRelation(m, { id: rel("actorActivity", "actor_reservation", "act_confirm_reservation").id }));
    });
    // 位置は変わらず、担当がいなくなったことが「担当なし」で見える
    const after = within(lane("予約担当")).getByRole("button", { name: "作業 予約内容を確認する (担当なし)" });
    expect(after.textContent).toContain("担当なし");
    expect(after.querySelector(".wf-assignees.is-none")).not.toBeNull();
  });
});

describe("名前をクリックして直す", () => {
  const nameOfCard = (label: string) => screen.getAllByRole("button", { name: new RegExp(`^${label}`) })[0]!.querySelector(".wf-name")!;
  const click = (label: string) => fireEvent.click(nameOfCard(label));
  const nameInput = (kind: string) => screen.getByLabelText(`${kind}の名前`) as HTMLInputElement;

  it("登場人物・業務・活動・作業の名前を押すと、その要素を選んだうえで入力欄になり、Enter (フォームの送信) で確定する", () => {
    renderBoth();
    for (const [label, kind, id, next] of [
      ["登場人物 フロント担当", "登場人物", "actor_front", "受付担当"],
      ["業務 チェックイン", "業務", "biz_checkin", "到着の受付"],
      ["活動 飲食提供", "活動", "buc_dining", "食事の提供"],
      ["作業 鍵を渡す", "作業", "act_hand_key", "鍵とカードを渡す"],
    ] as const) {
      const btn = screen.getAllByRole("button", { name: new RegExp(`^${label}`) })[0]!;
      expect(btn.querySelector(".wf-name")!.getAttribute("title")).toBe("クリックで名前を変える");
      expect(btn.querySelector(".wf-name")!.classList.contains("is-renamable")).toBe(true);
      fireEvent.click(btn.querySelector(".wf-name")!);
      // 選ばれていて、右のプロパティと食い違わない
      expect(selectedId()).toBe(id);
      const input = nameInput(kind);
      expect(document.activeElement).toBe(input);
      expect(input.maxLength).toBe(NAME_MAX_LENGTH);
      fireEvent.change(input, { target: { value: next } });
      fireEvent.submit(input.closest("form")!);
      expect(st().model.elements.find((e) => e.id === id)!.name).toBe(next);
      expect(screen.queryByLabelText(`${kind}の名前`)).toBeNull();
    }
  });

  it("「保存」ボタンでも確定する。Esc では取り消し、モデルは変わらない", () => {
    renderBoth();
    click("業務 チェックイン");
    fireEvent.change(nameInput("業務"), { target: { value: "別の名前" } });
    fireEvent.keyDown(nameInput("業務"), { key: "Escape" });
    expect(screen.queryByLabelText("業務の名前")).toBeNull();
    expect(st().model.elements.find((e) => e.id === "biz_checkin")!.name).toBe("チェックイン");
    click("業務 チェックイン");
    fireEvent.change(nameInput("業務"), { target: { value: "受付業務" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(st().model.elements.find((e) => e.id === "biz_checkin")!.name).toBe("受付業務");
  });

  it("フォーカスが外れたら取り消す (フォーム内の移動では取り消さない)", () => {
    renderBoth();
    click("作業 鍵を渡す");
    const input = nameInput("作業");
    fireEvent.change(input, { target: { value: "書き換え中" } });
    fireEvent.blur(input, { relatedTarget: screen.getByRole("button", { name: "保存" }) });
    expect(screen.queryByLabelText("作業の名前")).not.toBeNull();
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(screen.queryByLabelText("作業の名前")).toBeNull();
    expect(st().model.elements.find((e) => e.id === "act_hand_key")!.name).toBe("鍵を渡す");
  });

  it("名前以外 (種類のラベル・枠の余白) を押したときは、選ぶだけで入力欄にならない。枠の中の入力欄を押しても、枠の選択に壊されない", () => {
    renderBoth();
    const kindLabel = within(screen.getByRole("button", { name: "業務 チェックイン" })).getByText("業務", { selector: ".wf-kind" });
    fireEvent.click(kindLabel);
    expect(selectedId()).toBe("biz_checkin");
    expect(screen.queryByLabelText("業務の名前")).toBeNull();
    click("業務 チェックイン");
    fireEvent.click(nameInput("業務"));
    expect(screen.queryByLabelText("業務の名前")).not.toBeNull();
  });

  it("同じ要素が複数の行に出ても、編集に入るのは押した場所だけ", () => {
    // 同じ作業を別の行 (担当) にも出す: 主担当が複数の業務は 2 つの行に出る
    act(() => {
      st().dispatch((m) => addRelation(m, { sourceId: "actor_manager", targetId: "biz_checkin" }));
    });
    renderBoth();
    const buttons = screen.getAllByRole("button", { name: /^業務 チェックイン/ });
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[1]!.querySelector(".wf-name")!);
    expect(screen.getAllByLabelText("業務の名前")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^業務 チェックイン/ })).toHaveLength(1);
  });

  it("閲覧専用では、名前を押しても選ぶだけで編集に入らない (名前に title も付けない)", () => {
    act(() => {
      st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never });
      st().setMode("analysisSimple");
      st().setCurrentBoard("simple:workflow");
    });
    renderBoth();
    const name = screen.getByRole("button", { name: "業務 チェックイン" }).querySelector(".wf-name")!;
    expect(name.getAttribute("title")).toBeNull();
    expect(name.classList.contains("is-renamable")).toBe(false);
    fireEvent.click(name);
    expect(selectedId()).toBe("biz_checkin");
    expect(screen.queryByLabelText("業務の名前")).toBeNull();
  });

  it("変換中の Enter では確定しない (isComposing)", () => {
    renderBoth();
    click("業務 チェックイン");
    const input = nameInput("業務");
    const ev = createEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    fireEvent(input, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(screen.queryByLabelText("業務の名前")).not.toBeNull();
  });

  it("足した直後に右のプロパティの名前の入力へフォーカスする挙動は変わらない", () => {
    renderBoth();
    fireEvent.click(screen.getByRole("button", { name: "「フロント担当」に業務を足す" }));
    const propertyName = within(screen.getByTestId("element-editor")).getByLabelText("名前");
    expect(document.activeElement).toBe(propertyName);
  });

  it("既定の活動 (名前が業務と同じ) は、名前を押しても編集に入らない", () => {
    const buc = st().model.elements.find((e) => e.kind === "buc" && e.isDefault)!;
    const ctx = { selectedId: null, choose: () => {} };
    render(<Pick id={buc.id} className="wf-frame-title" ctx={ctx} label="活動" rename={{ element: buc, body: (name) => <>{name}</> }} />);
    const name = screen.getByRole("button", { name: "活動" }).querySelector(".wf-name")!;
    expect(name.getAttribute("title")).toBeNull();
    fireEvent.click(name);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("業務一覧ボード: 業務の順序を変える", () => {
  const frontIds = () => buildWorkflow(st().model).lanes.find((l) => l.actor.id === "actor_front")!.businesses.map((b) => b.business.id);
  const frontLane = () => lane("フロント担当");

  it("枠の見出しの「←」「→」で同じ行の隣の業務と入れ替わり、押した業務が選ばれる。行の端では disabled。履歴 1 件で Undo で戻る", () => {
    render(<WorkflowBoard />);
    const before = frontIds();
    expect(before).toEqual(["biz_checkin", "biz_stay", "biz_checkout"]);
    const first = within(frontLane()).getByRole("button", { name: "「チェックイン」を前へ" }) as HTMLButtonElement;
    expect(first.disabled).toBe(true);
    expect(first.title).toBeTruthy();
    expect((within(frontLane()).getByRole("button", { name: "「チェックアウト」を後ろへ" }) as HTMLButtonElement).disabled).toBe(true);
    const past = st().history.past.length;
    fireEvent.click(within(frontLane()).getByRole("button", { name: "「チェックイン」を後ろへ" }));
    expect(frontIds()).toEqual(["biz_stay", "biz_checkin", "biz_checkout"]);
    expect(st().history.past.length).toBe(past + 1);
    expect(selectedId()).toBe("biz_checkin");
    act(() => st().undo());
    expect(frontIds()).toEqual(before);
  });

  it("担当が決まっていない業務の区画の中でも並べ替えられる", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "business", name: "宙 A", id: "biz_free_a" }));
      st().dispatch((m) => addElement(m, { kind: "business", name: "宙 B", id: "biz_free_b" }));
    });
    render(<WorkflowBoard />);
    const area = screen.getByRole("region", { name: "担当が決まっていない業務" });
    fireEvent.click(within(area).getByRole("button", { name: "「宙 B」を前へ" }));
    expect(buildWorkflow(st().model).unassigned.map((b) => b.business.id)).toEqual(["biz_free_b", "biz_free_a"]);
  });

  it("閲覧専用では出さない", () => {
    act(() => {
      st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never });
    });
    render(<WorkflowBoard />);
    expect(screen.queryByRole("button", { name: /を前へ$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /を後ろへ$/ })).toBeNull();
  });
});
