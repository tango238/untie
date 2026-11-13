import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { canvasApi } from "../canvas/canvasApi";
import { PropertyPanel } from "../PropertyPanel";
import { SIMPLE_BOARD_ELEMENT_KINDS, SIMPLE_LAYER_BOARDS, simpleBoardOfKind, simpleBoardOfLayer } from "@untie/core/model/workflow";

const st = () => useUntieStore.getState();

beforeEach(() => {
  resetStore();
  useUntieStore.setState({ cloud: null });
  act(() => st().setMode("analysisSimple"));
});

describe("簡易ボードどうしの「移動」の対応表", () => {
  it("各レイヤーを見る簡易ボード: 登場人物〜作業はワークフロー、操作・画面・条件はシステム操作、コンテキスト・情報・状態・バリエーションは情報と状態。非機能要件は無し", () => {
    for (const l of ["actor", "business", "buc", "activity"] as const) expect(simpleBoardOfLayer(l)).toBe("workflow");
    for (const l of ["usecase", "screen", "condition"] as const) expect(simpleBoardOfLayer(l)).toBe("operation");
    for (const l of ["context", "information", "state", "variation"] as const) expect(simpleBoardOfLayer(l)).toBe("information");
    expect(simpleBoardOfLayer("nfr")).toBeNull();
    expect(Object.keys(SIMPLE_LAYER_BOARDS)).toHaveLength(11);
  });
  it("要素の種類の主役のボード: システム・帳票はどのボードの主役でもない", () => {
    expect(simpleBoardOfKind("externalActor")).toBe("workflow");
    expect(simpleBoardOfKind("event")).toBe("operation");
    expect(simpleBoardOfKind("system")).toBeNull();
    expect(simpleBoardOfKind("ledger")).toBeNull();
    expect(SIMPLE_BOARD_ELEMENT_KINDS.operation).toContain("condition");
  });
});

describe("トレース表の「移動」を押す", () => {
  const select = (id: string) => act(() => st().select({ type: "element", id }));
  const selectedId = () => {
    const sel = st().ui.selection;
    return sel?.type === "element" ? sel.id : null;
  };

  it("ワークフローで作業を選び、操作の行の「移動」を押すと、簡易モードのままシステム操作ボードへ移り、その行の先頭の操作を選ぶ", () => {
    select("act_confirm_reservation");
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "操作をシステム操作ボードで見る" }));
    expect(st().ui.mode).toBe("analysisSimple");
    expect(st().ui.currentBoardId).toBe("simple:operation");
    const row = st().model.relations.filter((r) => r.kind === "activityUsecase" && r.sourceId === "act_confirm_reservation").map((r) => r.targetId);
    const sel = st().ui.selection;
    expect(sel?.type === "element" && row.includes(sel.id)).toBe(true);
    expect(st().ui.rightPanel).toBe("properties");
  });

  it("切り替え先のボードでその要素までスクロールする (描画後に canvasApi.focus を呼ぶ)", () => {
    vi.useFakeTimers();
    try {
      select("act_confirm_reservation");
      render(<PropertyPanel />);
      const focus = vi.fn();
      canvasApi.focus = focus;
      fireEvent.click(screen.getByRole("button", { name: "操作をシステム操作ボードで見る" }));
      vi.advanceTimersByTime(100);
      expect(focus).toHaveBeenCalledWith(selectedId());
    } finally {
      vi.useRealTimers();
      canvasApi.focus = undefined;
    }
  });

  it("システム操作ボードで操作を選び、作業の行の「移動」を押すと、ワークフローへ移り、その作業を選ぶ", () => {
    act(() => st().setCurrentBoard("simple:operation"));
    select("uc_confirm_reservation");
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "作業をワークフローボードで見る" }));
    expect(st().ui.currentBoardId).toBe("simple:workflow");
    expect(st().ui.mode).toBe("analysisSimple");
    expect(st().ui.selection).toEqual({ type: "element", id: "act_confirm_reservation" });
  });

  it("自分の行 (選んだ要素のレイヤー) の「移動」は、選んだ要素を選んだまま行き先へ移る。行に要素が無いとき、いま選んでいる要素が行き先で見えなければ選択は外れる", () => {
    select("act_confirm_reservation");
    const { unmount } = render(<PropertyPanel />);
    // 作業 (ワークフローの主役) の選択を持って、情報と状態ボードへ: 情報の行に要素があれば先頭を選ぶ
    fireEvent.click(screen.getByRole("button", { name: "情報を情報と状態ボードで見る" }));
    expect(st().ui.currentBoardId).toBe("simple:information");
    expect(st().model.elements.find((e) => e.id === selectedId())?.kind).toBe("information");
    unmount();
    // 行が空 (「(未設定)」) の「移動」: 作業は情報と状態ボードに見えないので、ボードを切り替えるだけで選択は外れる
    act(() => st().setCurrentBoard("simple:workflow"));
    select("act_hand_key");
    render(<PropertyPanel />);
    const emptyRowMove = screen.queryAllByRole("button", { name: /ボードで見る$/ }).find((b) => b.closest("tr")?.textContent?.includes("(未設定)"));
    expect(emptyRowMove).toBeDefined();
    fireEvent.click(emptyRowMove!);
    expect(st().ui.currentBoardId).not.toBe("simple:workflow");
    expect(st().ui.selection).toBeNull();
    expect(st().ui.mode).toBe("analysisSimple");
  });

  it("対応する簡易ボードの無い非機能要件の「移動」は、今までどおり固定ボードへ移る (分析（詳細）に切り替わる)", () => {
    act(() => void st().dispatch((m) => ({ ok: true, model: { ...m, elements: [...m.elements, { id: "nfr_fast", kind: "nfr", name: "速く応答する", systemId: "sys_pms" }] as typeof m.elements } })));
    select("nfr_fast");
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "固定ボード「非機能要件」へ移る" }));
    expect(st().ui.mode).toBe("analysis");
    expect(st().ui.currentBoardId).toBe("fixed:nfr");
  });

  it("課題の対象の「移動」を押すと、対象を主役にする簡易ボードへ移って対象を選ぶ。システム・帳票が対象のときは出さない", () => {
    select("issue_extra_missing");
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "「追加料金を登録する」をシステム操作ボードで見る" }));
    expect(st().ui.currentBoardId).toBe("simple:operation");
    expect(st().ui.selection).toEqual({ type: "element", id: "uc_register_extra" });
  });

  it("システム・帳票が課題の対象のとき、簡易モードでは「移動」を出さない (どのボードの主役でもない)", () => {
    act(() => {
      useUntieStore.setState((s) => ({ model: { ...s.model, elements: s.model.elements.map((e) => (e.id === "issue_extra_missing" ? { ...e, targetIds: ["sys_pms", "ldg_guest_register"] } : e)) as typeof s.model.elements } }));
    });
    select("issue_extra_missing");
    render(<PropertyPanel />);
    expect(screen.getByRole("button", { name: "宿泊管理システム" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /「宿泊管理システム」を.*ボードで見る/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /「宿泊者名簿」を.*ボードで見る/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /固定ボードへ移る/ })).toBeNull();
  });
});
