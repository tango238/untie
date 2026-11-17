import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { canvasApi } from "../canvas/canvasApi";
import { PropertyPanel } from "../PropertyPanel";
import { IssuePanel } from "../IssuePanel";
import { TracePanel } from "../TracePanel";
import { addElement } from "@untie/core/model/commands";
import { SIMPLE_BOARD_ELEMENT_KINDS, SIMPLE_LAYER_BOARDS, simpleBoardOfKind, simpleBoardOfLayer } from "@untie/core/model/workflow";

const st = () => useUntieStore.getState();

beforeEach(() => {
  resetStore();
  useUntieStore.setState({ cloud: null });
  act(() => st().setMode("analysisSimple"));
});

describe("情報整理のボードどうしの「移動」の対応表", () => {
  it("各レイヤーを見る情報整理のボード: 登場人物〜作業は業務一覧、操作・画面・条件はシステム操作、コンテキスト・情報・状態・バリエーションは情報と状態。非機能要件は無し", () => {
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

  it("業務一覧で作業を選び、操作の行の「移動」を押すと、情報整理モードのままシステム操作ボードへ移り、その行の先頭の操作を選ぶ", () => {
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

  it("システム操作ボードで操作を選び、作業の行の「移動」を押すと、業務一覧へ移り、その作業を選ぶ", () => {
    act(() => st().setCurrentBoard("simple:operation"));
    select("uc_confirm_reservation");
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "作業を業務一覧ボードで見る" }));
    expect(st().ui.currentBoardId).toBe("simple:workflow");
    expect(st().ui.mode).toBe("analysisSimple");
    expect(st().ui.selection).toEqual({ type: "element", id: "act_confirm_reservation" });
  });

  it("自分の行 (選んだ要素のレイヤー) の「移動」は、選んだ要素を選んだまま行き先へ移る。行に要素が無いとき、いま選んでいる要素が行き先で見えなければ選択は外れる", () => {
    select("act_confirm_reservation");
    const { unmount } = render(<PropertyPanel />);
    // 作業 (業務一覧の主役) の選択を持って、情報と状態ボードへ: 情報の行に要素があれば先頭を選ぶ
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

  it("対応する情報整理のボードの無い非機能要件の「移動」は、今までどおり固定ボードへ移る (詳細調整に切り替わる)", () => {
    act(() => void st().dispatch((m) => ({ ok: true, model: { ...m, elements: [...m.elements, { id: "nfr_fast", kind: "nfr", name: "速く応答する", systemId: "sys_pms" }] as typeof m.elements } })));
    select("nfr_fast");
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "固定ボード「非機能要件」へ移る" }));
    expect(st().ui.mode).toBe("analysis");
    expect(st().ui.currentBoardId).toBe("fixed:nfr");
  });

  it("課題の対象の「移動」を押すと、対象を主役にする情報整理のボードへ移って対象を選ぶ。システム・帳票が対象のときは出さない", () => {
    select("issue_extra_missing");
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "「追加料金を登録する」をシステム操作ボードで見る" }));
    expect(st().ui.currentBoardId).toBe("simple:operation");
    expect(st().ui.selection).toEqual({ type: "element", id: "uc_register_extra" });
  });

  it("システム・帳票が課題の対象のとき、情報整理モードでは「移動」を出さない (どのボードの主役でもない)", () => {
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

describe("右ペインの課題一覧・検証の「移動」とリンク (情報整理モード)", () => {
  it("課題一覧の対象の「移動」: 情報整理モードでは、対象を主役にする情報整理のボードへ移って選ぶ。詳細調整モードでは今までどおり固定ボード", () => {
    act(() => st().setRightPanel("issues"));
    const { unmount } = render(<IssuePanel />);
    fireEvent.click(screen.getByRole("button", { name: "対象ごと" }));
    fireEvent.click(screen.getByRole("button", { name: "「予約受付」を業務一覧ボードで見る" }));
    expect(st().ui.mode).toBe("analysisSimple");
    expect(st().ui.currentBoardId).toBe("simple:workflow");
    expect(st().ui.selection).toEqual({ type: "element", id: "biz_reservation" });
    unmount();
    // いまのボードの対象は、移らず選ぶだけ
    act(() => st().setCurrentBoard("simple:operation"));
    render(<IssuePanel />);
    fireEvent.click(screen.getByRole("button", { name: "対象ごと" }));
    fireEvent.click(screen.getAllByRole("button", { name: "「追加料金を登録する」をシステム操作ボードで見る" })[0]!);
    expect(st().ui.currentBoardId).toBe("simple:operation");
    expect(st().ui.selection).toEqual({ type: "element", id: "uc_register_extra" });
  });

  it("詳細調整モードの課題一覧の「移動」は、固定ボードへ移る (変えない)", () => {
    act(() => st().setMode("analysis"));
    render(<IssuePanel />);
    fireEvent.click(screen.getByRole("button", { name: "対象ごと" }));
    fireEvent.click(screen.getByRole("button", { name: "「予約受付」の固定ボードへ移る" }));
    expect(st().ui.mode).toBe("analysis");
    expect(st().ui.currentBoardId).toBe("fixed:business");
  });

  it("検証の途切れ箇所のリンク: 情報整理モードでは、要素を主役にする情報整理のボードへ移って選ぶ (詳細調整へ切り替えない)", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "activity", name: "孤立した作業", id: "act_x" }));
    });
    render(<TracePanel />);
    fireEvent.click(screen.getByRole("button", { name: "孤立した作業" }));
    expect(st().ui.mode).toBe("analysisSimple");
    expect(st().ui.currentBoardId).toBe("simple:workflow");
    expect(st().ui.selection).toEqual({ type: "element", id: "act_x" });
  });

  it("情報整理のボードの主役でない種類 (システム・帳票) のリンクは、今までどおり固定ボードへ移る", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "system", name: "孤立したシステム", id: "sys_x" }));
    });
    act(() => st().setRightPanel("issues"));
    act(() => void st().dispatch((m) => ({ ok: true, model: { ...m, elements: m.elements.map((e) => (e.id === "issue_extra_missing" ? { ...e, targetIds: ["sys_x"] } : e)) as typeof m.elements } })));
    render(<IssuePanel />);
    fireEvent.click(screen.getByRole("button", { name: "対象ごと" }));
    fireEvent.click(screen.getByRole("button", { name: "「孤立したシステム」の固定ボードへ移る" }));
    // システム・帳票のレイヤー (登場人物の固定ボード) は情報整理モードでも開けるので、モードは変わらない
    expect(st().ui.currentBoardId).toBe("fixed:actor");
    expect(st().ui.mode).toBe("analysisSimple");
  });
});

