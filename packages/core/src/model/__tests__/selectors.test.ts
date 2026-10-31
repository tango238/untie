import { describe, expect, it } from "vitest";
import { setIssueTargets } from "../commands";
import { issueBoardSections, issueScope, issueSummaries, issuesByScope, issuesTargeting, listableElements, sortedIssues } from "../selectors";
import type { Issue, UntieModel } from "../types";
import { okModel, sample } from "./helpers";

const issueOf = (m: UntieModel, id: string) => m.elements.find((e) => e.id === id) as Issue;

describe("課題の区分", () => {
  it("対象の種類で、全体的 (登場人物)・具体的 (業務・作業・操作)・未整理 (対象なし) に分かれる", () => {
    let m = sample();
    expect(issueScope(m, issueOf(m, "issue_manual_entry"))).toBe("specific");
    m = okModel(setIssueTargets(m, { issueId: "issue_manual_entry", targetIds: ["actor_front", "sys_pms"] }));
    expect(issueScope(m, issueOf(m, "issue_manual_entry"))).toBe("overall");
    m = okModel(setIssueTargets(m, { issueId: "issue_cancel_explain", targetIds: [] }));
    expect(issueScope(m, issueOf(m, "issue_cancel_explain"))).toBe("unsorted");
    const by = issuesByScope(m);
    expect(by.overall.map((i) => i.id)).toEqual(["issue_manual_entry"]);
    expect(by.unsorted.map((i) => i.id)).toEqual(["issue_cancel_explain"]);
    expect(by.specific).toHaveLength(3);
  });

  it("対象ごとの並びは 未整理 → 全体的 → 具体的 の順。全体的・具体的は対象ごとにまとめ、対象は 登場人物 → 業務 → 作業 → 操作 の順", () => {
    let m = sample();
    m = okModel(setIssueTargets(m, { issueId: "issue_manual_entry", targetIds: ["sys_pms", "actor_front"] }));
    m = okModel(setIssueTargets(m, { issueId: "issue_cancel_explain", targetIds: [] }));
    const sections = issueBoardSections(m);
    expect(sections.map((s) => s.scope)).toEqual(["unsorted", "overall", "specific"]);
    expect(sections[0]!.groups).toEqual([{ target: null, issues: [issueOf(m, "issue_cancel_explain")] }]);
    // 対象が 2 つある課題は、それぞれの対象の下に出る。アクター → システムの順
    expect(sections[1]!.groups.map((g) => g.target!.id)).toEqual(["actor_front", "sys_pms"]);
    expect(sections[1]!.count).toBe(1);
    const kinds = sections[2]!.groups.map((g) => g.target!.kind);
    const order = ["business", "activity", "usecase"];
    expect(kinds).toEqual([...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(sections[2]!.count).toBe(3);
  });
});

describe("selectors", () => {
  it("課題は重要度の降順、同点は名前順", () => {
    const issues = sortedIssues(sample());
    expect(issues).toHaveLength(5);
    for (let i = 1; i < issues.length; i++) {
      expect(issues[i - 1]!.severity).toBeGreaterThanOrEqual(issues[i]!.severity);
    }
    expect(issues[0]!.id).toBe("issue_manual_entry");
    const sev4 = issues.filter((x) => x.severity === 4).map((x) => x.name);
    expect(sev4).toEqual([...sev4].sort((a, b) => a.localeCompare(b, "ja")));
  });

  it("要素ごとの課題バッジ (件数と最高重要度)", () => {
    const m = sample();
    const map = issueSummaries(m);
    const issue = m.elements.find((e) => e.id === "issue_manual_entry")!;
    if (issue.kind !== "issue") throw new Error();
    const t = issue.targetIds[0]!;
    expect(map.get(t)!.count).toBeGreaterThanOrEqual(1);
    expect(map.get(t)!.maxSeverity).toBeGreaterThanOrEqual(5);
    expect(map.get("actor_front")).toBeUndefined();
    expect(issuesTargeting(m, t).map((i) => i.id)).toContain("issue_manual_entry");
  });

  it("listableElements は既定の活動を除く", () => {
    const m = sample();
    const list = listableElements(m);
    expect(list.some((e) => e.kind === "buc" && e.isDefault)).toBe(false);
    expect(list.filter((e) => e.kind === "buc").map((e) => e.id).sort()).toEqual(["buc_dining", "buc_extra_charge", "buc_room_care"]);
  });
});

describe("activityHours", () => {
  it("作業自身の時間と、使う操作の時間の合計を分けて返す。時間の入った操作が無ければ合計は無い", async () => {
    const { activityHours, formatHours } = await import("../selectors");
    const { updateElement } = await import("../commands");
    const { okModel, sample } = await import("./helpers");
    let m = sample();
    // 本人確認をする: 作業 0.1、操作「チェックインを記録する」0.2
    expect(activityHours(m, "act_verify_identity")).toEqual({ own: 0.1, usecases: 0.2 });
    // 部屋を割り当てる: 操作だけ
    expect(activityHours(m, "act_assign_room")).toEqual({ usecases: 0.1 });
    // 鍵を渡す: どちらも無い
    expect(activityHours(m, "act_hand_key")).toEqual({});
    // 予約内容を確認する: 予約を検索する 0.1 + 予約を確定する 0.2 = 0.3 (小数の誤差を丸める)
    m = okModel(updateElement(m, { id: "uc_confirm_reservation", patch: { hours: 0.2 } }));
    expect(activityHours(m, "act_confirm_reservation")).toEqual({ usecases: 0.3 });
    expect(formatHours(0.3)).toBe("0.3 時間");
    expect(formatHours(2)).toBe("2.0 時間");
  });
});
