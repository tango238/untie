import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { PropertyPanel } from "../PropertyPanel";

const st = () => useUntieStore.getState();
const el = (id: string) => st().model.elements.find((e) => e.id === id)!;
const selectEl = (id: string) => act(() => st().select({ type: "element", id }));
/** 所属・関係・削除は固定ボードで編集する */
const onFixedBoard = () => act(() => st().setCurrentBoard("fixed:activity"));

beforeEach(() => resetStore());
afterEach(() => vi.useRealTimers());

describe("PropertyPanel", () => {
  it("選択がないときは案内を出す", () => {
    render(<PropertyPanel />);
    expect(screen.getByText(/選ぶと/)).toBeDefined();
  });

  it("名前は入力中は履歴に積まず、フォーカスアウトで 1 件として確定する", () => {
    selectEl("actor_front");
    render(<PropertyPanel />);
    const input = screen.getByLabelText("名前") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "フロ" } });
    fireEvent.change(input, { target: { value: "フロント責任者" } });
    expect(el("actor_front").name).toBe("フロント担当");
    expect(st().history.past).toHaveLength(0);
    fireEvent.blur(input);
    expect(el("actor_front").name).toBe("フロント責任者");
    expect(st().history.past).toHaveLength(1);
    fireEvent.blur(input); // 変更なしなら増えない
    expect(st().history.past).toHaveLength(1);
  });

  it("500ms 入力が止まると 1 件として確定する", () => {
    vi.useFakeTimers();
    selectEl("actor_front");
    render(<PropertyPanel />);
    const input = screen.getByLabelText("名前");
    fireEvent.change(input, { target: { value: "A" } });
    act(() => void vi.advanceTimersByTime(300));
    fireEvent.change(input, { target: { value: "AB" } });
    act(() => void vi.advanceTimersByTime(300));
    expect(el("actor_front").name).toBe("フロント担当");
    act(() => void vi.advanceTimersByTime(300));
    expect(el("actor_front").name).toBe("AB");
    expect(st().history.past).toHaveLength(1);
  });

  it("別の要素を選ぶ前に入力中の内容を確定する", () => {
    selectEl("actor_front");
    render(<PropertyPanel />);
    fireEvent.change(screen.getByLabelText("説明"), { target: { value: "受付の担当" } });
    selectEl("actor_manager");
    expect(el("actor_front").description).toBe("受付の担当");
    expect(el("actor_manager").description).toBeUndefined();
  });

  it("アクティビティの業務と BUC を変えられる (未所属を含む)", () => {
    onFixedBoard();
    selectEl("act_room_request");
    render(<PropertyPanel />);
    const biz = screen.getByLabelText("業務") as HTMLSelectElement;
    const buc = screen.getByLabelText("BUC") as HTMLSelectElement;
    expect(biz.value).toBe("biz_stay");
    expect(buc.value).toBe("buc_room_care");
    fireEvent.change(buc, { target: { value: "buc_dining" } });
    expect(el("act_room_request")).toMatchObject({ bucId: "buc_dining" });
    fireEvent.change(screen.getByLabelText("業務"), { target: { value: "biz_checkin" } });
    expect(el("act_room_request")).toMatchObject({ bucId: "buc_default_checkin" });
    fireEvent.change(screen.getByLabelText("業務"), { target: { value: "" } });
    expect(el("act_room_request")).toMatchObject({ bucId: null });
    expect((screen.getByLabelText("BUC") as HTMLSelectElement).disabled).toBe(true);
  });

  it("BUC の業務を変えられる", () => {
    onFixedBoard();
    selectEl("buc_dining");
    render(<PropertyPanel />);
    fireEvent.change(screen.getByLabelText("業務"), { target: { value: "biz_checkout" } });
    expect(el("buc_dining")).toMatchObject({ businessId: "biz_checkout" });
  });

  it("バリエーションの値を追加・並べ替え・削除できる", () => {
    onFixedBoard();
    selectEl("var_room_type");
    render(<PropertyPanel />);
    const values = () => (el("var_room_type") as { values: string[] }).values;
    expect(values()).toEqual(["シングル", "ツイン", "スイート"]);
    fireEvent.change(screen.getByLabelText("追加する値"), { target: { value: "和室" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(values()).toEqual(["シングル", "ツイン", "スイート", "和室"]);
    fireEvent.click(screen.getByRole("button", { name: "値「和室」を上へ" }));
    expect(values()).toEqual(["シングル", "ツイン", "和室", "スイート"]);
    fireEvent.click(screen.getByRole("button", { name: "値「ツイン」を削除" }));
    expect(values()).toEqual(["シングル", "和室", "スイート"]);
  });

  it("情報の分類・状態のグループを編集できる", () => {
    onFixedBoard();
    selectEl("info_reservation");
    const { unmount } = render(<PropertyPanel />);
    const ctx = screen.getByLabelText("分類");
    fireEvent.change(ctx, { target: { value: "予約系" } });
    fireEvent.blur(ctx);
    expect(el("info_reservation")).toMatchObject({ context: "予約系" });
    unmount();
    selectEl("st_res_tentative");
    render(<PropertyPanel />);
    expect(screen.getByLabelText("状態グループ")).toBeDefined();
  });

  it("課題の重要度と対象を編集できる", () => {
    onFixedBoard();
    selectEl("issue_cancel_explain");
    render(<PropertyPanel />);
    fireEvent.change(screen.getByLabelText("重要度"), { target: { value: "5" } });
    expect(el("issue_cancel_explain")).toMatchObject({ severity: 5 });
    fireEvent.click(screen.getByRole("button", { name: "対象「予約を変更・取消する」を外す" }));
    expect((el("issue_cancel_explain") as { targetIds: string[] }).targetIds).toEqual(["uc_cancel_reservation"]);
    fireEvent.change(screen.getByLabelText("対象を追加"), { target: { value: "biz_checkin" } });
    expect((el("issue_cancel_explain") as { targetIds: string[] }).targetIds).toEqual(["uc_cancel_reservation", "biz_checkin"]);
  });

  it("関係一覧: 相手クリックで選択、× で関係を消す", () => {
    onFixedBoard();
    selectEl("act_verify_identity");
    render(<PropertyPanel />);
    const before = st().model.relations.length;
    const rels = within(screen.getByText("関係", { selector: "h3" }).parentElement!);
    fireEvent.click(rels.getByRole("button", { name: "フロント担当" }));
    expect(st().ui.selection).toEqual({ type: "element", id: "actor_front" });
    selectEl("act_verify_identity");
    const del = within(screen.getByText("関係", { selector: "h3" }).parentElement!).getAllByRole("button", { name: /を削除$/ })[0]!;
    fireEvent.click(del);
    expect(st().model.relations.length).toBe(before - 1);
  });

  it("この要素を対象にする課題の一覧と「課題を追加」", () => {
    onFixedBoard();
    selectEl("biz_reservation");
    render(<PropertyPanel />);
    expect(screen.getByRole("button", { name: "予約サイトからの予約を手で転記している" })).toBeDefined();
    const count = st().model.elements.length;
    fireEvent.click(screen.getByRole("button", { name: "課題を追加" }));
    expect(st().model.elements.length).toBe(count + 1);
    const sel = st().ui.selection!;
    const issue = el(sel.id) as { kind: string; targetIds: string[] };
    expect(issue.kind).toBe("issue");
    expect(issue.targetIds).toEqual(["biz_reservation"]);
  });

  it("課題・アクター等には課題追加ボタンがない", () => {
    selectEl("actor_front");
    render(<PropertyPanel />);
    expect(screen.queryByRole("button", { name: "課題を追加" })).toBeNull();
  });

  it("自由ボードでは「ボードから外す」だけ。要素は残る", () => {
    selectEl("actor_front");
    render(<PropertyPanel />);
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ボードから外す" }));
    expect(el("actor_front")).toBeDefined();
    expect(st().model.boards[0]!.nodes.some((n) => n.elementId === "actor_front")).toBe(false);
    expect(screen.queryByRole("button", { name: "ボードから外す" })).toBeNull();
  });

  it("固定ボードでは「削除」で要素ごと消せる。「ボードから外す」は無い", () => {
    onFixedBoard();
    selectEl("actor_front");
    render(<PropertyPanel />);
    expect(screen.queryByRole("button", { name: "ボードから外す" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(st().model.elements.some((e) => e.id === "actor_front")).toBe(false);
    expect(st().ui.selection).toBeNull();
  });

  it("自由ボードでは所属・関係・課題の追加を変えられない", () => {
    selectEl("act_verify_identity");
    render(<PropertyPanel />);
    // fieldset の disabled で無効になる (要素自身の disabled 属性ではない)
    expect(screen.getByLabelText("業務").matches(":disabled")).toBe(true);
    expect(screen.queryByLabelText("関係を追加")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /を削除$/ })).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "課題を追加" })).toBeNull();
    // 名前と説明は変えられる
    expect(screen.getByLabelText("名前").matches(":disabled")).toBe(false);
  });

  it("線を選ぶと関係名と両端を出す。削除はできない", () => {
    const rel = st().model.relations.find((r) => r.kind === "actorActivity")!;
    act(() => st().select({ type: "relation", id: rel.id }));
    render(<PropertyPanel />);
    const editor = within(screen.getByTestId("relation-editor"));
    expect(editor.getByText("担当")).toBeDefined();
    expect(editor.queryByRole("button", { name: "削除" })).toBeNull();
    const src = st().model.elements.find((e) => e.id === rel.sourceId)!;
    fireEvent.click(editor.getByRole("button", { name: src.name }));
    expect(st().ui.selection).toEqual({ type: "element", id: src.id });
  });

  it("「追加」直後は名前欄にフォーカスする", () => {
    selectEl("actor_front");
    render(<PropertyPanel />);
    act(() => {
      st().select({ type: "element", id: "actor_manager" });
      st().requestNameFocus();
    });
    expect(document.activeElement).toBe(screen.getByLabelText("名前"));
  });

  it("固定ボードでは、結べる要素を選んで関係を足せる (既にある関係と結べない種類は出さない)", () => {
    onFixedBoard();
    selectEl("biz_checkin");
    render(<PropertyPanel />);
    const select = screen.getByLabelText("関係を追加") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    // フロント担当は既に主担当。外部アクターは業務の主担当になれない
    expect(values).toContain("actor_manager>biz_checkin");
    expect(values).not.toContain("actor_front>biz_checkin");
    expect(values).not.toContain("ext_guest>biz_checkin");
    fireEvent.change(select, { target: { value: "actor_manager>biz_checkin" } });
    expect(
      st().model.relations.some((r) => r.kind === "actorBusiness" && r.sourceId === "actor_manager" && r.targetId === "biz_checkin"),
    ).toBe(true);
  });
});
