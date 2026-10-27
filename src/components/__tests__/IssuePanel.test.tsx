import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { IssuePanel } from "../IssuePanel";
import { setIssueTargets } from "../../model/commands";

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
    expect(screen.getByText(/課題はまだありません/)).toBeDefined();
  });

  it("未整理・全体的な課題・具体的な課題に分け、対象には種類を添える", () => {
    useUntieStore.getState().dispatch((m) => setIssueTargets(m, { issueId: "issue_manual_entry", targetIds: ["actor_front"] }));
    useUntieStore.getState().dispatch((m) => setIssueTargets(m, { issueId: "issue_cancel_explain", targetIds: [] }));
    render(<IssuePanel />);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "未整理の課題 (1)",
      "全体的な課題 (1)",
      "具体的な課題 (3)",
    ]);
    const overall = within(screen.getByRole("region", { name: "全体的な課題" }));
    expect(overall.getByRole("button", { name: "アクターフロント担当" })).toBeDefined();
    expect(within(screen.getByRole("region", { name: "未整理の課題" })).getByText("対象なし")).toBeDefined();
  });

  it("「＋課題」で対象のない課題を作り、選んで名前の入力へ移る。どのボードでも重要度と対象を編集できる", () => {
    const st = useUntieStore.getState;
    expect(st().ui.currentBoardId).toBe("board_overview"); // 自由ボード
    render(<IssuePanel />);
    const count = st().model.elements.length;
    fireEvent.click(screen.getByRole("button", { name: "＋課題" }));
    expect(st().model.elements.length).toBe(count + 1);
    const created = st().model.elements.find((e) => e.id === st().ui.selection!.id)!;
    expect(created).toMatchObject({ kind: "issue", targetIds: [] });
    expect(st().ui.rightPanel).toBe("properties");
  });

  it("「対象ごと」では全体的・具体的な課題を対象の要素ごとにまとめ、そこから移動・課題の追加ができる", () => {
    const st = useUntieStore.getState;
    st().dispatch((m) => setIssueTargets(m, { issueId: "issue_manual_entry", targetIds: ["actor_front", "sys_pms"] }));
    st().setRightPanel("issues");
    render(<IssuePanel />);
    fireEvent.click(screen.getByRole("button", { name: "対象ごと" }));
    const overall = within(screen.getByRole("region", { name: "全体的な課題" }));
    // 対象が 2 つある課題は、それぞれのまとまりに出る。アクター → システムの順
    expect(overall.getAllByTestId(/^issue-target-/).map((e) => e.getAttribute("data-testid"))).toEqual([
      "issue-target-actor_front",
      "issue-target-sys_pms",
    ]);
    const checkin = within(screen.getByTestId("issue-target-biz_checkin"));
    expect(checkin.getByText("繁忙期にチェックインの列ができる")).toBeDefined();
    fireEvent.click(checkin.getByRole("button", { name: "「チェックイン」を対象に課題を追加" }));
    expect(st().model.elements.find((e) => e.id === st().ui.selection!.id)).toMatchObject({ kind: "issue", targetIds: ["biz_checkin"] });
    st().setRightPanel("issues");
    fireEvent.click(within(screen.getByTestId("issue-target-biz_checkin")).getByRole("button", { name: "「チェックイン」の固定ボードへ移る" }));
    expect(st().ui.currentBoardId).toBe("fixed:business");
    expect(st().ui.selection).toEqual({ type: "element", id: "biz_checkin" });
  });
});