describe("情報整理モードの課題の対象が非機能要件 (情報整理のボードの主役ではない) のとき", () => {
  it("固定ボードへ移る「移動」を出し、押すと固定ボードへ移る。システム・帳票が対象のときは出さない", () => {
    act(() => {
      useUntieStore.setState((s) => ({
        model: {
          ...s.model,
          elements: [...s.model.elements, { id: "nfr_fast", kind: "nfr", name: "速く応答する", systemId: "sys_pms" }].map((e) => (e.id === "issue_extra_missing" ? { ...e, targetIds: ["nfr_fast", "sys_pms"] } : e)) as typeof s.model.elements,
        },
      }));
      st().select({ type: "element", id: "issue_extra_missing" });
    });
    render(<PropertyPanel />);
    expect(screen.queryByRole("button", { name: "「宿泊管理システム」の固定ボードへ移る" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "「速く応答する」の固定ボードへ移る" }));
    expect(st().ui.currentBoardId).toBe("fixed:nfr");
  });
});

describe("「移動」で選ぶ要素 (UI)", () => {
  it("操作の行の「移動」は、行き先に出ている主の種類 (操作) を選ぶ (選ぶ規則そのものは core の pickSimpleTarget のテスト)", () => {
    act(() => st().select({ type: "element", id: "act_create_bill" }));
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "操作をシステム操作ボードで見る" }));
    const sel = st().ui.selection;
    expect(st().model.elements.find((e) => sel?.type === "element" && e.id === sel.id)?.kind).toBe("usecase");
  });
});

