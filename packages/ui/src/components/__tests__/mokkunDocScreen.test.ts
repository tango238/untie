import { describe, expect, it } from "vitest";
import { addDesignScreens, addTransition, setDesignScreenView } from "@untie/core/model/commands";
import { emptyModel, type Element, type Relation, type UntieModel } from "@untie/core/model/types";
import { retailSample } from "@untie/core/sample";
import { okModel } from "@untie/core/testing";
import { buildMokkunSchema } from "../design/mokkunDoc";

const ELEMENTS: Element[] = [
  { id: "sys_a", kind: "system", name: "予約システム" },
  { id: "actor_1", kind: "actor", name: "受付" },
  { id: "actor_2", kind: "actor", name: "店長" },
  { id: "ext_1", kind: "externalActor", name: "客" },
  { id: "biz_1", kind: "business", name: "予約" },
  { id: "buc_1", kind: "buc", name: "予約", businessId: "biz_1", isDefault: true },
  { id: "act_1", kind: "activity", name: "受ける", bucId: "buc_1" },
  { id: "act_2", kind: "activity", name: "確かめる", bucId: "buc_1" },
  { id: "uc_1", kind: "usecase", name: "検索する" },
  { id: "uc_2", kind: "usecase", name: "登録する" },
  { id: "scr_1", kind: "screen", name: "予約検索", systemId: "sys_a" },
  { id: "scr_2", kind: "screen", name: "予約登録", systemId: "sys_a" },
  { id: "scr_3", kind: "screen", name: "予約確認", systemId: "sys_a" },
] as Element[];
const PAIRS: [string, string, Relation["kind"]][] = [
  // 検索: 受付と客 (客は外部アクター) → 届くのは受付 1 人
  ["actor_1", "act_1", "actorActivity"],
  ["ext_1", "act_1", "actorActivity"],
  ["act_1", "uc_1", "activityUsecase"],
  ["uc_1", "scr_1", "usecaseScreen"],
  // 登録: 受付と店長 → 2 人
  ["actor_1", "act_2", "actorActivity"],
  ["actor_2", "act_2", "actorActivity"],
  ["act_2", "uc_2", "activityUsecase"],
  ["uc_2", "scr_2", "usecaseScreen"],
];

function setup(views: Record<string, unknown> = {}): UntieModel {
  const m0 = emptyModel();
  m0.elements = ELEMENTS.map((e) => ({ ...e }));
  m0.relations = PAIRS.map(([sourceId, targetId, kind]) => ({ id: `rel_${sourceId}_${targetId}`, kind, sourceId, targetId }));
  let m = okModel(
    addDesignScreens(m0, {
      systemId: "sys_a",
      screens: [
        { id: "d1", source: { kind: "screen", screenId: "scr_1" } },
        { id: "d2", source: { kind: "screen", screenId: "scr_2" } },
        { id: "d3", source: { kind: "screen", screenId: "scr_3" } },
        { id: "d_top", source: { kind: "builtin", builtin: "top" } },
      ],
      transitions: [],
    }),
  );
  for (const [id, view] of Object.entries(views)) m = okModel(setDesignScreenView(m, { systemId: "sys_a", id, view: view as Record<string, unknown> }));
  return m;
}
const build = (m: UntieModel) => buildMokkunSchema(m, "sys_a", m.designs[0]!);

const FORM = { title: "x", goal: "g", primaryAction: { id: "send", label: "送信", kind: "submit" }, sections: [{ id: "f", title: "入力", kind: "form", fields: [{ item: "a", label: "A", component: "text" }] }] };
const LIST = { title: "x", goal: "g", sections: [{ id: "l", title: "一覧", kind: "list", list: { columns: [{ id: "c1", label: "C1" }, { id: "c2", label: "C2" }] } }] };

