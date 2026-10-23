import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ANALYSIS_KINDS, ANALYSIS_LABELS } from "../../model/analysis";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { AnalysisBoard } from "../analysis/AnalysisBoard";
import { Toolbar } from "../Toolbar";

const st = () => useUntieStore.getState();
beforeEach(() => resetStore());

describe("AnalysisBoard", () => {
  it("6 種類とも見出しを出して描ける。ツールバーの「分析ボード」から切り替えられ、名前変更・削除はできない", () => {
    for (const k of ANALYSIS_KINDS) {
      const { unmount } = render(<AnalysisBoard kind={k} />);
      expect(screen.getByRole("heading", { name: ANALYSIS_LABELS[k] })).toBeDefined();
      unmount();
    }
    render(<Toolbar />);
    const select = screen.getByLabelText("ボード") as HTMLSelectElement;
    expect(select.querySelectorAll('optgroup[label="分析ボード"] option')).toHaveLength(6);
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

  it("業務とコンテキストの結合: 業務ごと・活動ごとを切り替え、数をクリックすると元の道筋を出す", () => {
    render(<AnalysisBoard kind="businessContext" />);
    fireEvent.click(screen.getByRole("button", { name: "予約受付 と 予約: 操作 5 件" }));
    const detail = screen.getByRole("region", { name: "元の道筋" });
    expect(within(detail).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("radio", { name: "活動ごと" }));
    expect(screen.queryByRole("region", { name: "元の道筋" })).toBeNull();
    expect(screen.getByRole("rowheader", { name: /飲食提供/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /^チェックイン と 予約/ })).toBeDefined();
  });

  it("コンテキストの結合: 結合の数をクリックすると元の関係を出す", () => {
    render(<AnalysisBoard kind="contextCoupling" />);
    fireEvent.click(screen.getAllByRole("button", { name: "予約 と 顧客: 関係 1 件" })[0]!);
    const detail = screen.getByRole("region", { name: "元の関係" });
    expect(within(detail).getByText("関連")).toBeDefined();
  });

  it("要素一覧などからの選択で、分析ボードの要素へスクロールを依頼できる", () => {
    act(() => st().setCurrentBoard("analysis:workFlow"));
    render(<AnalysisBoard kind="workFlow" />);
    expect(document.querySelector('[data-analysis-el="act_hand_key"]')).not.toBeNull();
  });
});
