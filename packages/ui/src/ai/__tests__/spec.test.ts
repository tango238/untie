import { describe, expect, it } from "vitest";
import { traceToActors } from "@untie/core/model/trace";
import { validateModel } from "@untie/core/model/validate";
import { buildModelFromSpec, type ModelSpec } from "../spec";

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