describe("buildMokkunSchema: 送信のあとの遷移 (afterSubmit)", () => {
  it("主の操作が submit で to が無ければ、to に遷移先を付ける (補助の操作には足さない)", () => {
    const m = okModel(addTransition(setup({ d2: FORM }), { systemId: "sys_a", from: "d2", to: "d3", via: "afterSubmit" }));
    const doc = build(m);
    expect(doc.error).toBeUndefined();
    const v = doc.schema.views.d2!;
    expect(v.primaryAction).toEqual({ id: "send", label: "送信", kind: "submit", to: "d3" });
    expect(v.secondaryActions).toBeUndefined();
  });

  it("主の操作が無い・submit でない・to がもうあるときは、これまでどおり補助の操作の navigate にする", () => {
    const withTransition = (view: unknown) => okModel(addTransition(setup({ d2: view }), { systemId: "sys_a", from: "d2", to: "d3", via: "afterSubmit", label: "確認へ" }));
    for (const view of [LIST, { ...FORM, primaryAction: { id: "send", label: "送信", kind: "custom" } }, { ...FORM, primaryAction: { id: "send", label: "送信", kind: "submit", to: "d1" } }]) {
      const v = build(withTransition(view)).schema.views.d2!;
      expect(v.secondaryActions).toEqual([expect.objectContaining({ kind: "navigate", to: "d3", label: "確認へ" })]);
      expect(v.primaryAction?.to).not.toBe("d3");
    }
  });

  it("画面 UI の無い画面 (仮の view) は補助の操作", () => {
    const m = okModel(addTransition(setup(), { systemId: "sys_a", from: "d2", to: "d3", via: "afterSubmit" }));
    expect(build(m).schema.views.d2!.secondaryActions).toEqual([expect.objectContaining({ kind: "navigate", to: "d3" })]);
  });
});

describe("buildMokkunSchema: 一覧の行の遷移 (row)", () => {
  it("一覧セクションの最初の列に to が無ければ付ける", () => {
    const m = okModel(addTransition(setup({ d1: LIST }), { systemId: "sys_a", from: "d1", to: "d2", via: "row" }));
    const v = build(m).schema.views.d1!;
    expect(v.sections[0]!.list!.columns.map((c) => c.to)).toEqual(["d2", undefined]);
    expect(v.secondaryActions).toBeUndefined();
  });

  it("一覧が無い・最初の列に to がある・ボタン (button) の遷移は補助の操作にする", () => {
    const noList = okModel(addTransition(setup({ d1: FORM }), { systemId: "sys_a", from: "d1", to: "d2", via: "row" }));
    expect(build(noList).schema.views.d1!.secondaryActions).toEqual([expect.objectContaining({ kind: "navigate", to: "d2" })]);
    const taken = { ...LIST, sections: [{ id: "l", title: "一覧", kind: "list", list: { columns: [{ id: "c1", label: "C1", to: "d3" }] } }] };
    const hasTo = okModel(addTransition(setup({ d1: taken }), { systemId: "sys_a", from: "d1", to: "d2", via: "row" }));
    expect(build(hasTo).schema.views.d1!.secondaryActions).toEqual([expect.objectContaining({ kind: "navigate", to: "d2" })]);
    const button = okModel(addTransition(setup({ d1: LIST }), { systemId: "sys_a", from: "d1", to: "d2", via: "button" }));
    const v = build(button).schema.views.d1!;
    expect(v.secondaryActions).toEqual([expect.objectContaining({ kind: "navigate", to: "d2" })]);
    expect(v.sections[0]!.list!.columns[0]!.to).toBeUndefined();
  });

  it("画面 UI が同じ遷移先の to を持っていれば、遷移を足さない", () => {
    const own = { ...LIST, sections: [{ id: "l", title: "一覧", kind: "list", list: { columns: [{ id: "c1", label: "C1" }, { id: "c2", label: "C2", to: "d2" }] } }] };
    const m = okModel(addTransition(setup({ d1: own }), { systemId: "sys_a", from: "d1", to: "d2", via: "button" }));
    const v = build(m).schema.views.d1!;
    expect(v.secondaryActions).toBeUndefined();
    expect(v.sections[0]!.list!.columns[0]!.to).toBeUndefined();
    const own2 = { ...FORM, secondaryActions: [{ id: "go", label: "登録へ", kind: "navigate", to: "d2" }] };
    const m2 = okModel(addTransition(setup({ d1: own2 }), { systemId: "sys_a", from: "d1", to: "d2", via: "button" }));
    expect(build(m2).schema.views.d1!.secondaryActions).toHaveLength(1);
  });

  it("設計に無い画面を指す to は外して、画面 UI を生かす", () => {
    const stale = { ...FORM, primaryAction: { id: "send", label: "送信", kind: "submit", to: "gone" }, secondaryActions: [{ id: "go", label: "どこか", kind: "navigate", to: "gone" }] };
    const doc = build(setup({ d1: stale }));
    expect(doc.viewErrors).toEqual({});
    expect(doc.error).toBeUndefined();
    const v = doc.schema.views.d1!;
    expect(v.primaryAction).toEqual({ id: "send", label: "送信", kind: "submit" });
    expect(v.secondaryActions).toEqual([]);
  });
});

