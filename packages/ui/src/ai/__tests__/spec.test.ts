import { describe, expect, it } from "vitest";
import { traceToActors } from "@untie/core/model/trace";
import { validateModel } from "@untie/core/model/validate";
import { buildModelFromSpec, SPEC_LIMITS, type ModelSpec } from "../spec";

const spec: ModelSpec = {
  system_name: "小さな旅館",
  overview: "予約から精算まで",
  actors: [{ name: "フロント係" }],
  external_actors: [{ name: "宿泊客" }],
  systems: [{ name: "予約サイト" }],
  ledgers: [{ name: "予約台帳" }],
  contexts: [{ name: "予約" }],
  variations: [{ name: "予約経路", values: ["電話", "予約サイト"], context: "予約" }],
  state_groups: [{ name: "予約の状態", context: "予約", states: [{ name: "仮予約" }, { name: "確定" }] }],
  informations: [{ name: "予約", context: "予約", variations: ["予約経路"] }],
  conditions: [{ name: "満室である", context: "予約", states: ["確定"] }],
  businesses: [
    {
      name: "予約受付",
      main_actors: ["フロント係"],
      activities: [
        {
          name: "予約を受け付ける",
          performers: ["フロント係", "宿泊客"],
          usecases: [{ name: "予約を登録する", writes: ["予約"], conditions: ["満室である"], to_states: ["仮予約"], targets: ["予約サイト"] }],
        },
      ],
      bucs: [
        {
          name: "予約確定",
          activities: [{ name: "予約を確定する", performers: ["フロント係"], usecases: [{ name: "予約を確定する", informations: ["予約"], from_states: ["仮予約"], to_states: ["確定"], targets: ["予約台帳"] }] }],
        },
      ],
    },
  ],
  issues: [{ name: "台帳への転記が手作業", severity: 4, targets: ["予約を受け付ける"] }],
};

describe("buildModelFromSpec", () => {
  it("名前で参照した下書きを、検査を通るモデルに組み立てる", () => {
    const r = buildModelFromSpec(spec);
    expect(r.warnings).toEqual([]);
    expect(validateModel(JSON.parse(JSON.stringify(r.model))).ok).toBe(true);
    expect(traceToActors(r.model).problems).toEqual([]);
    expect(r.model.meta).toMatchObject({ name: "小さな旅館", description: "予約から精算まで" });
    expect(r.counts).toMatchObject({ business: 1, buc: 1, activity: 2, usecase: 2, actor: 1, externalActor: 1, system: 1, ledger: 1, information: 1, state: 2, issue: 1 });
    const kinds = new Set(r.model.relations.map((x) => x.kind));
    for (const k of ["actorBusiness", "actorActivity", "activityUsecase", "usecaseInformation", "usecaseCondition", "stateUsecase", "usecaseState", "informationVariation", "conditionState"]) {
      expect(kinds.has(k as never)).toBe(true);
    }
    // 取得・保存の区別は usecase → information の access に付く
    const accesses = r.model.relations.filter((x) => x.kind === "usecaseInformation").map((x) => x.access);
    expect(accesses.sort()).toEqual(["write", undefined]);
    const issue = r.model.elements.find((e) => e.kind === "issue");
    expect(issue && issue.kind === "issue" && issue.targetIds).toHaveLength(1);
  });

  it("アクター・外部アクターの persona を受け付けて反映する。長い文字列は切り詰め、不正な習熟は警告して置かない", () => {
    const r = buildModelFromSpec({
      ...spec,
      actors: [{ name: "フロント係", persona: { handle: "田中さん", attributes: "あ".repeat(300), it_skill: "uncomfortable", goals: "待たせない" } }],
      external_actors: [{ name: "宿泊客", persona: { it_skill: "bogus", handle: "出張客" } }, { name: "旅行会社", persona: { background: "団体が多い" } }, { name: "取引先", persona: {} }],
    });
    const find = (n: string) => r.model.elements.find((e) => e.name === n) as { persona?: Record<string, string> };
    expect(find("フロント係").persona).toEqual({ handle: "田中さん", attributes: "あ".repeat(200), itSkill: "uncomfortable", goals: "待たせない" });
    // 不正な習熟はその項目だけ外し、ほかの項目は残す。項目の無い persona は黙って飛ばす
    expect(find("宿泊客").persona).toEqual({ handle: "出張客" });
    expect(find("取引先").persona).toBeUndefined();
    expect(r.warnings.filter((w) => w.includes("取引先"))).toEqual([]);
    expect(find("旅行会社").persona).toEqual({ background: "団体が多い" });
    expect(r.warnings.filter((w) => w.includes("宿泊客 のペルソナ"))).toHaveLength(1);
    expect(validateModel(JSON.parse(JSON.stringify(r.model))).ok).toBe(true);
  });

  it("見つからない名前は飛ばして warnings に残す", () => {
    const r = buildModelFromSpec({
      system_name: "x",
      businesses: [{ name: "業務", main_actors: ["いない人"], activities: [{ name: "作業", performers: ["いない人"], usecases: [{ name: "操作", informations: ["無い情報"] }] }] }],
    });
    expect(r.warnings).toEqual(expect.arrayContaining(["主担当「いない人」が見つかりません", "担当「いない人」が見つかりません", "情報「無い情報」が見つかりません"]));
    expect(validateModel(JSON.parse(JSON.stringify(r.model))).ok).toBe(true);
  });
});

