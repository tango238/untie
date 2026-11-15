// buildModelFromSpec の「土台あり」: すでにあるモデルに足す。同じ種類・同じ名前の要素は作り直さずに使い、無いものだけ足す。
// 土台が無いときの振る舞い (空のモデルから作る) は spec.test.ts・generate.test.ts が確かめる (変わらない)。
import { describe, expect, it } from "vitest";
import { traceToActors } from "@untie/core/model/trace";
import { validateModel } from "@untie/core/model/validate";
import type { UntieModel } from "@untie/core/model/types";
import { buildModelFromSpec, type ModelSpec } from "../spec";

const spec: ModelSpec = {
  system_name: "小さな旅館",
  overview: "予約から精算まで",
  actors: [{ name: "フロント係", persona: { handle: "田中さん" } }],
  external_actors: [{ name: "宿泊客" }],
  systems: [{ name: "予約サイト" }],
  informations: [{ name: "予約", description: "宿泊の予約 1 件" }],
  state_groups: [{ name: "予約の状態", states: [{ name: "仮予約" }, { name: "確定" }] }],
  businesses: [
    {
      name: "予約受付",
      main_actors: ["フロント係"],
      bucs: [
        {
          name: "予約を受ける",
          activities: [
            {
              name: "予約を受け付ける",
              performers: ["フロント係", "宿泊客"],
              trigger_note: "電話",
              usecases: [{ name: "予約を登録する", writes: ["予約"], to_states: ["仮予約"] }, { name: "予約を確かめる", reads: ["予約"], from_states: ["仮予約"], to_states: ["確定"] }],
            },
          ],
        },
      ],
    },
  ],
  screens: [
    { name: "予約登録", description: "予約を入力する", system: "予約サイト", usecase: "予約を登録する" },
    { name: "予約確認", system: "予約サイト", usecase: "予約を確かめる" },
  ],
  events: [{ name: "夜になった", raised_by: ["予約サイト"], usecases: [{ name: "締める", reads: ["予約"], targets: ["予約サイト"] }] }],
  issues: [{ name: "電話が多い", targets: ["予約を受け付ける"] }],
};

const count = (m: UntieModel, kind: string) => m.elements.filter((e) => e.kind === kind).length;
const shape = (m: UntieModel) => ({ elements: m.elements.length, relations: m.relations.length });

