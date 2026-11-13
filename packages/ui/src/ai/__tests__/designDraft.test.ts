import { describe, expect, it } from "vitest";
import { checkDesign } from "@untie/core/model/designCheck";
import { designScreenName } from "@untie/core/model/sitemap";
import { traceToActors, traceWarnings } from "@untie/core/model/trace";
import type { UntieModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import { applyDatabaseDraft, applyScreenDraft, applySitemapDraft, readDatabaseDraft, readScreenDraft, readSitemapDraft, type ScreenDraft } from "../designDraft";
import { buildModelFromSpec } from "../spec";
import { FIXTURE_DATABASE, FIXTURE_SCREENS, FIXTURE_SITEMAP, FIXTURE_SPEC } from "./fixtures/reverseDraft";

const roundTrip = (m: UntieModel) => JSON.parse(JSON.stringify(m));

function analysis() {
  return buildModelFromSpec(FIXTURE_SPEC);
}
function withData(): UntieModel {
  const r = applyDatabaseDraft(analysis().model, FIXTURE_DATABASE);
  expect(r.applied).toBe(true);
  return r.model;
}
function withSitemap(): UntieModel {
  return applySitemapDraft(withData(), FIXTURE_SITEMAP).model;
}
function full(): UntieModel {
  let m = withSitemap();
  for (const s of FIXTURE_SCREENS) m = applyScreenDraft(m, s).model;
  return m;
}

describe("分析の下書き (画面・イベント)", () => {
  it("画面とイベントを組み立て、検査に通る (警告なし)", () => {
    const r = analysis();
    expect(r.warnings).toEqual([]);
    expect(validateModel(roundTrip(r.model)).ok).toBe(true);
    expect(traceToActors(r.model).problems.filter((p) => p.isBreak)).toEqual([]);
    expect(traceToActors(r.model).errors).toEqual([]);
    expect(traceWarnings(r.model)).toEqual([]);
    expect(r.counts).toMatchObject({ screen: 3, event: 3, usecase: 6, system: 1, ledger: 1 });
    const kinds = new Set(r.model.relations.map((x) => x.kind));
    for (const k of ["usecaseScreen", "usecaseEvent", "systemEvent", "eventUsecase", "eventActivity", "usecaseSystem"]) expect(kinds.has(k as never)).toBe(true);
  });

  it("1 つの操作の対象は 1 つ: 画面を使う操作の対象は画面になり、システムを書いていても二重にならない", () => {
    const spec = structuredClone(FIXTURE_SPEC);
    spec.businesses[0]!.activities![0]!.usecases![0]!.targets = ["注文管理システム"];
    const r = buildModelFromSpec(spec);
    expect(r.warnings).toEqual([]);
    const uc = r.model.elements.find((e) => e.name === "注文を登録する")!;
    const targets = r.model.relations.filter((x) => x.sourceId === uc.id && (x.kind === "usecaseSystem" || x.kind === "usecaseScreen"));
    expect(targets.map((x) => x.kind)).toEqual(["usecaseScreen"]);
    expect(traceToActors(r.model).problems.filter((p) => p.isBreak)).toEqual([]);
  });

  it("帳票を対象にした操作には画面を結ばず、警告にする。1 つの画面を使う操作は 1 つだけ", () => {
    const spec = structuredClone(FIXTURE_SPEC);
    spec.screens!.push({ name: "納品書画面", system: "注文管理システム", usecase: "納品書に記入する" }, { name: "別の登録画面", system: "注文管理システム", usecase: "注文を登録する" });
    const r = buildModelFromSpec(spec);
    expect(r.warnings.some((w) => w.includes("帳票を対象にしている"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("すでに別の画面を使っている"))).toBe(true);
    expect(validateModel(roundTrip(r.model)).ok).toBe(true);
    expect(traceToActors(r.model).errors).toEqual([]);
    // 注文登録の画面は 1 つだけ結ばれたまま
    const uc = r.model.elements.find((e) => e.name === "注文を登録する")!;
    expect(r.model.relations.filter((x) => x.kind === "usecaseScreen" && x.sourceId === uc.id)).toHaveLength(1);
  });

  it("画面を同じ操作が使い合うことはなく、同じ画面を 2 つの操作が使おうとしたら後のものを警告にする", () => {
    const spec = structuredClone(FIXTURE_SPEC);
    spec.screens!.push({ name: "注文登録", system: "注文管理システム", usecase: "注文を検索する" });
    const r = buildModelFromSpec(spec);
    expect(r.warnings.some((w) => w.includes("別の操作が使っている"))).toBe(true);
    expect(traceToActors(r.model).errors).toEqual([]);
  });

  it("見つからない名前は警告にして飛ばし、起こすものの無いイベントは辿れない箇所として検査に出る", () => {
    const spec = structuredClone(FIXTURE_SPEC);
    spec.screens!.push({ name: "迷子の画面", system: "存在しないシステム", usecase: "注文を登録する" }, { name: "操作なしの画面", system: "注文管理システム", usecase: "存在しない操作" });
    spec.events!.push({ name: "起こすものが無い", raised_by: ["存在しない"] });
    const r = buildModelFromSpec(spec);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("属するシステム「存在しないシステム」が見つかりません"),
        expect.stringContaining("操作「存在しない操作」が見つかりません"),
        expect.stringContaining("イベント「起こすものが無い」を起こすシステムか操作がありません"),
      ]),
    );
    expect(validateModel(roundTrip(r.model)).ok).toBe(true);
    const breaks = traceToActors(r.model).problems.filter((p) => p.isBreak);
    expect(breaks.map((p) => r.model.elements.find((e) => e.id === p.elementId)?.name)).toEqual(["起こすものが無い"]);
  });

  it("システムが 1 つだけなら画面の system を省ける", () => {
    const spec = structuredClone(FIXTURE_SPEC);
    delete spec.screens![0]!.system;
    const r = buildModelFromSpec(spec);
    expect(r.warnings).toEqual([]);
    expect(r.counts.screen).toBe(3);
  });
});

