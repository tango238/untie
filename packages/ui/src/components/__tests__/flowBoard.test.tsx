import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { buildActivityFlow, previousCandidates } from "@untie/core/model/activityFlow";
import { addElement, addRelation, removeElement, removeRelation } from "@untie/core/model/commands";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { FlowBoard } from "../workflow/FlowBoard";
import { PropertyPanel } from "../PropertyPanel";
import { addWorkflowElement } from "@untie/core/model/workflow";
import { NAME_MAX_LENGTH } from "@untie/core/model/limits";

const st = () => useUntieStore.getState();

describe("業務フロー: 組み立て", () => {
  beforeEach(() => resetStore());

  it("業務ごとの帯に、順序のある作業を左から右へ並べる。帯は業務の順に左から続き、列は図全体で通し番号", () => {
    const flow = buildActivityFlow(st().model);
    const cells = flow.rows.flatMap((r) => r.cells);
    const cell = (id: string) => cells.find((c) => c.activity.id === id)!;
    expect(cell("act_hand_key").column).toBeGreaterThan(cell("act_assign_room").column);
    expect(flow.links.some((l) => l.kind === "order" && l.sourceId === "act_assign_room" && l.targetId === "act_hand_key")).toBe(true);
    // 帯は重ならず、図の列を使い切る
    let next = 0;
    for (const b of flow.bands) {
      expect(b.start).toBe(next);
      next += b.columns;
    }
    expect(flow.columns).toBe(next);
    // 担当なしの行は、あれば登場人物の行の最後
    const nullAt = flow.rows.findIndex((r) => r.actor === null);
    const lastInternal = flow.rows.map((r) => r.external).lastIndexOf(false);
    expect(nullAt === -1 || nullAt === lastInternal).toBe(true);
  });

  it("外部アクターの行は一番上で、起点にする作業と同じ列にイベントを出し、作業へ線を引く。起点の作業が無いイベントは数だけ数える", () => {
    act(() => {
      expect(st().dispatch((m) => addElement(m, { kind: "event", name: "宛先の無いイベント", id: "ev_lonely", init: { contextId: "ctx_reservation" } })).ok).toBe(true);
      expect(st().dispatch((m) => addRelation(m, { sourceId: "ext_guest", targetId: "ev_lonely" })).ok).toBe(true);
    });
    const flow = buildActivityFlow(st().model);
    expect(flow.rows[0]!.external).toBe(true);
    const guest = flow.rows.find((r) => r.actor?.id === "ext_guest")!;
    const accept = flow.rows.flatMap((r) => r.cells).find((c) => c.activity.id === "act_accept_reservation")!;
    expect(guest.events.map((e) => [e.event.id, e.column])).toEqual([["ev_stay_requested", accept.column]]);
    expect(flow.links.some((l) => l.kind === "event" && l.sourceId === "ext_guest:ev_stay_requested" && l.targetId === "act_accept_reservation")).toBe(true);
    expect(flow.hiddenEvents).toBe(1);
    // 行にカードとして出したイベントは、作業のカードの「きっかけ」には重ねない
    expect(accept.triggerEvents).toEqual([]);
  });

  it("作業が使う操作の対象 (システム・帳票・画面のシステム) を、システムの行に出し、作業から線を引く。同じ列の同じものは 1 枚", () => {
    const flow = buildActivityFlow(st().model);
    expect(flow.systems.length).toBeGreaterThan(0);
    const keys = new Set(flow.systems.map((s) => s.key));
    expect(keys.size).toBe(flow.systems.length);
    const reg = flow.systems.filter((s) => s.activityIds.includes("act_accept_reservation"));
    expect(reg.map((s) => s.element.name)).toContain("予約サイト");
    for (const l of flow.links.filter((x) => x.kind === "system")) expect(keys.has(l.targetId)).toBe(true);
  });

  it("輪になる順序があっても、列が決まる (戻る線は無視する)", () => {
    act(() => {
      const r = st().dispatch((m) => addRelation(m, { sourceId: "act_hand_key", targetId: "act_assign_room" }));
      expect(r.ok).toBe(true);
    });
    const cols = buildActivityFlow(st().model).rows.flatMap((r) => r.cells).map((c) => c.column);
    expect(cols.every((c) => Number.isInteger(c) && c >= 0)).toBe(true);
  });

  it("前の作業の候補は同じ業務の作業だけで、自分と既に前の作業のものは出ない", () => {
    const ids = previousCandidates(st().model, "act_hand_key").map((a) => a.id);
    expect(ids).not.toContain("act_hand_key");
    expect(ids).not.toContain("act_assign_room");
    expect(ids).not.toContain("act_accept_reservation"); // 別の業務
  });
});

