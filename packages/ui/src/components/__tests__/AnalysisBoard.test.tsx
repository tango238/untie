import { setDevModeForTest } from "../../devMode";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ANALYSIS_KINDS, ANALYSIS_LABELS } from "@untie/core/model/analysis";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { AnalysisBoard } from "../analysis/AnalysisBoard";
import { addElement, setIssueTargets } from "@untie/core/model/commands";
import { createAccountingSample, createNetshopSample } from "@untie/core/sample";
import { Toolbar } from "../Toolbar";

const st = () => useUntieStore.getState();
beforeEach(() => {
  resetStore();
  // イベントストーミングは、開発モードのときだけ出る (devMode.ts)
  setDevModeForTest(true);
});

describe("AnalysisBoard", () => {
  it("4 種類とも見出しを出して描ける。ツールバーの「分析ボード」から切り替えられ、名前変更・削除はできない", () => {
    for (const k of ANALYSIS_KINDS) {
      const { unmount } = render(<AnalysisBoard kind={k} />);
      expect(screen.getByRole("heading", { name: ANALYSIS_LABELS[k] })).toBeDefined();
      unmount();
    }
    render(<Toolbar />);
    const select = screen.getByLabelText("ボード") as HTMLSelectElement;
    expect(select.querySelectorAll('optgroup[label="分析ボード"] option')).toHaveLength(4);
    fireEvent.change(select, { target: { value: "analysis:people" } });
    expect(st().ui.currentBoardId).toBe("analysis:people");
    expect((screen.getByRole("button", { name: "名前変更" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("担当別の作業一覧: 担い手で絞り込め、作業のリンクを出し、作業を選ぶとプロパティ欄に出す", () => {
    render(<AnalysisBoard kind="people" />);
    fireEvent.change(screen.getByLabelText("担い手"), { target: { value: "actor_front" } });
    const front = screen.getByRole("region", { name: "フロント担当" });
    expect(screen.queryByRole("region", { name: "予約担当" })).toBeNull();
    expect(within(front).getByRole("button", { name: /鍵の受け渡しマニュアル/ })).toBeDefined();
    fireEvent.click(within(front).getByRole("button", { name: "鍵を渡す" }));
    expect(st().ui.selection).toEqual({ type: "element", id: "act_hand_key" });
    expect(st().ui.rightPanel).toBe("properties");
  });

  it("要素一覧などからの選択で、分析ボードの要素へスクロールを依頼できる", () => {
    act(() => st().setCurrentBoard("analysis:people"));
    render(<AnalysisBoard kind="people" />);
    expect(document.querySelector('[data-analysis-el="act_hand_key"]')).not.toBeNull();
  });
});

describe("課題の分布", () => {
  it("未整理の課題 (対象なし) を別の表に出す。業務の表には入れない", () => {
    useUntieStore.getState().dispatch((m) => setIssueTargets(m, { issueId: "issue_cancel_explain", targetIds: [] }));
    render(<AnalysisBoard kind="issues" />);
    const heading = screen.getByRole("heading", { name: "未整理の課題 (対象なし)" });
    const table = heading.nextElementSibling as HTMLElement;
    expect(within(table).getByText("取消料の説明が担当者によって違う")).toBeDefined();
    expect(screen.getAllByText("取消料の説明が担当者によって違う")).toHaveLength(1);
  });

  it("未整理の課題が無いときはその旨を出す", () => {
    render(<AnalysisBoard kind="issues" />);
    expect(screen.getByText("対象のない課題はありません。")).toBeDefined();
  });
});

describe("情報の所在: 画面と情報", () => {
  it("システムごとに画面 × 情報の表を出す (扱う情報は使う操作から導き、取得・保存を出す)。情報を扱わない画面に印を付け、画面の無いシステムは 1 行にまとめる", () => {
    act(() => {
      useUntieStore.getState().newDocument(createNetshopSample(), { pristine: true });
    });
    render(<AnalysisBoard kind="informationLocation" />);
    const region = screen.getByRole("region", { name: "画面と情報" });
    expect(within(region).getByText("画面と情報")).toBeDefined();
    const accounting = within(region).getByTestId("screen-table-sys_accounting");
    const report = within(accounting).getByRole("row", { name: /月次レポート/ });
    // 月次レポートを使う操作は PL・BS を取得だけする
    expect(within(report).getAllByText("取得")).toHaveLength(2);
    expect(within(report).queryByText("保存")).toBeNull();
    expect(within(report).getByRole("button", { name: "月次の数字を報告する" })).toBeDefined();
    expect(within(region).getByText(/画面の無いシステム:/).textContent).toContain("自社サイトのカート");
    // 情報を扱わない画面
    act(() => {
      const st = useUntieStore.getState();
      st.dispatch((m) => addElement(m, { kind: "screen", name: "空の画面", id: "scr_empty", init: { systemId: "sys_accounting" } }));
    });
    const empty = within(screen.getByTestId("screen-table-sys_accounting")).getByRole("row", { name: /空の画面/ });
    expect(within(empty).getByText("扱う情報なし")).toBeDefined();
  });
});

describe("情報の所在: システムのイベント", () => {
  it("システムごとに、イベントと発生のしかた (直接・操作から) と、きっかけにする操作を出す。イベントの無いシステムは 1 行にまとめる", () => {
    act(() => {
      useUntieStore.getState().newDocument(createNetshopSample(), { pristine: true });
    });
    render(<AnalysisBoard kind="informationLocation" />);
    const region = screen.getByRole("region", { name: "システムのイベント" });
    expect(within(region).getByText("システムのイベント")).toBeDefined();
    const accounting = within(region).getByTestId("event-list-sys_accounting");
    const closed = within(accounting).getByRole("row", { name: /月次の締めが済んだ/ });
    expect(within(closed).getByText("直接")).toBeDefined();
    expect(within(closed).getByRole("button", { name: "損益計算書を見る" })).toBeDefined();
    expect(within(closed).getByRole("button", { name: "損益を確認する" })).toBeDefined();
    const sales = within(region).getByTestId("event-list-sys_oms");
    const fixed = within(sales).getByRole("row", { name: /注文が確定した/ });
    expect(within(fixed).getByText("操作から")).toBeDefined();
    expect(within(fixed).getByRole("button", { name: "注文を確定する" })).toBeDefined();
    expect(within(fixed).getByText("(作業なし)")).toBeDefined();
    expect(within(region).getByText(/イベントの無いシステム:/).textContent).toContain("モールの管理画面");
    expect(within(region).queryByTestId("events-without-system")).toBeNull();
  });
});

describe("イベントストーミング", () => {
  it("気づき (問い・情報) と、Actor | コマンド | 集約 | イベント | 備考 の表を出し、要素を選べる", () => {
    act(() => {
      useUntieStore.getState().newDocument(createNetshopSample(), { pristine: true });
    });
    render(<AnalysisBoard kind="storming" />);
    expect(screen.getByRole("heading", { name: "イベントストーミング" })).toBeDefined();
    // 気づき: 問いは開いて出し、情報は畳む
    const notices = screen.getByRole("region", { name: "気づき" });
    const boundary = within(notices).getByTestId("notice-boundaryStateChange") as HTMLDetailsElement;
    expect(boundary.open).toBe(true);
    expect(within(boundary).getByText(/「入金を記録する」\(対象: 決済サービス\)/)).toBeDefined();
    expect((within(notices).getByTestId("notice-eventWithoutConsumer") as HTMLDetailsElement).open).toBe(false);
    // 表: 自動の処理はきっかけつき、共有された操作は作業ごとの行、備考に気づきの見出し
    const table = screen.getByRole("region", { name: "イベントストーミングの表" });
    const alloc = within(table).getByTestId("storming-usecase:uc_allocate_stock");
    expect(within(alloc).getByText("自動")).toBeDefined();
    expect(within(alloc).getByRole("button", { name: "注文が確定した" })).toBeDefined();
    expect(within(alloc).getByText("条件を満たさないときの結果が無い")).toBeDefined();
    expect(within(table).getByTestId("storming-usecase:uc_update_stock/activity:act_restock")).toBeDefined();
    // 読むだけでも状態を変える・イベントを出す操作は表に行があり、「取得だけ」の印と備考 (境界の問い) が付く。読み取りモデルには並ばない
    const payment = within(table).getByTestId("storming-usecase:uc_record_payment");
    expect(within(payment).getByText("取得だけ")).toBeDefined();
    expect(within(payment).getByRole("button", { name: "入金が確認された" })).toBeDefined();
    expect(within(payment).getByText("別のシステムの操作が状態を変えている")).toBeDefined();
    expect(within(screen.getByRole("region", { name: "読み取りモデルの候補" })).queryByTestId("query-uc_record_payment")).toBeNull();
    // 操作から出ないイベントはコマンド無しの行
    const closed = within(table).getByTestId("storming-event-ev_month_closed");
    expect(within(closed).getByRole("button", { name: "会計システム" })).toBeDefined();
    // 集約・ポリシー・読み取りモデル
    const agg = within(screen.getByRole("region", { name: "集約の候補" })).getByTestId("aggregate-info_order");
    expect(within(agg).getByText("ルート候補 (状態を持つ)")).toBeDefined();
    expect(within(screen.getByRole("region", { name: "ポリシーの候補" })).getAllByText("コンテキストをまたぐ")).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "読み取りモデルの候補" })).getByTestId("query-uc_search_order")).toBeDefined();
    // 要素名を押すと選択してプロパティ欄に出す
    fireEvent.click(within(alloc).getByRole("button", { name: "在庫を引き当てる" }));
    expect(st().ui.selection).toEqual({ type: "element", id: "uc_allocate_stock" });
    expect(st().ui.rightPanel).toBe("properties");
  });

  it("イベントの無いモデルでは、イベントが無いことを 1 件の情報で知らせる", () => {
    act(() => {
      useUntieStore.getState().newDocument(createAccountingSample(), { pristine: true });
    });
    render(<AnalysisBoard kind="storming" />);
    expect(screen.getByTestId("notice-noEvents").textContent).toContain("イベントがまだ無い");
    expect(screen.getByText("イベントをきっかけにする操作がまだありません。")).toBeDefined();
  });
});