describe("データ", () => {
  it("DSL とテーブル → 情報を足し、設計が使うデータベースにする", () => {
    const r = applyDatabaseDraft(analysis().model, FIXTURE_DATABASE);
    expect(r.applied).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.added).toEqual({ tables: 3, informations: 2 });
    expect(r.model.databases).toHaveLength(1);
    expect(r.model.databases[0]).toMatchObject({ name: "注文DB" });
    expect(r.model.databases[0]!.tables.map((t) => t.table)).toEqual(["Order", "OrderItem", "Product"]);
    expect(r.model.designs[0]!.databaseIds).toEqual([r.databaseId]);
    expect(validateModel(roundTrip(r.model)).ok).toBe(true);
    expect(checkDesign(r.model, r.model.designs[0]!.systemId).problems).toEqual([]);
  });

  it("2 回足しても同じ名前のデータベースを置き換える", () => {
    const once = withData();
    const twice = applyDatabaseDraft(once, { ...FIXTURE_DATABASE, tables: [{ table: "Product", informations: ["商品"] }] });
    expect(twice.model.databases).toHaveLength(1);
    expect(twice.model.databases[0]!.tables.map((t) => t.table)).toEqual(["Product"]);
  });

  it("見つからない情報・DSL に無いテーブルはその部分だけ落として警告にする", () => {
    const r = applyDatabaseDraft(analysis().model, {
      ...FIXTURE_DATABASE,
      tables: [...FIXTURE_DATABASE.tables, { table: "Ghost", informations: ["注文"] }, { table: "Product", informations: ["商品", "存在しない情報"] }],
    });
    expect(r.applied).toBe(true);
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Ghost が DSL に無い"), expect.stringContaining("「存在しない情報」が見つかりません")]));
    expect(r.model.databases[0]!.tables.map((t) => t.table)).not.toContain("Ghost");
  });

  it("見つからないシステムは何も足さず failure を返す", () => {
    const m = analysis().model;
    const r = applyDatabaseDraft(m, { ...FIXTURE_DATABASE, system: "存在しない" });
    expect(r.applied).toBe(false);
    expect(r.failure).toContain("存在しない");
    expect(r.model).toBe(m);
  });

  it("DSL の解析エラーは既定では足さずエラーとして返し、受け付ける指定なら足して警告に残す", () => {
    const m = analysis().model;
    const broken = { ...FIXTURE_DATABASE, dsl: "model Order {\n  id String @id\n  broken\n}\n" };
    const rejected = applyDatabaseDraft(m, broken);
    expect(rejected.applied).toBe(false);
    expect(rejected.failure).toBeUndefined();
    expect(rejected.dslErrors.length).toBeGreaterThan(0);
    expect(rejected.model).toBe(m);
    const accepted = applyDatabaseDraft(m, broken, { acceptDslErrors: true });
    expect(accepted.applied).toBe(true);
    expect(accepted.dslErrors.length).toBeGreaterThan(0);
    expect(accepted.warnings.some((w) => w.includes("解析エラー"))).toBe(true);
    expect(validateModel(roundTrip(accepted.model)).ok).toBe(true);
  });

  it("下書きの読み取り: 形が違えば null", () => {
    expect(readDatabaseDraft({ system: "x", dsl: "", tables: [{ table: "A", informations: ["a", 1] }, { nope: 1 }] })).toEqual({ system: "x", dsl: "", tables: [{ table: "A", informations: ["a"] }] });
    expect(readDatabaseDraft({ dsl: "" })).toBeNull();
  });
});

