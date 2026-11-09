// 困りごとのヒアリング: 最初の発言の材料、道具の実行 (課題の登録・追記・ペルソナ)、指示の内容。
import { describe, expect, it } from "vitest";
import { okModel, sample } from "@untie/core/testing";
import { setPersona } from "@untie/core/model/commands";
import type { CommandResult } from "@untie/core/model/commands";
import { validateModel } from "@untie/core/model/validate";
import type { Issue, UntieModel } from "@untie/core/model/types";
import { executeHearingTool, HEARING_SUMMARY_REQUEST, HEARING_TOOLS, hearingOpening, hearingSystemPrompt } from "../hearing";
import { MODEL_TOOLS, executeTool, type ModelEditor } from "../tools";

function editorOf(initial: UntieModel): ModelEditor & { model: UntieModel; applies: number } {
  const e = {
    model: initial,
    applies: 0,
    getModel: () => e.model,
    apply: <T,>(cmd: (m: UntieModel) => CommandResult<T>) => {
      e.applies++;
      const r = cmd(e.model);
      if (r.ok) e.model = r.model;
      return r;
    },
  };
  return e;
}
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;
const el = (m: UntieModel, id: string) => m.elements.find((e) => e.id === id)!;
const section = (text: string) => JSON.parse(text.slice(text.indexOf("<ヒアリング>") + 7, text.indexOf("</ヒアリング>"))) as Record<string, any>;

/** サンプルに入っているペルソナを外す (ペルソナが無い状態から試すため) */
function withoutPersona(m: ReturnType<typeof sample>): ReturnType<typeof sample> {
  return { ...m, elements: m.elements.map((e) => { const { persona: _p, ...rest } = e as typeof e & { persona?: unknown }; return rest as typeof e; }) };
}

describe("ヒアリングの最初の発言", () => {
  it("アクターのペルソナ・主担当の業務・担当する作業と使う操作・既にある課題が入る", () => {
    const m = okModel(setPersona(sample(), { id: "actor_front", persona: { handle: "田中さん", itSkill: "uncomfortable", goals: "待たせない" } }));
    const text = hearingOpening(m, el(m, "actor_front"), "persona");
    const data = section(text);
    expect(data.actor).toMatchObject({ id: "actor_front", name: "フロント担当" });
    expect(data.persona).toEqual({ 呼び名: "田中さん", 目標: "待たせない", "IT の習熟": "苦手" });
    expect(data.activities.map((a: { id: string }) => a.id)).toContain("act_hand_key");
    const hand = data.activities.find((a: { id: string }) => a.id === "act_hand_key");
    expect(hand.business).toBeDefined();
    expect(Array.isArray(hand.usecases)).toBe(true);
    expect(data.mainBusinesses).toBeDefined();
    // 既にある課題: このアクターが担当する作業・操作などを対象にしたもの
    const ids = data.existingIssues.map((i: { id: string }) => i.id);
    const related = (m.elements.filter((e) => e.kind === "issue") as Issue[]).filter((i) => i.targetIds.some((t) => t === "actor_front" || data.activities.some((a: { id: string; usecases: { id: string }[] }) => a.id === t || a.usecases.some((u) => u.id === t))));
    expect(ids.sort()).toEqual(related.map((i) => i.id).sort());
    expect(related.length).toBeGreaterThan(0);
    expect(text).toContain("get_model");
  });

  it("ペルソナが無ければ persona は null で、答え方に合わせて最初の依頼が変わる", () => {
    const m = withoutPersona(sample());
    const persona = hearingOpening(m, el(m, "actor_front"), "persona");
    const self = hearingOpening(m, el(m, "actor_front"), "self");
    expect(section(persona).persona).toBeNull();
    expect(persona).toContain("ペルソナになりきって");
    expect(self).toContain("本人に、最初のラウンドの質問");
    expect(section(self).actor.kindLabel).toBe("アクター");
  });

  it("外部アクターでも作れる", () => {
    const m = sample();
    const data = section(hearingOpening(m, el(m, "ext_guest"), "persona"));
    expect(data.actor).toMatchObject({ id: "ext_guest", kindLabel: "外部アクター" });
  });
});

