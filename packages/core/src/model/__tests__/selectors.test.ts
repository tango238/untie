import { describe, expect, it } from "vitest";
import { addRelation, setIssueTargets } from "../commands";
import { activitiesTriggeredBy, activityTriggers, issueBoardSections, issueScope, issueSummaries, issuesByScope, issuesTargeting, listableElements, sortedIssues, triggerSummaries, triggerSummary } from "../selectors";
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

describe("作業の起点", () => {
  it("activityTriggers は起点の作業・イベント・その他を返し、activitiesTriggeredBy は後続の作業を返す", () => {
    const m = sample();
    const t = activityTriggers(m, "act_create_bill");
    expect(t.activities).toEqual([]);
    expect(t.events.map((e) => e.name)).toEqual(["チェックアウトの日になった"]);
    expect(activityTriggers(m, "act_accept_reservation")).toEqual({ activities: [], events: [], note: "電話・予約サイトからの申し込み" });
    expect(activityTriggers(m, "act_clean").activities.map((e) => e.name)).toEqual(["清掃を指示する"]);
    expect(activityTriggers(m, "uc_calc_charge")).toEqual({ activities: [], events: [] });
    expect(activitiesTriggeredBy(m, "act_clean").map((e) => e.name)).toEqual(["部屋を点検する"]);
  });

  it("triggerSummary は「起点: 作業 / イベント (イベント) / その他」の順。起点が無ければ undefined。triggerSummaries は 1 度の走査で全作業ぶん返す", () => {
    let m = sample();
    expect(triggerSummary(m, "act_create_bill")).toBe("起点: チェックアウトの日になった (イベント)");
    expect(triggerSummary(m, "act_change_cancel")).toBe("起点: 宿泊客からの電話・メール");
    expect(triggerSummary(m, "act_hand_key")).toBe("起点: 部屋を割り当てる");
    m = okModel(addRelation(m, { sourceId: "ev_checkout_day", targetId: "act_change_cancel" }));
    m = okModel(addRelation(m, { sourceId: "act_clean", targetId: "act_change_cancel" }));
    expect(triggerSummary(m, "act_change_cancel")).toBe("起点: 清掃する / チェックアウトの日になった (イベント) / 宿泊客からの電話・メール");
    expect(triggerSummary(m, "uc_calc_charge")).toBeUndefined();
    const all = triggerSummaries(m);
    expect(all.get("act_change_cancel")).toBe(triggerSummary(m, "act_change_cancel"));
    expect(all.has("act_collect_key")).toBe(true);
    expect(all.has("act_identity_none")).toBe(false);
  });
});