describe("buildModelFromSpec: AI の出力が長くても要素が消えない", () => {
  it("名前・説明・グループ・値・課題・概要は上限に切り詰めて、スキーマに合うモデルにする", () => {
    const long = "あ".repeat(5000);
    const longSpec: ModelSpec = {
      system_name: long,
      overview: long,
      actors: [{ name: long, description: long }],
      variations: [{ name: "区分", values: [long] }],
      state_groups: [{ name: long, states: [{ name: "状態" }] }],
      businesses: [{ name: "業務", activities: [{ name: "作業", performers: [long] }] }],
      issues: [{ name: long, description: long, targets: [long] }],
    };
    const { model, warnings } = buildModelFromSpec(longSpec);
    expect(warnings.filter((w) => /作れません/.test(w))).toEqual([]);
    expect(model.meta.name).toHaveLength(200);
    expect(model.meta.description).toHaveLength(4000);
    expect(model.elements.find((e) => e.kind === "actor")!.name).toHaveLength(200);
    expect(model.elements.filter((e) => e.kind === "issue")).toHaveLength(1);
    // 担当は切り詰めた名前でも引ける (関係が結ばれる)
    expect(model.relations.some((r) => r.kind === "actorActivity")).toBe(true);
    expect(validateModel(JSON.parse(JSON.stringify(model))).ok).toBe(true);
  });
});

describe("buildModelFromSpec: 作業の起点", () => {
  const act = (name: string, extra: Record<string, unknown> = {}) => ({ name, performers: ["担当"], ...extra });
  const base = (activities: Record<string, unknown>[], more: Record<string, unknown>[] = []): ModelSpec => ({
    system_name: "x",
    actors: [{ name: "担当" }],
    businesses: [
      { name: "業務A", main_actors: ["担当"], activities: activities as never },
      ...(more.length ? [{ name: "業務B", main_actors: ["担当"], activities: more as never }] : []),
    ],
  });
  const triggers = (r: ReturnType<typeof buildModelFromSpec>) =>
    r.model.relations.filter((x) => x.kind === "activityTrigger").map((x) => [r.model.elements.find((e) => e.id === x.sourceId)!.name, r.model.elements.find((e) => e.id === x.targetId)!.name]);

  it("起点の作業 (後ろの作業を指してもよい) と、その他を書く", () => {
    const r = buildModelFromSpec(base([act("先", { trigger_activities: ["後"], trigger_note: " 電話 " }), act("後")]));
    expect(r.warnings).toEqual([]);
    expect(triggers(r)).toEqual([["後", "先"]]);
    expect(r.model.elements.find((e) => e.kind === "activity" && e.name === "先")).toMatchObject({ triggerNote: "電話" });
    expect(validateModel(JSON.parse(JSON.stringify(r.model))).ok).toBe(true);
  });

  it("見つからない起点・自分自身は結ばず、warnings に残す。同名の作業が複数あれば知らせて最初の 1 つを結ぶ", () => {
    const r = buildModelFromSpec(base([act("先", { trigger_activities: ["いない作業", "先"] })]));
    expect(r.warnings).toEqual(expect.arrayContaining(["起点の作業「いない作業」が見つかりません", "作業「先」は自分自身を起点にできないので、起点「先」は結びませんでした"]));
    expect(triggers(r)).toEqual([]);
    const dup = buildModelFromSpec(base([act("先", { trigger_activities: ["同名"] }), act("同名")], [act("同名")]));
    expect(dup.warnings).toEqual(["起点の作業「同名」と同じ名前の作業が 2 つあるので、最初の 1 つを結びました"]);
    expect(triggers(dup)).toEqual([["同名", "先"]]);
  });
});

describe("buildModelFromSpec: 巨大な下書き", () => {
  const L = SPEC_LIMITS;
  it("上限いっぱいの入力が数秒以内に終わり、超えた分は「先頭 N 件だけ使いました」と警告する", () => {
    const n = 1500;
    const big: ModelSpec = {
      system_name: "大きな下書き",
      actors: [{ name: "担当" }],
      systems: [{ name: "基幹" }],
      informations: Array.from({ length: n }, (_, i) => ({ name: `情報${i}` })),
      businesses: [
        {
          name: "業務",
          main_actors: ["担当"],
          activities: Array.from({ length: n }, (_, i) => ({
            name: `作業${i}`,
            performers: ["担当"],
            usecases: [{ name: `操作${i}`, reads: [`情報${i}`], targets: ["基幹"] }],
          })),
        },
      ],
      screens: Array.from({ length: n }, (_, i) => ({ name: `画面${i}`, system: "基幹", usecase: `操作${i}` })),
    };
    const start = performance.now();
    const r = buildModelFromSpec(big);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(6000);
    expect(r.counts.activity).toBe(L.activities);
    expect(r.counts.usecase).toBe(L.usecases);
    expect(r.counts.screen).toBe(L.screens);
    expect(r.counts.information).toBe(L.informations);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        `情報は先頭 ${L.informations} 件だけ使いました (${n} 件ありました)`,
        `画面は先頭 ${L.screens} 件だけ使いました (${n} 件ありました)`,
        `作業は先頭 ${L.activities} 件だけ使いました (${n - L.activities} 件を飛ばしました)`,
      ]),
    );
    expect(validateModel(JSON.parse(JSON.stringify(r.model))).ok).toBe(true);
  });

  it("1 つの要素が参照する名前の数にも上限がある", () => {
    const r = buildModelFromSpec({
      system_name: "x",
      actors: [{ name: "担当" }],
      businesses: [{ name: "業務", main_actors: ["担当"], activities: [{ name: "作業", performers: Array.from({ length: L.refsPerItem + 5 }, () => "担当") }] }],
    });
    expect(r.warnings).toContain(`作業「作業」の担当は先頭 ${L.refsPerItem} 件だけ使いました (${L.refsPerItem + 5} 件ありました)`);
  });
});