describe("buildModelFromSpec: 土台あり", () => {
  it("同じ下書きをもう一度足しても、何も増えない (要素も関係も同じ)", () => {
    const first = buildModelFromSpec(spec);
    const second = buildModelFromSpec(spec, { base: first.model });
    expect(shape(second.model)).toEqual(shape(first.model));
    expect(second.added).toEqual({});
    expect(second.warnings).toEqual(first.warnings);
    expect(validateModel(JSON.parse(JSON.stringify(second.model))).ok).toBe(true);
  });

  it("土台の要素 (同じ種類・同じ名前) は作り直さずに使い、名前・説明・ペルソナ・モデルの名前は書き換えない", () => {
    const first = buildModelFromSpec({ ...spec, system_name: "最初の名前", overview: "最初の概要" });
    const changed = {
      ...spec,
      system_name: "別の名前",
      overview: "別の概要",
      actors: [{ name: "フロント係", description: "書き換わらない", persona: { handle: "別の人" } }],
      informations: [{ name: "予約", description: "書き換わらない" }],
    };
    const m = buildModelFromSpec(changed, { base: first.model }).model;
    expect(m.meta.name).toBe("最初の名前");
    expect(m.meta.description).toBe("最初の概要");
    const actor = m.elements.find((e) => e.kind === "actor")!;
    expect(actor.description).toBeUndefined();
    expect((actor as { persona?: { handle?: string } }).persona?.handle).toBe("田中さん");
    expect(m.elements.find((e) => e.kind === "information")!.description).toBe("宿泊の予約 1 件");
    expect(first.model.elements.map((e) => e.id).sort()).toEqual(m.elements.map((e) => e.id).sort());
  });

  it("名前が土台にあるものだけ再利用し、無いものだけ足す。added は新しく足した数", () => {
    const first = buildModelFromSpec(spec);
    const more: ModelSpec = {
      system_name: "x",
      actors: [{ name: "フロント係" }, { name: "清掃係" }],
      external_actors: [{ name: "宿泊客" }],
      systems: [{ name: "予約サイト" }],
      informations: [{ name: "予約" }, { name: "請求" }],
      businesses: [
        {
          name: "精算",
          main_actors: ["フロント係"],
          activities: [{ name: "請求する", performers: ["フロント係", "宿泊客"], usecases: [{ name: "請求を出す", writes: ["請求"], reads: ["予約"] }] }],
        },
      ],
    };
    const res = buildModelFromSpec(more, { base: first.model });
    expect(res.added).toEqual({ actor: 1, information: 1, business: 1, activity: 1, usecase: 1 });
    expect(count(res.model, "actor")).toBe(2);
    expect(count(res.model, "externalActor")).toBe(1);
    expect(count(res.model, "system")).toBe(1);
    expect(res.counts.business).toBe(2);
    expect(traceToActors(res.model).problems.filter((p) => p.isBreak)).toEqual([]);
  });

  it("画面は、同じシステムの同じ名前だけを同じものとする。別のシステムの同じ名前は別の画面", () => {
    const a = buildModelFromSpec({
      system_name: "x",
      actors: [{ name: "係" }],
      systems: [{ name: "サイト A" }, { name: "サイト B" }],
      businesses: [{ name: "業務", main_actors: ["係"], activities: [{ name: "作業", performers: ["係"], usecases: [{ name: "操作 A" }, { name: "操作 B" }] }] }],
      screens: [{ name: "一覧", system: "サイト A", usecase: "操作 A" }],
    });
    const b = buildModelFromSpec(
      {
        system_name: "x",
        businesses: [],
        systems: [{ name: "サイト A" }, { name: "サイト B" }],
        screens: [
          { name: "一覧", system: "サイト A", usecase: "操作 A" },
          { name: "一覧", system: "サイト B", usecase: "操作 B" },
        ],
      },
      { base: a.model },
    );
    expect(b.added).toEqual({ screen: 1 });
    expect(count(b.model, "screen")).toBe(2);
    expect(b.warnings).toEqual([]);
    expect(validateModel(JSON.parse(JSON.stringify(b.model))).ok).toBe(true);
  });

  it("土台の画面を使う操作は結び直さない。別の操作を結ぼうとしたら警告して、結ばない (1 画面 = 1 操作)", () => {
    const first = buildModelFromSpec(spec);
    const res = buildModelFromSpec(
      { system_name: "x", businesses: [{ name: "予約受付", activities: [] }], screens: [{ name: "予約登録", system: "予約サイト", usecase: "予約を確かめる" }] },
      { base: first.model },
    );
    expect(res.warnings.some((w) => /予約登録/.test(w) && /すでに別の操作/.test(w))).toBe(true);
    const screen = res.model.elements.find((e) => e.kind === "screen" && e.name === "予約登録")!;
    expect(res.model.relations.filter((r) => r.kind === "usecaseScreen" && r.targetId === screen.id)).toHaveLength(1);
  });

  it("土台にある課題と同じ名前の課題は足さない。主担当がすでにいる業務に、別の主担当を足さない", () => {
    const first = buildModelFromSpec(spec);
    const res = buildModelFromSpec(
      { system_name: "x", actors: [{ name: "支配人" }], businesses: [{ name: "予約受付", main_actors: ["支配人"] }], issues: [{ name: "電話が多い" }, { name: "新しい課題" }] },
      { base: first.model },
    );
    expect(count(res.model, "issue")).toBe(2);
    const biz = res.model.elements.find((e) => e.kind === "business")!;
    expect(res.model.relations.filter((r) => r.kind === "actorBusiness" && r.targetId === biz.id)).toHaveLength(1);
  });

  it("土台が空のモデルでも、土台なしと同じ要素ができる (名前だけ土台のもの)", () => {
    const empty = buildModelFromSpec({ system_name: "土台", businesses: [] }).model;
    const withBase = buildModelFromSpec(spec, { base: empty });
    const without = buildModelFromSpec(spec);
    expect(withBase.counts).toEqual(without.counts);
    expect(withBase.model.meta.name).toBe("土台");
    expect(withBase.warnings).toEqual(without.warnings);
  });
});