describe("ヒアリングの指示", () => {
  it("persona: なりきり・自己紹介・仮説・保存の提案・仮説の注記を指示する", () => {
    const p = hearingSystemPrompt("persona");
    expect(p).toContain("なりきって");
    expect(p).toContain("気になるところを聞いてください");
    expect(p).toContain("このペルソナで保存しますか?");
    expect(p).toContain("ヒアリングからの仮説");
    expect(p).toContain(HEARING_SUMMARY_REQUEST);
    expect(p).toContain("この内容で課題を登録しますか?");
    expect(p).toContain("課題「○○」に追記");
    expect(p).toContain("(役を離れて)");
    expect(p).toContain("(ペルソナ「(呼び名)」の仮説)");
    expect(p).toContain("既存の文の後ろに改行で足す");
    expect(p).toContain("材料の「既にある課題」と、このヒアリングで登録した課題だけ");
    expect(p).toContain("混ぜない");
  });

  it("self: ラウンド (Q1…・➡️ 推奨) で聞き、ペルソナが無ければ最初の 1 問にまとめる", () => {
    const p = hearingSystemPrompt("self");
    expect(p).toContain("Q1");
    expect(p).toContain("➡️ 推奨");
    expect(p).toContain("ペルソナの要点");
    expect(p).toContain("複数の困りごと");
    expect(p).not.toContain("なりきって");
    expect(p).not.toContain("役を離れて");
    expect(p).not.toContain("仮説」と添える");
    expect(p).toContain("この内容で課題を登録しますか?");
  });
});