describe("業務フローボード", () => {
  beforeEach(() => resetStore());

  it("業務の枠に作業のカードと担当の行を出す。作業を選ぶとプロパティに担当と前の作業が出て、線の操作 (ドラッグ) は無い", () => {
    act(() => st().setCurrentBoard("simple:flow"));
    render(<FlowBoard />);
    expect(screen.getByRole("heading", { name: "業務フロー" })).toBeDefined();
    const card = screen.getByRole("button", { name: /^作業 鍵を渡す/ });
    fireEvent.click(card);
    expect(st().ui.selection).toEqual({ type: "element", id: "act_hand_key" });
    expect(document.querySelector("[data-flow-handle]")).toBeNull();
  });

  it("プロパティで担当を足すと、その人の行へ移る。担当を外すと「担当なし」の行になる", () => {
    act(() => st().setCurrentBoard("analysis:flow"));
    act(() => st().select({ type: "element", id: "act_hand_key" }));
    render(
      <>
        <FlowBoard />
        <PropertyPanel />
      </>,
    );
    const panel = screen.getByTestId("flow-order-section");
    for (const b of within(panel).queryAllByRole("button", { name: /^担当「.*」を外す$/ })) fireEvent.click(b);
    expect(screen.getByRole("button", { name: /^作業 鍵を渡す \(担当なし/ })).toBeDefined();
    const select = within(screen.getByTestId("flow-order-section")).getByLabelText("担当を追加") as HTMLSelectElement;
    // 候補は登場人物だけ (外部の登場人物は作業の担当にならないので、候補に出さない)
    const optionIds = [...select.querySelectorAll("option:not([value=''])")].map((o) => o.getAttribute("value")!);
    expect(optionIds.length).toBeGreaterThan(0);
    expect(optionIds.every((id) => st().model.elements.find((e) => e.id === id)?.kind === "actor")).toBe(true);
    expect(st().model.elements.some((e) => e.kind === "externalActor")).toBe(true);
    fireEvent.change(select, { target: { value: select.querySelector("option:not([value=''])")!.getAttribute("value")! } });
    expect(screen.queryByRole("button", { name: /^作業 鍵を渡す \(担当なし/ })).toBeNull();
  });

  it("プロパティで、きっかけのイベントを足す・外すと、カードに「きっかけ: ○○」が出る (人の作業のきっかけをイベントから直接結ぶ)", () => {
    act(() => st().setCurrentBoard("simple:flow"));
    act(() => st().select({ type: "element", id: "act_hand_key" }));
    render(
      <>
        <FlowBoard />
        <PropertyPanel />
      </>,
    );
    const section = within(screen.getByTestId("flow-order-section"));
    fireEvent.change(section.getByLabelText("きっかけのイベントを追加"), { target: { value: "ev_charge_calculated" } });
    expect(st().model.relations.some((r) => r.kind === "eventActivity" && r.sourceId === "ev_charge_calculated" && r.targetId === "act_hand_key")).toBe(true);
    expect(screen.getByRole("button", { name: /^作業 鍵を渡す.*きっかけ: 請求金額が計算された/ })).toBeDefined();
    fireEvent.click(within(screen.getByTestId("flow-order-section")).getByRole("button", { name: "きっかけのイベント「請求金額が計算された」を外す" }));
    expect(st().model.relations.some((r) => r.kind === "eventActivity" && r.targetId === "act_hand_key")).toBe(false);
  });

  it("業務フローから外部の登場人物・イベントを選んでも、業務一覧と同じ項目 (発生させるイベント・発生元の関係) を編集できる。作業は担当と順序だけ", () => {
    for (const board of ["simple:flow", "analysis:flow"]) {
      resetStore();
      act(() => st().setCurrentBoard(board));
      act(() => st().select({ type: "element", id: "ext_guest" }));
      const a = render(<PropertyPanel />);
      expect(screen.getByTestId("external-events-section")).toBeDefined();
      a.unmount();
      act(() => st().select({ type: "element", id: "ev_stay_requested" }));
      const b = render(<PropertyPanel />);
      expect(screen.getByLabelText("関係を追加")).toBeDefined();
      b.unmount();
      act(() => st().select({ type: "element", id: "act_hand_key" }));
      const c = render(<PropertyPanel />);
      expect(screen.getByTestId("flow-order-section")).toBeDefined();
      expect(screen.queryByLabelText("関係を追加")).toBeNull();
      c.unmount();
    }
  });

  it("順序を外した作業は「順序は未設定」で右に出る", () => {
    act(() => {
      const rel = st().model.relations.find((r) => r.kind === "activityTrigger" && r.targetId === "act_hand_key")!;
      st().dispatch((m) => removeRelation(m, { id: rel.id }));
      st().setCurrentBoard("simple:flow");
    });
    render(<FlowBoard />);
    expect(screen.getByRole("button", { name: /^作業 鍵を渡す.*順序は未設定/ })).toBeDefined();
  });
});

describe("情報整理の業務フロー: 業務と作業を足す・直す・消す", () => {
  const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  const dialog = (name: string) => screen.getByRole("dialog", { name });
  const open = () => {
    act(() => st().setMode("analysisSimple"));
    act(() => st().setCurrentBoard("simple:flow"));
    return render(<FlowBoard />);
  };

  beforeEach(() => {
    resetStore();
    useUntieStore.setState({ cloud: null });
  });

  it("見出しの右上に、業務と作業それぞれの「＋追加」「削除」がある (編集ボタンは無い。名前は右のプロパティで直す)。何も選んでいないと削除は disabled で、title が選ぶよう伝える", () => {
    open();
    expect(within(screen.getByRole("group", { name: "業務の操作" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["＋追加", "← 前へ", "後ろへ →", "削除"]);
    expect(within(screen.getByRole("group", { name: "作業の操作" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["＋追加", "削除"]);
    expect(screen.queryByRole("button", { name: /を編集$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "編集" })).toBeNull();
    expect(btn("業務を追加").disabled).toBe(false);
    expect(btn("作業を追加").disabled).toBe(false);
    for (const name of ["業務を削除", "作業を削除"]) expect(btn(name).disabled).toBe(true);
    expect(btn("業務を削除").title).toBe("業務を選ぶと使えます");
    expect(btn("作業を削除").title).toBe("作業を選ぶと使えます");
    fireEvent.click(screen.getByRole("button", { name: "業務 チェックイン" }));
    expect(btn("業務を削除").disabled).toBe(false);
    expect(btn("作業を削除").disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^作業 鍵を渡す/ }));
    expect(btn("作業を削除").disabled).toBe(false);
    expect(btn("業務を削除").disabled).toBe(true);
  });

  it("閲覧専用と、詳細調整の業務フローには出さない", () => {
    act(() => st().setMode("analysis"));
    act(() => st().setCurrentBoard("analysis:flow"));
    const a = render(<FlowBoard />);
    expect(screen.queryByRole("button", { name: "業務を追加" })).toBeNull();
    expect(screen.queryByRole("group", { name: "作業の操作" })).toBeNull();
    a.unmount();
    act(() => st().setMode("analysisSimple"));
    act(() => st().setCurrentBoard("simple:flow"));
    act(() => {
      st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never });
    });
    render(<FlowBoard />);
    expect(screen.queryByRole("button", { name: "業務を追加" })).toBeNull();
    expect(screen.queryByRole("button", { name: "作業を追加" })).toBeNull();
  });

  it("業務の＋追加: 名前と主担当の登場人物 (外部の登場人物は出ない) を入れると、作成・結び付け・名前で履歴 1 件になり、その業務を選ぶ", () => {
    open();
    fireEvent.click(btn("業務を追加"));
    const d = dialog("業務を追加");
    const owner = within(d).getByLabelText("主担当の登場人物") as HTMLSelectElement;
    expect(Array.from(owner.options).map((o) => o.textContent)).not.toContain("宿泊客");
    expect(Array.from(owner.options).map((o) => o.value)).not.toContain("ext_guest");
    // 名前が空のうちは追加できない
    const submit = within(d).getByRole("button", { name: "追加" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(d).getByLabelText("業務の名前"), { target: { value: "備品の管理" } });
    fireEvent.change(owner, { target: { value: "actor_manager" } });
    const before = st().history.past.length;
    fireEvent.click(submit);
    expect(screen.queryByRole("dialog", { name: "業務を追加" })).toBeNull();
    expect(st().history.past.length).toBe(before + 1);
    const biz = st().model.elements.find((e) => e.kind === "business" && e.name === "備品の管理")!;
    expect(biz).toBeDefined();
    expect(st().model.relations.some((r) => r.kind === "actorBusiness" && r.sourceId === "actor_manager" && r.targetId === biz.id)).toBe(true);
    expect(st().ui.selection).toEqual({ type: "element", id: biz.id });
  });

  it("業務の＋追加: 登場人物が 1 人もいなければ、その旨を伝えて登場人物ボードへ促す", () => {
    act(() => {
      st().dispatch((m) => ({ ok: true as const, model: { ...m, elements: m.elements.filter((e) => e.kind !== "actor"), relations: m.relations.filter((r) => !["actor_front", "actor_manager"].some((id) => r.sourceId === id || r.targetId === id)) } }));
    });
    open();
    fireEvent.click(btn("業務を追加"));
    const d = dialog("業務を追加");
    expect(within(d).getByText(/登場人物がまだいません/)).toBeDefined();
    fireEvent.click(within(d).getByRole("button", { name: "登場人物ボードへ" }));
    expect(st().ui.currentBoardId).toBe("fixed:actor");
    expect(st().ui.mode).toBe("analysisSimple");
  });

  it("作業の＋追加: 業務を選んでいればその業務、作業を選んでいれば同じ足し先が初期値。担当は任意で、作成・結び付け・名前で履歴 1 件", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "業務 チェックイン" }));
    fireEvent.click(btn("作業を追加"));
    let d = dialog("作業を追加");
    expect((within(d).getByLabelText("足し先") as HTMLSelectElement).value).toBe("biz_checkin");
    expect((within(d).getByLabelText("担当の登場人物") as HTMLSelectElement).value).toBe("");
    fireEvent.click(within(d).getByRole("button", { name: "キャンセル" }));
    // 作業を選ぶと、その作業の足し先 (活動「飲食提供」)
    fireEvent.click(screen.getByRole("button", { name: /^作業 ルームサービスを提供する/ }));
    fireEvent.click(btn("作業を追加"));
    d = dialog("作業を追加");
    expect((within(d).getByLabelText("足し先") as HTMLSelectElement).value).toBe("buc_dining");
    fireEvent.change(within(d).getByLabelText("作業の名前"), { target: { value: "デザートを出す" } });
    fireEvent.change(within(d).getByLabelText("担当の登場人物"), { target: { value: "actor_front" } });
    const before = st().history.past.length;
    fireEvent.click(within(d).getByRole("button", { name: "追加" }));
    expect(st().history.past.length).toBe(before + 1);
    const act1 = st().model.elements.find((e) => e.kind === "activity" && e.name === "デザートを出す")!;
    expect(act1).toMatchObject({ bucId: "buc_dining" });
    expect(st().model.relations.some((r) => r.kind === "actorActivity" && r.sourceId === "actor_front" && r.targetId === act1.id)).toBe(true);
    expect(st().ui.selection).toEqual({ type: "element", id: act1.id });
  });

  it("作業の＋追加: 担当なしでも作れる。足し先の候補が無い (業務が無い) ときは案内だけ", () => {
    open();
    fireEvent.click(btn("作業を追加"));
    const d = dialog("作業を追加");
    fireEvent.change(within(d).getByLabelText("作業の名前"), { target: { value: "掃除をする" } });
    fireEvent.click(within(d).getByRole("button", { name: "追加" }));
    const a = st().model.elements.find((e) => e.kind === "activity" && e.name === "掃除をする")!;
    expect(a).toBeDefined();
    expect(st().model.relations.some((r) => r.kind === "actorActivity" && r.targetId === a.id)).toBe(false);
  });

  it("作業の＋追加: 足し先 (業務・活動) が無ければ案内する", () => {
    resetStore({ ...st().model, elements: st().model.elements.filter((e) => e.kind === "actor"), relations: [] });
    open();
    fireEvent.click(btn("作業を追加"));
    expect(within(dialog("作業を追加")).getByText(/作業を足せる業務がまだありません/)).toBeDefined();
  });

  it("追加ダイアログ: 名前の長さの上限があり、Esc で閉じると何も足さない", () => {
    open();
    fireEvent.click(btn("作業を追加"));
    const d = dialog("作業を追加");
    expect((within(d).getByLabelText("作業の名前") as HTMLInputElement).maxLength).toBe(NAME_MAX_LENGTH);
    const before = st().model.elements.length;
    fireEvent.change(within(d).getByLabelText("作業の名前"), { target: { value: "途中の名前" } });
    fireEvent.keyDown(d, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "作業を追加" })).toBeNull();
    expect(st().model.elements.length).toBe(before);
  });

  it("削除: プロパティの削除と同じ確認 (巻き込まれるもの) を通してから消す。キャンセルすると消えない", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "業務 チェックイン" }));
    fireEvent.click(btn("業務を削除"));
    const d = dialog("削除の確認");
    expect(within(d).getByText(/「チェックイン」を削除します。つながっているものは次のとおりです/)).toBeDefined();
    expect(within(d).getByText(/作業 \d+ 件/)).toBeDefined();
    fireEvent.click(within(d).getByRole("button", { name: "キャンセル" }));
    expect(st().model.elements.some((e) => e.id === "biz_checkin")).toBe(true);
    fireEvent.click(btn("業務を削除"));
    fireEvent.click(within(dialog("削除の確認")).getByRole("button", { name: "削除する" }));
    expect(st().model.elements.some((e) => e.id === "biz_checkin")).toBe(false);
    expect(st().ui.selection).toBeNull();
  });

  it("削除: 巻き込まれるものが無い作業は、確認なしで消える", () => {
    act(() => {
      st().dispatch((m) => addWorkflowElement(m, "activity", "biz_checkin"));
    });
    open();
    const count = () => st().model.elements.filter((e) => e.kind === "activity" && e.name === "新しい作業").length;
    expect(count()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /^作業 新しい作業/ }));
    fireEvent.click(btn("作業を削除"));
    expect(screen.queryByRole("dialog", { name: "削除の確認" })).toBeNull();
    expect(count()).toBe(0);
  });

  it("削除の確認を開いたまま対象が消えたら、確認も閉じる", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "業務 チェックイン" }));
    fireEvent.click(btn("業務を削除"));
    expect(dialog("削除の確認")).toBeDefined();
    act(() => void st().dispatch((m) => removeElement(m, { id: "biz_checkin" })));
    expect(screen.queryByRole("dialog", { name: "削除の確認" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "業務 予約受付" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("IME の変換中の Esc ではダイアログを閉じない。変換が終われば Esc で閉じる", () => {
    open();
    fireEvent.click(btn("業務を追加"));
    const d = dialog("業務を追加");
    fireEvent.keyDown(within(d).getByLabelText("業務の名前"), { key: "Escape", isComposing: true });
    fireEvent.keyDown(within(d).getByLabelText("業務の名前"), { key: "Escape", keyCode: 229 });
    expect(screen.queryByRole("dialog", { name: "業務を追加" })).not.toBeNull();
    fireEvent.keyDown(within(d).getByLabelText("業務の名前"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "業務を追加" })).toBeNull();
  });
});