describe("サイトマップ", () => {
  it("分析の画面を設計の画面にし、読み取れた遷移を足す (導出済みと重なるものは足さない)", () => {
    const base = withData();
    const r = applySitemapDraft(base, FIXTURE_SITEMAP);
    expect(r.warnings).toEqual([]);
    expect(r.added.screens).toBe(3);
    expect(r.added.transitions + r.added.skipped).toBe(FIXTURE_SITEMAP.transitions.length);
    const design = r.model.designs[0]!;
    const name = (id: string) => designScreenName(r.model, design.screens.find((s) => s.id === id)!);
    const pairs = design.transitions.map((t) => `${name(t.from)}→${name(t.to)}`);
    for (const t of FIXTURE_SITEMAP.transitions) expect(pairs).toContain(`${t.from}→${t.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(validateModel(roundTrip(r.model)).ok).toBe(true);
    // 2 回目は何も増えない
    const again = applySitemapDraft(r.model, FIXTURE_SITEMAP);
    expect(again.added).toMatchObject({ screens: 0, transitions: 0, derivedTransitions: 0 });
    expect(again.model.designs[0]!.transitions).toHaveLength(design.transitions.length);
  });

  it("見つからない画面・同じ画面への遷移は落とし、使えない via はきっかけだけ外す", () => {
    const r = applySitemapDraft(withData(), {
      system: "注文管理システム",
      transitions: [
        { from: "注文一覧", to: "存在しない画面" },
        { from: "注文一覧", to: "注文一覧" },
        { from: "注文詳細", to: "注文登録", via: "teleport", label: "新規" },
      ],
    });
    expect(r.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("存在しない画面"), expect.stringContaining("同じ画面への遷移"), expect.stringContaining("きっかけ「teleport」は使えない")]),
    );
    const design = r.model.designs[0]!;
    const t = design.transitions.find((x) => x.label === "新規");
    expect(t).toBeDefined();
    expect(t!.via).toBeUndefined();
    expect(validateModel(roundTrip(r.model)).ok).toBe(true);
  });

  it("見つからないシステムは何も足さない", () => {
    const m = analysis().model;
    const r = applySitemapDraft(m, { system: "存在しない", transitions: [] });
    expect(r.model).toBe(m);
    expect(r.warnings).toHaveLength(1);
  });

  it("読み取り", () => {
    expect(readSitemapDraft({ system: "x", transitions: [{ from: "a", to: "b", via: "row" }, { from: 1 }] })).toEqual({ system: "x", transitions: [{ from: "a", to: "b", via: "row" }] });
    expect(readSitemapDraft({})).toBeNull();
  });
});

describe("画面 UI", () => {
  it("view と bindings を置く。title は画面の名前にそろい、遷移先の画面の名前は id に直る", () => {
    const m0 = withSitemap();
    const r = applyScreenDraft(m0, FIXTURE_SCREENS[1]!);
    expect(r.applied).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.added).toEqual({ bindings: 3, droppedBindings: 0 });
    const design = r.model.designs[0]!;
    const list = design.screens.find((s) => designScreenName(r.model, s) === "注文一覧")!;
    const detail = design.screens.find((s) => designScreenName(r.model, s) === "注文詳細")!;
    expect(list.view).toMatchObject({ title: "注文一覧" });
    const col = ((list.view as { sections: { list?: { columns: { to?: string }[] } }[] }).sections[1]!.list!.columns[0]!);
    expect(col.to).toBe(detail.id);
    expect(list.bindings).toHaveLength(3);
    // 元の下書きは書き換えない
    expect((FIXTURE_SCREENS[1]!.view as { sections: { list?: { columns: { to?: string }[] } }[] }).sections[1]!.list!.columns[0]!.to).toBe("注文詳細");
  });

  it("すべて組み立てたモデルは validateModel・traceToActors・checkDesign を通る", () => {
    const m = full();
    expect(validateModel(roundTrip(m)).ok).toBe(true);
    expect(traceToActors(m).problems.filter((p) => p.isBreak)).toEqual([]);
    expect(traceToActors(m).errors).toEqual([]);
    expect(traceWarnings(m)).toEqual([]);
    const sys = m.elements.find((e) => e.kind === "system")!;
    const check = checkDesign(m, sys.id);
    expect(check.problems).toEqual([]);
    // 画面 UI を作っていない 注文詳細 だけが警告に残る
    expect(check.warnings.map((w) => w.type)).toEqual(expect.arrayContaining(["screenWithoutView"]));
  });

  it("存在しないテーブル・列・項目への bindings はその対応だけ落として警告にし、view は置く", () => {
    const draft: ScreenDraft = {
      ...FIXTURE_SCREENS[0]!,
      bindings: [...FIXTURE_SCREENS[0]!.bindings, { item: "customer2", table: "Order", column: "customer" }, { item: "quantity", table: "Ghost", column: "x" }, { item: "customer", table: "Order", column: "nothing" }],
    };
    const r = applyScreenDraft(withSitemap(), draft);
    expect(r.applied).toBe(true);
    expect(r.added.droppedBindings).toBe(3);
    expect(r.added.bindings).toBe(2);
    expect(r.warnings.some((w) => w.includes("3 件"))).toBe(true);
    const sys = r.model.elements.find((e) => e.kind === "system")!;
    expect(checkDesign(r.model, sys.id).problems).toEqual([]);
  });

  it("壊れた view は置かず viewError を返す。モデルは変わらない", () => {
    const m = withSitemap();
    const r = applyScreenDraft(m, { screen: "注文登録", view: { sections: [{ id: "a", title: "a", kind: "nonsense" }] }, bindings: [] });
    expect(r.applied).toBe(false);
    expect(r.viewError).toBeTruthy();
    expect(r.model).toBe(m);
    const forbidden = applyScreenDraft(m, { screen: "注文登録", view: JSON.parse('{"__proto__": {"x": 1}, "sections": []}'), bindings: [] });
    expect(forbidden.applied).toBe(false);
    expect(forbidden.model).toBe(m);
  });

  it("見つからない画面は failure、見つからない遷移先は外して警告にする", () => {
    const m = withSitemap();
    const missing = applyScreenDraft(m, { ...FIXTURE_SCREENS[0]!, screen: "存在しない画面" });
    expect(missing.applied).toBe(false);
    expect(missing.failure).toContain("存在しない画面");
    expect(missing.model).toBe(m);
    const draft: ScreenDraft = {
      screen: "注文登録",
      view: { title: "x", goal: "g", sections: [{ id: "a", title: "a", kind: "readonly", note: "n" }], secondaryActions: [{ id: "go", label: "進む", kind: "navigate", to: "迷子" }] },
      bindings: [],
    };
    const r = applyScreenDraft(m, draft);
    expect(r.warnings.some((w) => w.includes("遷移先「迷子」"))).toBe(true);
    const placed = r.model.designs[0]!.screens.find((s) => designScreenName(r.model, s) === "注文登録")!.view as { secondaryActions: unknown[] };
    expect(placed.secondaryActions).toEqual([]);
  });

  it("データベースを足す前でも view は置け、対応は落ちる", () => {
    const base = applySitemapDraft(analysis().model, FIXTURE_SITEMAP).model;
    const r = applyScreenDraft(base, FIXTURE_SCREENS[0]!);
    expect(r.applied).toBe(true);
    expect(r.added.bindings).toBe(0);
    expect(validateModel(roundTrip(r.model)).ok).toBe(true);
  });

  it("読み取り", () => {
    const d = readScreenDraft({ screen: "a", view: { sections: [] }, bindings: [{ item: "i", table: "T", column: "c" }, { item: 1 }] });
    expect(d).toEqual({ screen: "a", view: { sections: [] }, bindings: [{ item: "i", table: "T", column: "c" }] });
    expect(readScreenDraft({ screen: "a", view: [] })).toBeNull();
  });
});
