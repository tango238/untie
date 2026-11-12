import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { addElement, addRelation, removeElement } from "@untie/core/model/commands";
import type { Activity } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { handleKeyDown } from "../useKeyboard";
import { resetStore } from "../../test/utils";
import { PropertyPanel } from "../PropertyPanel";
import { WorkflowBoard } from "../workflow/WorkflowBoard";
import { Toolbar } from "../Toolbar";

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
    expect(names.slice(0, 2)).toEqual(["作業 到着を確認する", "作業 本人確認をする"]);
    // 作業の行には担当の名前を添える
    expect(within(checkin).getByRole("button", { name: "作業 本人確認をする" }).textContent).toContain("担当: フロント担当、宿泊客");
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
    expect(within(orphans).getByRole("button", { name: "作業 迷子の作業" })).toBeDefined();
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
      const button = screen.getAllByRole("button", { name }).find((b) => b.tagName === "BUTTON")!;
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
    fireEvent.click(screen.getByRole("button", { name: "作業 客室の要望に応える" }));
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
    const stay = screen.getByRole("region", { name: /^業務 滞在中の対応/ });
    expect(within(stay).getByText(/作業は活動の枠の「＋作業」から足します/)).toBeDefined();
    const checkin = screen.getByRole("region", { name: /^業務 チェックイン/ });
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
    fireEvent.click(screen.getByRole("button", { name: "作業 鍵を渡す" }));
    expect(selectedId()).toBe("act_hand_key");
  });
});

describe("プロパティからの関連の追加・削除と、削除の確認", () => {
  const select = (name: string) => fireEvent.click(screen.getAllByRole("button", { name })[0]!);
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

  it("ワークフローの種類以外 (システム・操作など) は、簡易モードでは名前・説明などだけ。削除・関係の編集は出さず、詳細で直すよう案内する", () => {
    renderBoth();
    for (const id of ["sys_pms", "uc_register_reservation"]) {
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
    expect(screen.queryByRole("button", { name: "作業 鍵を渡す" })).toBeNull();
  });
});

describe("ツールバー", () => {
  it("簡易モードではボードの選択肢はワークフローだけで、ボードの追加・名前変更・削除は出さない。詳細・設計ではワークフローを出さない", () => {
    render(<Toolbar />);
    const options = () => within(screen.getByLabelText("ボード")).getAllByRole("option").map((o) => o.textContent);
    expect(options()).toEqual(["ワークフロー"]);
    expect(screen.queryByRole("button", { name: "＋ボード" })).toBeNull();
    expect(screen.queryByRole("button", { name: "名前変更" })).toBeNull();
    act(() => st().setMode("analysis"));
    expect(options()).not.toContain("ワークフロー");
    act(() => st().enterDesign("sys_pms"));
    expect(options()).not.toContain("ワークフロー");
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
