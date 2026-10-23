import { describe, expect, it } from "vitest";
import { issueSummaries, issuesTargeting, listableElements, sortedIssues } from "../selectors";
import { sample } from "./helpers";

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
    expect(list.filter((e) => e.kind === "buc").map((e) => e.id).sort()).toEqual(["buc_dining", "buc_room_care"]);
  });
});