describe("情報整理モードで登場人物の固定ボードにいるとき", () => {
  const select = (id: string) => act(() => st().select({ type: "element", id }));

  it("最初のボードは登場人物 (固定ボード)。プロパティの種類は「登場人物」と呼ぶ", () => {
    expect(st().ui.currentBoardId).toBe("fixed:actor");
    select("actor_front");
    render(<PropertyPanel />);
    expect(screen.getByText("登場人物", { selector: ".kind-line" })).toBeDefined();
  });

  it("トレース表の「移動」: 行き先に情報整理のボードがあるレイヤーは、そのボードへ移る。情報整理モードのまま", () => {
    select("actor_front");
    render(<PropertyPanel />);
    const row = screen.getByText("業務", { selector: "th, th *" }).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "業務を業務一覧ボードで見る" }));
    expect(st().ui.mode).toBe("analysisSimple");
    expect(st().ui.currentBoardId).toBe("simple:workflow");
    expect(st().ui.selection).not.toBeNull();
  });

  it("課題の対象の「移動」: 登場人物ボードにいても、情報整理のボードがある種類はそのボードへ移り、情報整理のまま", () => {
    select("issue_extra_missing");
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "「追加料金を登録する」をシステム操作ボードで見る" }));
    expect(st().ui.mode).toBe("analysisSimple");
    expect(st().ui.currentBoardId).toBe("simple:operation");
  });

  it("課題一覧の対象の「移動」と revealElement: 作業は業務一覧ボードへ移る (詳細調整へ切り替えない)", async () => {
    const { revealElement } = await import("../actions");
    act(() => revealElement("act_hand_key"));
    expect(st().ui.mode).toBe("analysisSimple");
    expect(st().ui.currentBoardId).toBe("simple:workflow");
    expect(st().ui.selection).toEqual({ type: "element", id: "act_hand_key" });
  });

  it("登場人物ボードを開いたまま詳細調整に切り替えると、登場人物のまま。詳細調整の登場人物から情報整理へ切り替えても残る。ほかのボードからは最初のボードへ", () => {
    expect(st().ui.currentBoardId).toBe("fixed:actor");
    act(() => st().setMode("analysis"));
    expect(st().ui.mode).toBe("analysis");
    expect(st().ui.currentBoardId).toBe("fixed:actor");
    act(() => st().setMode("analysisSimple"));
    expect(st().ui.currentBoardId).toBe("fixed:actor");
    act(() => st().setCurrentBoard("simple:workflow"));
    act(() => st().setMode("analysis"));
    expect(st().ui.currentBoardId).toBe("analysis:issues");
  });

  it("登場人物ボードでシステム・帳票を選ぶと、削除が出て、確認 (巻き込まれるもの) を通して消せる。「詳細調整で直せます」の案内は出ない", () => {
    select("sys_pms");
    render(<PropertyPanel />);
    expect(screen.queryByText(/詳細調整で直せます/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    // 巻き込まれるものがあれば確認を通る (無ければそのまま消える。プロパティの削除の規則)
    const confirm = screen.queryByRole("button", { name: "削除する" });
    if (confirm) fireEvent.click(confirm);
    expect(st().model.elements.some((e) => e.id === "sys_pms")).toBe(false);
  });

  it("登場人物ボードの帳票も消せる (そのボードで作れる種類は、同じボードで消せる)", () => {
    select("ldg_guest_register");
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const confirm = screen.queryByRole("button", { name: "削除する" });
    if (confirm) fireEvent.click(confirm);
    expect(st().model.elements.some((e) => e.id === "ldg_guest_register")).toBe(false);
  });

  it("登場人物ボードの呼び方は「登場人物」「外部の登場人物」。グローバルフィルターは出さない。詳細調整は今までどおり", async () => {
    const { FixedBoard } = await import("../FixedBoard");
    const { unmount } = render(<FixedBoard layer="actor" />);
    expect(screen.getAllByRole("button", { name: /に登場人物を追加$/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /に外部の登場人物を追加$/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /に(外部)?アクターを追加$/ })).toBeNull();
    expect(document.querySelector(".global-filter, [data-testid=global-filter]")).toBeNull();
    expect(screen.queryByText("アクター", { selector: ".card-kind-inline" })).toBeNull();
    expect(screen.getAllByText("登場人物", { selector: ".card-kind-inline" }).length).toBeGreaterThan(0);
    unmount();
    act(() => st().setMode("analysis"));
    act(() => st().setCurrentBoard("fixed:actor"));
    render(<FixedBoard layer="actor" />);
    expect(screen.getAllByRole("button", { name: /にアクターを追加$/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("アクター", { selector: ".card-kind-inline" }).length).toBeGreaterThan(0);
  });

  it("登場人物ボードでは、詳細調整で付けたグローバルフィルターを適用しない", async () => {
    const { FixedBoard } = await import("../FixedBoard");
    act(() => st().setGlobalFilter("business", ["biz_checkin"]));
    render(<FixedBoard layer="actor" />);
    const count = document.querySelectorAll("[data-fixed-card]").length;
    act(() => st().resetGlobalFilter());
    document.body.innerHTML = "";
    render(<FixedBoard layer="actor" />);
    expect(document.querySelectorAll("[data-fixed-card]").length).toBe(count);
  });
});

