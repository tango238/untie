// 課題の深掘り: 道具はその課題だけを変え、最初の発言には課題と対象のまわりが入る。
import { describe, expect, it } from "vitest";
import { okModel, sample } from "../../model/__tests__/helpers";
import { setIssueTargets } from "../../model/commands";
import type { CommandResult } from "../../model/commands";
import type { Issue, UntieModel } from "../../model/types";
import { executeGrillTool, GRILL_TOOLS, grillOpening, grillSystemPrompt } from "../grill";
import type { ModelEditor } from "../tools";

function editorOf(initial: UntieModel): ModelEditor & { model: UntieModel } {
  const e = {
    model: initial,
    getModel: () => e.model,
    apply: <T,>(cmd: (m: UntieModel) => CommandResult<T>) => {
      const r = cmd(e.model);
      if (r.ok) e.model = r.model;
      return r;
    },
  };
  return e;
}
const issueOf = (m: UntieModel, id: string) => m.elements.find((e) => e.id === id) as Issue;
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe("課題の深掘り", () => {
  it("道具は 3 つで、すべて executeGrillTool で扱える", () => {
    const e = editorOf(sample());
    expect(GRILL_TOOLS.map((t) => t.name)).toEqual(["get_model", "update_issue_analysis", "set_issue_targets"]);
    for (const t of GRILL_TOOLS) expect(String(parse(executeGrillTool(e, "issue_checkin_queue", t.name, {}).content).error ?? "")).not.toMatch(/不明な道具/);
    expect(executeGrillTool(e, "issue_checkin_queue", "add_element", { kind: "activity", name: "x" }).ok).toBe(false);
  });

  it("update_issue_analysis は深掘り中の課題の分析と重要度だけを書く", () => {
    const e = editorOf(sample());
    const r = executeGrillTool(e, "issue_checkin_queue", "update_issue_analysis", { phenomenon: "15 時台に到着が重なる", cause: "本人確認が手書き", severity: 5 });
    expect(r.ok && r.changed).toBe(true);
    expect(issueOf(e.model, "issue_checkin_queue")).toMatchObject({ severity: 5, analysis: { phenomenon: "15 時台に到着が重なる", cause: "本人確認が手書き" } });
    // 他の課題の原文と分析は触らない
    expect(issueOf(e.model, "issue_manual_entry")).toMatchObject({ severity: 5, description: "予約サイトの管理画面を見ながら、予約台帳へ手入力している。" });
    expect(executeGrillTool(e, "issue_checkin_queue", "update_issue_analysis", {}).ok).toBe(false);
    expect(executeGrillTool(e, "issue_checkin_queue", "update_issue_analysis", { severity: 9 }).ok).toBe(false);
    expect(executeGrillTool(e, "nope", "update_issue_analysis", { cause: "x" }).ok).toBe(false);
  });

  it("set_issue_targets は対象を置き換え、登場人物と業務・作業・操作を混ぜると失敗する", () => {
    const e = editorOf(sample());
    expect(executeGrillTool(e, "issue_checkin_queue", "set_issue_targets", { target_ids: ["act_verify_identity"] }).ok).toBe(true);
    expect(issueOf(e.model, "issue_checkin_queue").targetIds).toEqual(["act_verify_identity"]);
    const mixed = executeGrillTool(e, "issue_checkin_queue", "set_issue_targets", { target_ids: ["act_verify_identity", "actor_front"] });
    expect(mixed.ok).toBe(false);
    expect(executeGrillTool(e, "issue_checkin_queue", "set_issue_targets", {}).ok).toBe(false);
    expect(executeGrillTool(e, "issue_checkin_queue", "set_issue_targets", { target_ids: [] }).ok).toBe(true);
    expect(issueOf(e.model, "issue_checkin_queue").targetIds).toEqual([]);
  });

  it("最初の発言には課題と、対象の所属・つながり (担当や使う操作) が入る", () => {
    const m = sample();
    const text = grillOpening(m, issueOf(m, "issue_checkin_queue"));
    const data = JSON.parse(text.slice(text.indexOf("<課題>") + 4, text.indexOf("</課題>"))) as {
      issue: Record<string, unknown>;
      targets: { id: string; belongsTo?: { name: string }[]; relations: { label: string; name: string }[] }[];
    };
    expect(data.issue).toMatchObject({ id: "issue_checkin_queue", name: "繁忙期にチェックインの列ができる", severity: 4 });
    expect(data.issue).not.toHaveProperty("analysis");
    const verify = data.targets.find((t) => t.id === "act_verify_identity")!;
    expect(verify.belongsTo?.map((b) => b.name)).toEqual(["チェックイン"]);
    expect(verify.relations.map((r) => r.label)).toContain("担当");
    expect(verify.relations.some((r) => r.name === "フロント担当")).toBe(true);
  });

  it("未整理の課題は対象が空で渡され、既にある分析は渡される", () => {
    let m = sample();
    m = okModel(setIssueTargets(m, { issueId: "issue_checkin_queue", targetIds: [] }));
    const issue = { ...issueOf(m, "issue_checkin_queue"), analysis: { cause: "前回の見立て" } };
    const text = grillOpening(m, issue);
    expect(text).toContain('"targets": []');
    expect(text).toContain("前回の見立て");
  });

  it("指示には 4 つの軸と、了承までは道具で変えない決まりが入る", () => {
    const p = grillSystemPrompt();
    for (const w of ["現象", "所在", "理由", "影響", "➡️ 推奨", "了承するまで道具で課題を変えない", "get_model"]) expect(p).toContain(w);
  });
});