describe("情報整理の業務フロー: 業務の順序を変える", () => {
  const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  const bandIds = () => buildActivityFlow(st().model).bands.map((b) => b.business.id);
  const open = (board = "simple:flow") => {
    act(() => st().setMode(board === "simple:flow" ? "analysisSimple" : "analysis"));
    act(() => st().setCurrentBoard(board));
    return render(<FlowBoard />);
  };

  beforeEach(() => {
    resetStore();
    useUntieStore.setState({ cloud: null });
  });

  it("業務を選んでいないと「← 前へ」「後ろへ →」は disabled で、title が選ぶよう伝える", () => {
    open();
    for (const name of ["業務を前へ", "業務を後ろへ"]) {
      expect(btn(name).disabled).toBe(true);
      expect(btn(name).title).toBe("業務を選ぶと使えます");
    }
  });

  it("押すと図に出ている隣の業務と入れ替わり、選択は保たれる。履歴 1 件で Undo で戻る。端の業務では該当する方が disabled", () => {
    open();
    const before = bandIds();
    const nameOfBiz = (id: string) => st().model.elements.find((e) => e.id === id)!.name;
    fireEvent.click(screen.getByRole("button", { name: `業務 ${nameOfBiz(before[0]!)}` }));
    expect(btn("業務を前へ").disabled).toBe(true);
    expect(btn("業務を前へ").title).toBe("図の左端の業務です");
    expect(btn("業務を後ろへ").disabled).toBe(false);
    const past = st().history.past.length;
    fireEvent.click(btn("業務を後ろへ"));
    expect(bandIds().slice(0, 2)).toEqual([before[1], before[0]]);
    expect(st().history.past.length).toBe(past + 1);
    expect(st().ui.selection).toEqual({ type: "element", id: before[0] });
    expect(btn("業務を前へ").disabled).toBe(false);
    act(() => st().undo());
    expect(bandIds()).toEqual(before);
    // 右端
    fireEvent.click(screen.getByRole("button", { name: `業務 ${nameOfBiz(before[before.length - 1]!)}` }));
    expect(btn("業務を後ろへ").disabled).toBe(true);
    expect(btn("業務を後ろへ").title).toBe("図の右端の業務です");
  });

  it("作業が 1 つも無い業務も図の山形に出て、選べて、並べ替えられる (隣は図の前後の業務)", () => {
    act(() => {
      expect(st().dispatch((m) => addWorkflowElement(m, "business", "actor_front")).ok).toBe(true);
    });
    const empty = st().model.elements.filter((e) => e.kind === "business").slice(-1)[0]!;
    open();
    fireEvent.click(screen.getByRole("button", { name: `業務 ${empty.name}` }));
    expect(st().ui.selection).toEqual({ type: "element", id: empty.id });
    expect(screen.getByText("作業はまだありません")).toBeDefined();
    expect(btn("業務を後ろへ").disabled).toBe(true);
    expect(btn("業務を前へ").disabled).toBe(false);
    fireEvent.click(btn("業務を前へ"));
    const order = st().model.elements.filter((e) => e.kind === "business").map((e) => e.id);
    expect(order.indexOf(empty.id)).toBe(order.length - 2);
    expect(btn("業務を削除").disabled).toBe(false);
  });

  it("業務だけで作業が無いモデルでも山形を出す。空の案内は、業務も作業も無いときだけ", () => {
    const base = st().model;
    resetStore({ ...base, elements: base.elements.filter((e) => e.kind === "actor" || e.kind === "business" || (e.kind === "buc" && e.isDefault)), relations: [] });
    const { unmount } = open();
    expect(screen.getAllByRole("button", { name: /^業務 / }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/業務も作業もまだありません/)).toBeNull();
    unmount();
    resetStore({ ...base, elements: [], relations: [] });
    open();
    expect(screen.getByText(/業務も作業もまだありません/)).toBeDefined();
  });

  it("業務を足すと、図に山形が出て、その業務が選ばれる (トーストは出さない)", () => {
    open();
    fireEvent.click(btn("業務を追加"));
    const d = screen.getByRole("dialog", { name: "業務を追加" });
    fireEvent.change(within(d).getByLabelText("業務の名前"), { target: { value: "備品の管理" } });
    fireEvent.click(within(d).getByRole("button", { name: "追加" }));
    expect(screen.getByRole("button", { name: "業務 備品の管理" })).toBeDefined();
    expect(st().toasts).toHaveLength(0);
  });

  it("詳細調整の業務フロー (analysis:flow) には出さない", () => {
    open("analysis:flow");
    expect(screen.queryByRole("button", { name: "業務を前へ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "業務を後ろへ" })).toBeNull();
  });
});
