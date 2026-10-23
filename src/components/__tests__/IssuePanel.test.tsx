import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { IssuePanel } from "../IssuePanel";

beforeEach(() => resetStore());

describe("IssuePanel", () => {
  it("重要度の高い順に並ぶ", () => {
    render(<IssuePanel />);
    const ids = screen.getAllByTestId(/^issue-/).map((e) => e.getAttribute("data-testid"));
    expect(ids[0]).toBe("issue-issue_manual_entry");
    expect(ids).toHaveLength(5);
    expect(ids[ids.length - 1]).toBe("issue-issue_cancel_explain");
  });

  it("行クリックで課題を選択してプロパティ欄へ切り替える", () => {
    useUntieStore.getState().setRightPanel("issues");
    render(<IssuePanel />);
    fireEvent.click(within(screen.getByTestId("issue-issue_extra_missing")).getByText("追加料金の記録漏れがある"));
    const ui = useUntieStore.getState().ui;
    expect(ui.selection).toEqual({ type: "element", id: "issue_extra_missing" });
    expect(ui.rightPanel).toBe("properties");
  });

  it("対象名クリックで対象要素を選択する (パネルはそのまま)", () => {
    useUntieStore.getState().setRightPanel("issues");
    render(<IssuePanel />);
    fireEvent.click(within(screen.getByTestId("issue-issue_manual_entry")).getByText("予約受付"));
    const ui = useUntieStore.getState().ui;
    expect(ui.selection).toEqual({ type: "element", id: "biz_reservation" });
    expect(ui.rightPanel).toBe("issues");
  });

  it("課題が無いときは案内を出す", () => {
    resetStore({ ...useUntieStore.getState().model, elements: [], relations: [] });
    render(<IssuePanel />);
    expect(screen.getByText(/課題はありません/)).toBeDefined();
  });
});