describe("buildMokkunSchema: ロール", () => {
  it("ロールは付けない (app.roles も view.role も導かない)。view が自分で持つ role はそのまま", () => {
    const doc = build(setup({ d2: { ...FORM, role: "管理者" } }));
    expect(doc.schema.app.roles).toBeUndefined();
    expect(doc.schema.views.d1!.role).toBeUndefined();
    expect(doc.schema.views.d2!.role).toBe("管理者");
  });
});

describe("buildMokkunSchema: kind 省略の主の操作", () => {
  it("kind を省いた主の操作は submit として afterSubmit の to を受ける", () => {
    const { kind: _kind, ...primary } = FORM.primaryAction;
    const m = okModel(addTransition(setup({ d2: { ...FORM, primaryAction: primary } }), { systemId: "sys_a", from: "d2", to: "d3", via: "afterSubmit" }));
    const v = build(m).schema.views.d2!;
    expect(v.primaryAction).toMatchObject({ to: "d3" });
    expect(v.secondaryActions).toBeUndefined();
  });

  it("種類を list から form に切り替えた古い list は row の写しに使わない", () => {
    const stale = { title: "x", goal: "g", sections: [{ id: "f", title: "入力", kind: "form", fields: [{ item: "a", label: "A", component: "text" }], list: { columns: [{ id: "c", label: "C" }] } }] };
    const m = okModel(addTransition(setup({ d1: stale }), { systemId: "sys_a", from: "d1", to: "d2", via: "row" }));
    const doc = build(m);
    expect(doc.viewErrors).toEqual({});
    expect(doc.schema.views.d1!.secondaryActions).toEqual([expect.objectContaining({ kind: "navigate", to: "d2" })]);
  });
});

describe("店舗サンプルは mokkun の検証に通る", () => {
  it("POSレジの設計の文書を組み立てて、エラーも画面 UI の問題も無い。3 画面は画面 UI をそのまま使う", () => {
    const design = retailSample.designs.find((d) => d.systemId === "sys_pos")!;
    const doc = buildMokkunSchema(retailSample, "sys_pos", design);
    expect(doc.error).toBeUndefined();
    expect(doc.viewErrors).toEqual({});
    expect(doc.schema.views.ds_pos_search!.sections.map((s) => s.kind)).toEqual(["form", "list"]);
    expect(doc.schema.views.ds_pos_search!.sections[1]!.list!.columns[0]!.to).toBe("ds_pos_disposal");
    expect(doc.schema.views.ds_pos_sale!.primaryAction?.kind).toBe("submit");
    expect(doc.schema.views.ds_pos_top!.sections[0]!.kind).toBe("summary");
    expect(doc.schema.app.roles).toBeUndefined();
  });
});