describe("ヒアリングの道具", () => {
  it("道具は get_model・set_persona・add_issue・update_issue_analysis・set_issue_targets で、すべて実行できる", () => {
    expect(HEARING_TOOLS.map((t) => t.name)).toEqual(["get_model", "set_persona", "add_issue", "update_issue_analysis", "set_issue_targets"]);
    const e = editorOf(sample());
    for (const t of HEARING_TOOLS) expect(String(parse(executeHearingTool(e, "actor_front", t.name, {}).content).error ?? "")).not.toMatch(/不明な道具/);
    expect(executeHearingTool(e, "actor_front", "add_element", { kind: "activity", name: "x" }).ok).toBe(false);
  });

  it("add_issue は課題・分析・重要度・対象を 1 回の編集で作る", () => {
    const e = editorOf(sample());
    const r = executeHearingTool(e, "actor_front", "add_issue", {
      name: "鍵の受け渡しで待たせる",
      description: "ペルソナ「田中さん」へのヒアリングからの仮説",
      phenomenon: "夕方に鍵の受け渡しが詰まる",
      location: "鍵を渡す",
      cause: "鍵の在庫が手書き",
      impact: "宿泊客を待たせる",
      severity: 4,
      target_ids: ["act_hand_key"],
    });
    expect(r.ok && r.changed).toBe(true);
    expect(e.applies).toBe(1);
    const id = parse(r.content).id as string;
    expect(el(e.model, id)).toMatchObject({
      kind: "issue",
      name: "鍵の受け渡しで待たせる",
      description: "ペルソナ「田中さん」へのヒアリングからの仮説",
      severity: 4,
      targetIds: ["act_hand_key"],
      analysis: { phenomenon: "夕方に鍵の受け渡しが詰まる", location: "鍵を渡す", cause: "鍵の在庫が手書き", impact: "宿泊客を待たせる" },
    });
    expect(validateModel(JSON.parse(JSON.stringify(e.model))).ok).toBe(true);
  });

  it("add_issue は名前だけでも作れる (未整理)。名前が無い・対象が混ざる・重要度が範囲外なら何も作らない", () => {
    const e = editorOf(sample());
    const before = e.model.elements.length;
    const bare = executeHearingTool(e, "actor_front", "add_issue", { name: "ただの困りごと" });
    expect(bare.ok).toBe(true);
    expect(e.model.elements).toHaveLength(before + 1);
    const base = e.model;
    expect(executeHearingTool(e, "actor_front", "add_issue", {}).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "add_issue", { name: "x", target_ids: ["act_hand_key", "actor_front"] }).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "add_issue", { name: "x", severity: 9, phenomenon: "y" }).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "add_issue", { name: "x", target_ids: ["nope"] }).ok).toBe(false);
    expect(e.model).toBe(base);
  });

  it("全体的な課題: このアクター自身を対象にできる", () => {
    const e = editorOf(sample());
    const r = executeHearingTool(e, "actor_front", "add_issue", { name: "人手が足りない", target_ids: ["actor_front"] });
    expect(r.ok).toBe(true);
    expect(el(e.model, parse(r.content).id as string)).toMatchObject({ targetIds: ["actor_front"] });
  });

  it("update_issue_analysis は材料の「既にある課題」に分析を追記する (既存の文を残して改行で足す)。原文は変えない", () => {
    const e = editorOf(sample());
    const original = el(e.model, "issue_checkin_queue") as Issue;
    expect(executeHearingTool(e, "actor_front", "update_issue_analysis", { cause: "x" }).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "update_issue_analysis", { issue_id: "actor_front", cause: "x" }).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "update_issue_analysis", { issue_id: "issue_checkin_queue" }).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "update_issue_analysis", { issue_id: "issue_checkin_queue", cause: "本人確認が手書き", severity: 5 }).ok).toBe(true);
    expect(executeHearingTool(e, "actor_front", "update_issue_analysis", { issue_id: "issue_checkin_queue", cause: "鍵の在庫も手書き", impact: "待たせる" }).ok).toBe(true);
    const after = el(e.model, "issue_checkin_queue") as Issue;
    expect(after.analysis).toEqual({ cause: "本人確認が手書き\n鍵の在庫も手書き", impact: "待たせる" });
    expect(after.severity).toBe(5);
    expect(after.name).toBe(original.name);
    expect(after.description).toBe(original.description);
  });

  it("persona モードの追記には「(ペルソナ「○○」の仮説)」が添えられ、self では添えない", () => {
    const ctx = { created: new Set<string>(), answerer: "persona" as const };
    const m = okModel(setPersona(sample(), { id: "actor_front", persona: { handle: "田中さん" } }));
    const e = editorOf(m);
    executeHearingTool(e, "actor_front", "update_issue_analysis", { issue_id: "issue_checkin_queue", cause: "手書き" }, ctx);
    executeHearingTool(e, "actor_front", "update_issue_analysis", { issue_id: "issue_checkin_queue", cause: "もう一つ(仮説)" }, ctx);
    expect((el(e.model, "issue_checkin_queue") as Issue).analysis?.cause).toBe("手書き (ペルソナ「田中さん」の仮説)\nもう一つ(仮説)");
    const e2 = editorOf(sample());
    executeHearingTool(e2, "actor_front", "update_issue_analysis", { issue_id: "issue_checkin_queue", cause: "手書き" });
    expect((el(e2.model, "issue_checkin_queue") as Issue).analysis?.cause).toBe("手書き");
  });

  it("書ける課題は、材料の「既にある課題」とこのセッションで add_issue した課題だけ。範囲外は断る", () => {
    const e = editorOf(sample());
    const before = e.model;
    // issue_manual_entry は予約担当の作業が対象で、フロント担当のヒアリングの範囲外
    expect(executeHearingTool(e, "actor_front", "update_issue_analysis", { issue_id: "issue_manual_entry", cause: "x" }).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "set_issue_targets", { issue_id: "issue_manual_entry", target_ids: [] }).ok).toBe(false);
    expect(e.model).toBe(before);
    // 範囲外でも、別のセッション (ctx) で作った課題は書けない。このセッションで作った課題は、対象が空でも書ける
    const ctx = { created: new Set<string>(), answerer: "self" as const };
    const made = executeHearingTool(e, "actor_front", "add_issue", { name: "新しい困りごと" }, ctx);
    const id = parse(made.content).id as string;
    expect(ctx.created.has(id)).toBe(true);
    expect(executeHearingTool(e, "actor_front", "update_issue_analysis", { issue_id: id, cause: "追記" }, ctx).ok).toBe(true);
    expect(executeHearingTool(e, "actor_front", "update_issue_analysis", { issue_id: id, cause: "追記" }).ok).toBe(false);
  });

  it("set_issue_targets は範囲内の課題の対象を置き換え、登場人物はこのアクターだけ。混在は断る", () => {
    const e = editorOf(sample());
    expect(executeHearingTool(e, "actor_front", "set_issue_targets", { issue_id: "issue_checkin_queue", target_ids: ["act_hand_key"] }).ok).toBe(true);
    expect((el(e.model, "issue_checkin_queue") as Issue).targetIds).toEqual(["act_hand_key"]);
    // 範囲から外れないよう、いまは対象が act_hand_key (担当する作業) なので、まだ範囲内
    expect(executeHearingTool(e, "actor_front", "set_issue_targets", { issue_id: "issue_checkin_queue", target_ids: ["actor_reservation"] }).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "set_issue_targets", { issue_id: "issue_checkin_queue", target_ids: ["act_hand_key", "actor_front"] }).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "set_issue_targets", { issue_id: "issue_checkin_queue", target_ids: ["actor_front"] }).ok).toBe(true);
    expect(executeHearingTool(e, "actor_front", "set_issue_targets", { target_ids: [] }).ok).toBe(false);
  });

  it("add_issue の対象に別のアクターやシステムなどの登場人物は入れられない", () => {
    const e = editorOf(sample());
    const before = e.model;
    expect(executeHearingTool(e, "actor_front", "add_issue", { name: "x", target_ids: ["actor_reservation"] }).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "add_issue", { name: "x", target_ids: ["ext_guest"] }).ok).toBe(false);
    expect(e.model).toBe(before);
  });

  it("set_persona はこのアクターだけに効き、指定した項目だけ変わる。ほかの要素は断る", () => {
    const e = editorOf(withoutPersona(sample()));
    const r = executeHearingTool(e, "actor_front", "set_persona", { handle: "田中さん (店長・45歳)", it_skill: "uncomfortable", goals: "待たせない" });
    expect(r.ok && r.changed).toBe(true);
    expect(el(e.model, "actor_front")).toMatchObject({ persona: { handle: "田中さん (店長・45歳)", itSkill: "uncomfortable", goals: "待たせない" } });
    executeHearingTool(e, "actor_front", "set_persona", { goals: "", notes: "午前のみ" });
    expect((el(e.model, "actor_front") as { persona: unknown }).persona).toEqual({ handle: "田中さん (店長・45歳)", itSkill: "uncomfortable", notes: "午前のみ" });
    const before = e.model;
    expect(executeHearingTool(e, "actor_front", "set_persona", { id: "actor_reservation", handle: "別人" }).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "set_persona", { it_skill: "bogus" }).ok).toBe(false);
    expect(executeHearingTool(e, "actor_front", "set_persona", {}).ok).toBe(false);
    expect(executeHearingTool(e, "act_hand_key", "set_persona", { handle: "x" }).ok).toBe(false);
    expect(e.model).toBe(before);
  });
});

describe("通常の編集モードのペルソナ", () => {
  it("set_persona は任意のアクター・外部アクターに効き、get_model の出力にペルソナが入る", () => {
    const e = editorOf(withoutPersona(sample()));
    expect(MODEL_TOOLS.map((t) => t.name)).toContain("set_persona");
    expect(executeTool(e, "set_persona", { id: "ext_guest", handle: "出張の多いお客様", it_skill: "comfortable" }).ok).toBe(true);
    expect(executeTool(e, "set_persona", { id: "actor_reservation", background: "予約を任される" }).ok).toBe(true);
    expect(executeTool(e, "set_persona", { id: "act_hand_key", handle: "x" }).ok).toBe(false);
    expect(executeTool(e, "set_persona", { handle: "x" }).ok).toBe(false);
    const model = parse(executeTool(e, "get_model", {}).content) as { elements: { id: string; persona?: unknown }[] };
    expect(model.elements.find((x) => x.id === "ext_guest")!.persona).toEqual({ handle: "出張の多いお客様", itSkill: "comfortable" });
    expect(model.elements.find((x) => x.id === "actor_reservation")!.persona).toEqual({ background: "予約を任される" });
  });
});
