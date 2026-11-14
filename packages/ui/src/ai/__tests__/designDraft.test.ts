import { describe, expect, it } from "vitest";
import { checkDesign } from "@untie/core/model/designCheck";
import { effectiveDatabaseIds } from "@untie/core/model/design";
import { designScreenName } from "@untie/core/model/sitemap";
import { traceToActors, traceWarnings } from "@untie/core/model/trace";
import type { UntieModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import {
  applyDatabaseDraft,
  applyScreenDraft,
  applySitemapDraft,
  DESIGN_DRAFT_LIMITS,
  readDatabaseDraft,
  readScreenDraft,
  readSitemapDraft,
  resolveDatabaseName,
  SUBMIT_DATABASE_DRAFT_TOOL,
  SUBMIT_SCREEN_DRAFT_TOOL,
  submitDatabaseTool,
  tableOverlap,
  type DatabaseDraft,
  type ScreenDraft,
} from "../designDraft";
import { buildModelFromSpec, SPEC_LIMITS, SUBMIT_MODEL_TOOL, type ModelSpec } from "../spec";
import { FIXTURE_DATABASE, FIXTURE_DSL, FIXTURE_SCREENS, FIXTURE_SITEMAP, FIXTURE_SPEC } from "./fixtures/reverseDraft";

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

  it("同じ画面と同じ操作の組を 2 回書かれても、黙って 1 つだけ結ぶ (別の操作が使っているという嘘の警告を出さない)", () => {
    const spec = structuredClone(FIXTURE_SPEC);
    spec.screens!.push({ name: "注文登録", system: "注文管理システム", usecase: "注文を登録する" }, { name: "注文登録", usecase: "注文を登録する" });
    const r = buildModelFromSpec(spec);
    expect(r.warnings).toEqual([]);
    const uc = r.model.elements.find((e) => e.name === "注文を登録する")!;
    expect(r.model.relations.filter((x) => x.kind === "usecaseScreen" && x.sourceId === uc.id)).toHaveLength(1);
    expect(r.counts.screen).toBe(3);
  });

  it("操作の対象のシステムと画面の属するシステムが違うときは、対象を替えずに結ばず警告する", () => {
    const spec: ModelSpec = {
      system_name: "x",
      actors: [{ name: "担当" }],
      systems: [{ name: "販売システム" }, { name: "配送システム" }],
      businesses: [{ name: "業務", main_actors: ["担当"], activities: [{ name: "作業", performers: ["担当"], usecases: [{ name: "注文する", targets: ["販売システム"] }] }] }],
      screens: [{ name: "配送の画面", system: "配送システム", usecase: "注文する" }],
    };
    const r = buildModelFromSpec(spec);
    expect(r.warnings).toEqual([expect.stringContaining("操作「注文する」の対象はシステム「販売システム」なので、システム「配送システム」の画面「配送の画面」とは結びませんでした")]);
    const uc = r.model.elements.find((e) => e.name === "注文する")!;
    const sale = r.model.elements.find((e) => e.name === "販売システム")!;
    expect(r.model.relations.filter((x) => x.sourceId === uc.id && (x.kind === "usecaseSystem" || x.kind === "usecaseScreen")).map((x) => [x.kind, x.targetId])).toEqual([["usecaseSystem", sale.id]]);
    expect(traceToActors(r.model).errors).toEqual([]);
  });

  it("すでに対象のある操作に別の対象を書かれたら、操作の名前を入れた警告にする", () => {
    const spec: ModelSpec = {
      system_name: "x",
      actors: [{ name: "担当" }],
      systems: [{ name: "販売システム" }],
      ledgers: [{ name: "納品書" }],
      businesses: [
        {
          name: "業務",
          main_actors: ["担当"],
          activities: [
            { name: "作業 1", performers: ["担当"], usecases: [{ name: "記録する", targets: ["販売システム"] }] },
            { name: "作業 2", performers: ["担当"], usecases: [{ name: "記録する", targets: ["納品書"] }] },
          ],
        },
      ],
    };
    const r = buildModelFromSpec(spec);
    expect(r.warnings).toEqual(["操作「記録する」の対象はすでに「販売システム」なので「納品書」は結びませんでした"]);
  });

  it("名前の無い画面・イベント・操作は、件数を警告にして飛ばす", () => {
    const spec = structuredClone(FIXTURE_SPEC);
    spec.screens!.push({ name: "" }, { name: "  " });
    spec.events!.push({ name: "", raised_by: ["注文管理システム"] });
    spec.businesses[0]!.activities![0]!.usecases!.push({ name: " " });
    const r = buildModelFromSpec(spec);
    expect(r.warnings).toEqual(expect.arrayContaining(["名前の無い画面を 2 件飛ばしました", "名前の無いイベントを 1 件飛ばしました", "名前の無い操作を 1 件飛ばしました"]));
    expect(r.counts).toMatchObject({ screen: 3, event: 3, usecase: 6 });
  });

  it("自分の操作から起きるイベントが、その操作を起こすだけの循環は、担い手まで辿れない箇所として出る", () => {
    const spec: ModelSpec = {
      system_name: "x",
      actors: [{ name: "担当" }],
      businesses: [{ name: "業務", main_actors: ["担当"], activities: [{ name: "作業", performers: ["担当"], usecases: [{ name: "普通の操作" }] }] }],
      events: [{ name: "循環のイベント", raised_by: ["循環の操作"], usecases: [{ name: "循環の操作" }] }],
    };
    const r = buildModelFromSpec(spec);
    expect(r.warnings).toEqual([]);
    expect(validateModel(roundTrip(r.model)).ok).toBe(true);
    const breaks = traceToActors(r.model).problems.filter((p) => p.isBreak);
    expect(breaks.map((p) => r.model.elements.find((e) => e.id === p.elementId)?.name).sort()).toEqual(["循環のイベント", "循環の操作"]);
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
    // 置き直して注文の対応が無くなったので、検証にも出て、警告にも入る (同じ情報)
    const sys = twice.model.designs[0]!.systemId;
    const unmapped = checkDesign(twice.model, sys).problems.filter((p) => p.type === "informationUnmapped");
    expect(unmapped.map((p) => p.message)).toEqual(["情報「注文」が、使うデータベースのどのテーブルにも対応していません"]);
    expect(twice.warnings).toEqual(["データ: 情報「注文」がどのテーブルにも対応していません"]);
  });

  it("見つからない情報・DSL に無いテーブルはその部分だけ落として警告にする", () => {
    const r = applyDatabaseDraft(analysis().model, {
      ...FIXTURE_DATABASE,
      tables: [...FIXTURE_DATABASE.tables, { table: "Ghost", informations: ["注文"] }, { table: "Product", informations: ["商品", "存在しない情報"] }],
    });
    expect(r.applied).toBe(true);
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Ghost が DSL に無い"), expect.stringContaining("「存在しない情報」が見つかりません")]));
    expect(r.model.databases[0]!.tables.map((t) => t.table)).not.toContain("Ghost");
    // 注文・商品はほかのテーブルが表しているので、検証にも未対応は出ない
    expect(checkDesign(r.model, r.model.designs[0]!.systemId).problems).toEqual([]);
    expect(r.warnings.some((w) => w.includes("がどのテーブルにも対応していません"))).toBe(false);
    // 見つからない情報だけを書いたテーブルは対応が空になり、その情報はどのテーブルにも対応しない
    const none = applyDatabaseDraft(analysis().model, { ...FIXTURE_DATABASE, tables: [{ table: "Product", informations: ["存在しない情報"] }] });
    expect(none.warnings).toEqual(
      expect.arrayContaining([
        "データ: テーブル Product が表す情報「存在しない情報」が見つかりません",
        "データ: 情報「注文」がどのテーブルにも対応していません",
        "データ: 情報「商品」がどのテーブルにも対応していません",
      ]),
    );
    const sys = none.model.designs[0]!.systemId;
    expect(checkDesign(none.model, sys).problems.filter((p) => p.type === "informationUnmapped")).toHaveLength(2);
  });

  it("空の DSL や誤記では、システムが使う情報が対応していないと警告する (出し直しの材料)", () => {
    const r = applyDatabaseDraft(analysis().model, { system: FIXTURE_DATABASE.system, dsl: "", tables: [] });
    expect(r.applied).toBe(true);
    expect(r.warnings).toEqual(["データ: 情報「商品」がどのテーブルにも対応していません", "データ: 情報「注文」がどのテーブルにも対応していません"].sort((a, b) => a.localeCompare(b, "ja")));
    const sys = r.model.designs[0]!.systemId;
    expect(checkDesign(r.model, sys).problems.filter((p) => p.type === "informationUnmapped")).toHaveLength(2);
  });

  it("enum の名前をテーブルに書かれたら、DSL に無いのではなく enum だと言い分ける", () => {
    const dsl = `${FIXTURE_DSL}\nenum OrderStatus {\n  OPEN\n  CLOSED\n}\n`;
    const r = applyDatabaseDraft(analysis().model, { ...FIXTURE_DATABASE, dsl, tables: [...FIXTURE_DATABASE.tables, { table: "OrderStatus", informations: ["注文"] }] });
    expect(r.applied).toBe(true);
    expect(r.warnings).toEqual(["データ: OrderStatus は model ではなく enum なので、情報との対応を外しました (情報に対応させるのは model だけです)"]);
    expect(r.model.databases[0]!.tables.map((t) => t.table)).not.toContain("OrderStatus");
  });

  it("列を減らした DSL で置き直すと、画面の対応のうち無くなった列を指すものを外し、何を外したかを警告に入れる", () => {
    const before = full();
    const sys = before.designs[0]!.systemId;
    expect(checkDesign(before, sys).problems).toEqual([]);
    const smaller = FIXTURE_DSL.replace("  status     String\n", "").replace("  quantity  Int\n", "");
    const r = applyDatabaseDraft(before, { ...FIXTURE_DATABASE, dsl: smaller });
    expect(r.applied).toBe(true);
    expect(r.model.databases).toHaveLength(1);
    // 検証に bindingInvalid が出ない
    expect(checkDesign(r.model, sys).problems).toEqual([]);
    expect(validateModel(roundTrip(r.model)).ok).toBe(true);
    const list = r.model.designs[0]!.screens.find((s) => designScreenName(r.model, s) === "注文一覧")!;
    expect(list.bindings!.map((b) => b.item)).toEqual(["keyword", "res.customer"]);
    const register = r.model.designs[0]!.screens.find((s) => designScreenName(r.model, s) === "注文登録")!;
    expect(register.bindings!.map((b) => b.item)).toEqual(["customer"]);
    expect(r.warnings).toEqual([
      expect.stringContaining("画面「注文登録」の項目と列の対応のうち 1 件を、テーブル・列が無くなったため外しました (quantity → OrderItem.quantity)"),
      expect.stringContaining("画面「注文一覧」の項目と列の対応のうち 1 件を、テーブル・列が無くなったため外しました (res.status → Order.status)"),
    ]);
  });

  it("DSL を空にして置き直すと、画面の対応はすべて外れ、検証に出るのは未対応の情報だけになる", () => {
    const before = full();
    const r = applyDatabaseDraft(before, { ...FIXTURE_DATABASE, dsl: "", tables: [] });
    const sys = r.model.designs[0]!.systemId;
    expect(new Set(checkDesign(r.model, sys).problems.map((p) => p.type))).toEqual(new Set(["informationUnmapped"]));
    expect(r.model.designs[0]!.screens.every((s) => !s.bindings || s.bindings.length === 0)).toBe(true);
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

  it("導出済みの遷移と同じ両端を AI が出したら、きっかけ・文言が未定のときだけ AI の値で埋める (決まっているものは変えない)", () => {
    // 登録 → 一覧の連鎖 (イベントをはさむ) があるモデル。導出される遷移はきっかけが未定
    const spec = structuredClone(FIXTURE_SPEC);
    spec.events = [...spec.events!, { name: "登録が済んだ", raised_by: ["注文を登録する"], usecases: [{ name: "注文を検索する" }] }];
    const withChain = applyDatabaseDraft(buildModelFromSpec(spec).model, FIXTURE_DATABASE).model;
    const base = applySitemapDraft(withChain, { system: "注文管理システム", transitions: [] }).model;
    const design = base.designs[0]!;
    const name = (id: string) => designScreenName(base, design.screens.find((s) => s.id === id)!);
    // 作業のつながりから導かれた遷移 (きっかけは未定)
    const undecided = design.transitions.filter((t) => t.via === undefined);
    expect(undecided.length).toBeGreaterThan(0);
    const target = undecided[0]!;
    const r = applySitemapDraft(base, { system: "注文管理システム", transitions: [{ from: name(target.from), to: name(target.to), via: "afterSubmit", label: "登録する" }] });
    expect(r.warnings).toEqual([]);
    expect(r.added).toMatchObject({ transitions: 0, skipped: 1 });
    const filled = r.model.designs[0]!.transitions.find((t) => t.id === target.id)!;
    expect(filled.via).toBe("afterSubmit");
    expect(filled.label).toBe("登録する");
    expect(r.model.designs[0]!.transitions).toHaveLength(design.transitions.length);
    expect(checkDesign(r.model, r.model.designs[0]!.systemId).warnings.filter((w) => w.type === "transitionViaUndecided")).toHaveLength(undecided.length - 1);
    // 決まっているものは、2 回目の提出で変えない
    const again = applySitemapDraft(r.model, { system: "注文管理システム", transitions: [{ from: name(target.from), to: name(target.to), via: "button", label: "別の文言" }] });
    const kept = again.model.designs[0]!.transitions.find((t) => t.id === target.id)!;
    expect(kept.via).toBe("afterSubmit");
    expect(kept.label).toBe("登録する");
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
    // 警告に残るのは 2 つだけ: 画面 UI を作っていない 注文詳細 と、メニューも遷移もない入口の 注文登録 (フィクスチャにメニューが無いため)
    expect(check.warnings.map((w) => [w.type, w.message])).toEqual([
      ["screenUnreachable", "画面「注文登録」は、メニューにも、ほかの画面からの遷移にもありません"],
      ["screenWithoutView", "画面 UI がまだ無い画面が 1 件あります (注文詳細)"],
    ]);
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

describe("画面 UI: 遷移先・データベース・対応の落とし方", () => {
  const registerView = (extra: Record<string, unknown>) => ({
    title: "x",
    goal: "g",
    sections: [{ id: "a", title: "a", kind: "readonly", note: "n" }],
    ...extra,
  });
  const placed = (m: UntieModel, name: string) => m.designs[0]!.screens.find((s) => designScreenName(m, s) === name)!.view as Record<string, unknown>;

  it("遷移先は、サイトマップでこの画面から出る遷移の行き先だけ。遷移の無い画面・自分自身は外して警告にする", () => {
    const m = withSitemap();
    // 注文登録 から出る遷移は 注文一覧 だけ
    const r = applyScreenDraft(m, {
      screen: "注文登録",
      bindings: [],
      view: registerView({
        primaryAction: { id: "register", label: "登録する", kind: "submit", to: "注文一覧" },
        secondaryActions: [
          { id: "detail", label: "詳細へ", kind: "navigate", to: "注文詳細" },
          { id: "self", label: "自分へ", kind: "navigate", to: "注文登録" },
          { id: "list", label: "一覧へ", kind: "navigate", to: "注文一覧" },
        ],
      }),
    });
    expect(r.applied).toBe(true);
    expect(r.warnings).toEqual([
      expect.stringContaining("遷移先「注文詳細」は、サイトマップでこの画面から出る遷移の行き先ではない"),
      expect.stringContaining("遷移先「注文登録」は、サイトマップでこの画面から出る遷移の行き先ではない"),
    ]);
    const view = placed(r.model, "注文登録") as { primaryAction: { to: string }; secondaryActions: { id: string }[] };
    expect(view.secondaryActions.map((a) => a.id)).toEqual(["list"]);
    expect(view.primaryAction.to).toBe(r.model.designs[0]!.transitions.find((t) => t.label === "登録する")!.to);
    // 送信のあと・一覧の列の to は、to だけを外す (id で書いても同じ)
    const list = applyScreenDraft(m, {
      screen: "注文一覧",
      bindings: [],
      view: registerView({ primaryAction: { id: "go", label: "進む", kind: "submit", to: "注文登録" } }),
    });
    expect(list.warnings).toEqual([expect.stringContaining("遷移先「注文登録」は、サイトマップでこの画面から出る遷移の行き先ではない")]);
    expect((placed(list.model, "注文一覧").primaryAction as { to?: string }).to).toBeUndefined();
  });

  it("bindings の database (データベースの名前) を道具で送れ、使うデータベースが 2 つあるシステムでも対応が全部落ちない", () => {
    const props = (SUBMIT_SCREEN_DRAFT_TOOL.parameters as { properties: { bindings: { items: { properties: Record<string, { description?: string }>; additionalProperties: boolean } } } }).properties.bindings.items;
    expect(Object.keys(props.properties)).toContain("database");
    expect(props.properties.database!.description).toContain("複数あるときは必須");
    expect(props.additionalProperties).toBe(false);

    const stockDsl = "model Stock {\n  id  String @id\n  qty Int\n}\n";
    const two = applyDatabaseDraft(withData(), { system: FIXTURE_DATABASE.system, database_name: "在庫DB", dsl: stockDsl, tables: [{ table: "Stock", informations: ["商品"] }] }).model;
    expect(two.designs[0]!.databaseIds).toHaveLength(2);
    const base = applySitemapDraft(two, FIXTURE_SITEMAP).model;
    const draft = readScreenDraft({
      screen: "注文登録",
      view: FIXTURE_SCREENS[0]!.view,
      bindings: [
        { item: "customer", table: "Order", column: "customer", database: "注文DB" },
        { item: "quantity", table: "Stock", column: "qty", database: "在庫DB" },
      ],
    })!;
    const r = applyScreenDraft(base, draft);
    expect(r.warnings).toEqual([]);
    expect(r.added).toEqual({ bindings: 2, droppedBindings: 0 });
    const sys = r.model.designs[0]!.systemId;
    expect(checkDesign(r.model, sys).problems).toEqual([]);
    expect(new Set(r.model.designs[0]!.screens.flatMap((s) => s.bindings ?? []).map((b) => b.databaseId)).size).toBe(2);
    // database を省くと、どちらか決められないので落とし、理由を警告に入れる
    const omitted = applyScreenDraft(base, { ...draft, bindings: draft.bindings.map(({ database: _d, ...b }) => b) });
    expect(omitted.added).toEqual({ bindings: 0, droppedBindings: 2 });
    expect(omitted.warnings).toEqual([expect.stringContaining("customer: 使うデータベースが複数あるのに、データベースが決まりません")]);
  });

  it("見つからないデータベース名を唯一のデータベースに付け替えるときは警告する。落とした対応は、項目と理由を入れる", () => {
    const m = withSitemap();
    const r = applyScreenDraft(m, {
      ...FIXTURE_SCREENS[0]!,
      bindings: [
        { item: "customer", table: "Order", column: "customer", database: "存在しないDB" },
        { item: "quantity", table: "OrderItem", column: "quantity", database: "存在しないDB" },
        { item: "ghost", table: "Order", column: "customer" },
        { item: "customer", table: "Order", column: "nothing" },
        { item: "quantity", table: "Ghost", column: "x" },
      ],
    });
    expect(r.added).toEqual({ bindings: 2, droppedBindings: 3 });
    expect(r.warnings).toEqual([
      "画面 UI: 画面「注文登録」の対応のデータベース「存在しないDB」が見つからないので、使うデータベース「注文DB」に付け替えました",
      "画面 UI: 画面「注文登録」の項目と列の対応のうち 3 件は、落としました (ghost: view に無い項目です、customer: テーブル Order に列 nothing がありません、quantity: テーブル Ghost がありません)",
    ]);
    // 同じ項目の 2 つ目
    const dup = applyScreenDraft(m, { ...FIXTURE_SCREENS[0]!, bindings: [{ item: "customer", table: "Order", column: "customer" }, { item: "customer", table: "Order", column: "status" }] });
    expect(dup.warnings).toEqual([expect.stringContaining("customer: 同じ項目の対応がすでにあります")]);
  });

  it("対応の数と遷移の数には上限があり、超えた分は先頭だけ使って警告する", () => {
    const m = withSitemap();
    const many = Array.from({ length: DESIGN_DRAFT_LIMITS.bindings + 10 }, (_, i) => ({ item: `item${i}`, table: "Order", column: "customer" }));
    const r = applyScreenDraft(m, { ...FIXTURE_SCREENS[0]!, bindings: many });
    expect(r.warnings[0]).toBe(`画面 UI: 画面「注文登録」の項目と列の対応は先頭 ${DESIGN_DRAFT_LIMITS.bindings} 件だけ使いました (${DESIGN_DRAFT_LIMITS.bindings + 10} 件ありました)`);
    const transitions = Array.from({ length: DESIGN_DRAFT_LIMITS.transitions + 5 }, () => ({ from: "注文一覧", to: "存在しない画面" }));
    const s = applySitemapDraft(withData(), { system: FIXTURE_DATABASE.system, transitions });
    expect(s.warnings[0]).toBe(`サイトマップ: 遷移は先頭 ${DESIGN_DRAFT_LIMITS.transitions} 件だけ使いました (${DESIGN_DRAFT_LIMITS.transitions + 5} 件ありました)`);
    expect(s.warnings).toHaveLength(1 + DESIGN_DRAFT_LIMITS.transitions);
  });
});

describe("システムが 2 つあるときのデータ", () => {
  const twoSystems = (): ModelSpec => {
    const spec = structuredClone(FIXTURE_SPEC);
    spec.systems!.push({ name: "配送システム" });
    spec.informations!.push({ name: "配送先" });
    spec.businesses[0]!.activities!.push({
      name: "配送を手配する",
      performers: ["受付担当"],
      usecases: [{ name: "配送を登録する", writes: ["配送先"] }],
    });
    spec.screens!.push({ name: "配送登録", system: "配送システム", usecase: "配送を登録する" });
    return spec;
  };
  const shipment: DatabaseDraft = {
    system: "配送システム",
    database_name: "配送DB",
    dsl: "model Shipment {\n  id      String @id\n  address String\n}\n",
    tables: [{ table: "Shipment", informations: ["配送先"] }],
  };
  const shipmentScreen: ScreenDraft = {
    screen: "配送登録",
    view: { title: "配送登録", goal: "g", sections: [{ id: "f", title: "配送", kind: "form", fields: [{ item: "address", label: "住所", component: "text" }, { item: "customer", label: "お客様名", component: "text" }] }] },
    bindings: [
      { item: "address", table: "Shipment", column: "address" },
      { item: "customer", table: "Order", column: "customer" },
    ],
  };
  const sitemapB = { system: "配送システム", transitions: [] };

  for (const order of ["データ → 配送のサイトマップ", "配送のサイトマップ → データ"] as const) {
    it(`片方のシステムのデータが、databaseIds が空の他方の設計に流れ込まない (${order})`, () => {
      let m = buildModelFromSpec(twoSystems()).model;
      expect(m.databases).toHaveLength(0);
      if (order.startsWith("データ")) {
        m = applyDatabaseDraft(m, FIXTURE_DATABASE).model;
        m = applySitemapDraft(m, sitemapB).model;
      } else {
        m = applySitemapDraft(m, sitemapB).model;
        m = applyDatabaseDraft(m, FIXTURE_DATABASE).model;
      }
      const sales = m.elements.find((e) => e.name === "注文管理システム")!.id;
      const shipping = m.elements.find((e) => e.name === "配送システム")!.id;
      // 配送システムの設計は、databaseIds が空のまま。注文DB を使ってはいない
      const shippingDesign = m.designs.find((d) => d.systemId === shipping)!;
      expect(shippingDesign.databaseIds).toEqual([]);
      const orderDb = m.databases.find((d) => d.name === "注文DB")!;
      expect(effectiveDatabaseIds(m, shippingDesign)).not.toContain(orderDb.id);
      // 配送の画面で、注文DB の Order への対応 (データベースを書かない) は通らない。配送DB を足すと自分の対応だけが通る
      const before = applyScreenDraft(m, shipmentScreen);
      expect(before.added.bindings).toBe(0);
      m = applyDatabaseDraft(m, shipment).model;
      const r = applyScreenDraft(m, shipmentScreen);
      expect(r.added).toEqual({ bindings: 1, droppedBindings: 1 });
      expect(r.warnings).toEqual([expect.stringContaining("customer: テーブル Order がありません")]);
      m = r.model;
      // 組み立てたモデルは、どちらのシステムの検証にもエラーが無い
      expect(validateModel(roundTrip(m)).ok).toBe(true);
      expect(checkDesign(m, shipping).problems).toEqual([]);
      m = applySitemapDraft(m, FIXTURE_SITEMAP).model;
      for (const s of FIXTURE_SCREENS) m = applyScreenDraft(m, s).model;
      expect(checkDesign(m, sales).problems).toEqual([]);
      expect(checkDesign(m, shipping).problems).toEqual([]);
      // 配送システムが使うデータベースは配送DB だけ。注文DB は注文管理システムだけが使う
      expect(m.designs.find((d) => d.systemId === sales)!.databaseIds).toEqual([orderDb.id]);
      expect(m.designs.find((d) => d.systemId === shipping)!.databaseIds).toEqual([m.databases.find((d) => d.name === "配送DB")!.id]);
      // 使われない空の既定のデータベースが残るが、検証 (checkDesign) は何も言わない
      expect(m.databases.map((d) => d.name)).toEqual(["既定のデータベース", "注文DB", "配送DB"]);
    });
  }

  it("システムが 1 つだけのときは、空の既定のデータベースを流用し、余計なデータベースを残さない", () => {
    const base = applySitemapDraft(analysis().model, FIXTURE_SITEMAP).model;
    expect(base.databases.map((d) => d.id)).toEqual(["db_default"]);
    const r = applyDatabaseDraft(base, FIXTURE_DATABASE);
    expect(r.model.databases).toHaveLength(1);
    expect(r.model.databases[0]).toMatchObject({ id: "db_default", name: "注文DB" });
  });
});

describe("上限と道具の説明", () => {
  it("テーブルの対応の数に上限があり、超えた分は先頭だけ使って警告する", () => {
    const extra = Array.from({ length: DESIGN_DRAFT_LIMITS.tables + 5 }, (_, i) => ({ table: `T${i}`, informations: ["商品"] }));
    const r = applyDatabaseDraft(analysis().model, { ...FIXTURE_DATABASE, tables: extra });
    expect(r.warnings[0]).toBe(`データ: テーブルの対応は先頭 ${DESIGN_DRAFT_LIMITS.tables} 件だけ使いました (${DESIGN_DRAFT_LIMITS.tables + 5} 件ありました)`);
  });

  it("上限いっぱいの下書きを、数秒以内に足せる", () => {
    const n = SPEC_LIMITS.screens;
    const spec: ModelSpec = {
      system_name: "大きなアプリ",
      actors: [{ name: "担当" }],
      systems: [{ name: "基幹" }],
      informations: [{ name: "商品" }],
      businesses: [
        {
          name: "業務",
          main_actors: ["担当"],
          activities: [{ name: "作業", performers: ["担当"], usecases: Array.from({ length: n }, (_, i) => ({ name: `操作${i}`, reads: ["商品"] })) }],
        },
      ],
      screens: Array.from({ length: n }, (_, i) => ({ name: `画面${i}`, usecase: `操作${i}` })),
    };
    const built = buildModelFromSpec(spec);
    expect(built.counts.screen).toBe(n);
    const start = performance.now();
    let m = applyDatabaseDraft(built.model, { system: "基幹", dsl: "model Item {\n  id String @id\n  name String\n}\n", tables: [{ table: "Item", informations: ["商品"] }] }).model;
    const transitions = Array.from({ length: DESIGN_DRAFT_LIMITS.transitions }, (_, i) => ({ from: `画面${i % n}`, to: `画面${(i + 1) % n}`, via: "button" }));
    const sitemap = applySitemapDraft(m, { system: "基幹", transitions });
    m = sitemap.model;
    expect(sitemap.added.screens).toBe(n);
    const last = applyScreenDraft(m, {
      screen: "画面1",
      view: { title: "x", goal: "g", sections: [{ id: "a", title: "a", kind: "form", fields: [{ item: "name", label: "名前", component: "text" }] }], primaryAction: { id: "go", label: "進む", kind: "submit", to: "画面2" } },
      bindings: [{ item: "name", table: "Item", column: "name" }],
    });
    expect(last.applied).toBe(true);
    expect(performance.now() - start).toBeLessThan(6000);
    expect(validateModel(roundTrip(last.model)).ok).toBe(true);
  });

  it("submit_database の tables[].table・informations と、submit_model の画面の説明", () => {
    const tables = (SUBMIT_DATABASE_DRAFT_TOOL.parameters as { properties: { tables: { items: { properties: Record<string, { description?: string }> } } } }).properties.tables.items.properties;
    expect(tables.table!.description).toContain("enum の名前ではない");
    expect(tables.informations!.description).toContain("モデルにある情報");
    // 「プロンプトから作成」と共有する道具なので、ソースコード前提の文を入れない
    expect(JSON.stringify(SUBMIT_MODEL_TOOL)).not.toContain("ソースコード");
  });
});

describe("データベースの置き換えと名前 (共有のデータベースを上書きしない)", () => {
  /** システムを 2 つにして、片方が「注文DB」を写し、もう片方がそれを使っているモデル */
  function shared() {
    const spec: ModelSpec = { ...FIXTURE_SPEC, systems: [...(FIXTURE_SPEC.systems ?? []), { name: "管理サイト" }] };
    const base = buildModelFromSpec(spec).model;
    const first = applyDatabaseDraft(base, FIXTURE_DATABASE);
    expect(first.applied).toBe(true);
    const dbId = first.databaseId!;
    const admin = first.model.elements.find((e) => e.kind === "system" && e.name === "管理サイト")!;
    const used = applyDatabaseDraftUse(first.model, admin.id, dbId);
    return { model: used, dbId, adminName: "管理サイト" };
  }
  /** 設計が使うデータベースに、すでにあるデータベースを足す (use_database と同じ結果) */
  function applyDatabaseDraftUse(m: UntieModel, systemId: string, dbId: string): UntieModel {
    const design = m.designs.find((d) => d.systemId === systemId);
    return {
      ...m,
      designs: design
        ? m.designs.map((d) => (d.systemId === systemId ? { ...d, databaseIds: [...d.databaseIds, dbId] } : d))
        : [...m.designs, { systemId, screens: [], transitions: [], navigation: [], databaseIds: [dbId] } as never],
    };
  }
  const cart = (system: string): DatabaseDraft => ({ system, database_name: "注文DB", dsl: "model Cart {\n  id String @id\n}\n", tables: [{ table: "Cart", informations: ["注文"] }] });

  it("設計が使っている共有のデータベースと同じ名前の提出は、置き換えず、何も足さずに nameTaken を返す (注文DB は元のまま)", () => {
    const { model, dbId, adminName } = shared();
    const r = applyDatabaseDraft(model, cart(adminName), { replaceableIds: [] });
    expect(r.applied).toBe(false);
    expect(r.nameTaken).toBe(true);
    expect(r.model).toBe(model);
    const db = r.model.databases.find((d) => d.id === dbId)!;
    expect(db.dsl).toBe(FIXTURE_DSL);
    expect(db.tables.length).toBeGreaterThan(0);
    // 既定 (replaceableIds を省略): 設計が使っているデータベースは置き換えてよいことになる (これまでの動き)
    const old = applyDatabaseDraft(model, cart(adminName));
    expect(old.applied).toBe(true);
  });

  it("置き換えてよいのは replaceableIds のものだけ。自分で写したデータベースは、同じ名前の出し直しで置き換わる。同じ名前のデータベースは 2 つにならない", () => {
    const { model, dbId, adminName } = shared();
    const own = applyDatabaseDraft(model, { ...cart(adminName), database_name: "承認DB" }, { replaceableIds: [] });
    expect(own.applied).toBe(true);
    const ownId = own.databaseId!;
    expect(ownId).not.toBe(dbId);
    const again = applyDatabaseDraft(own.model, { ...cart(adminName), database_name: "承認DB", dsl: "model Cart {\n  id String @id\n  total Int\n}\n" }, { replaceableIds: [ownId] });
    expect(again.applied).toBe(true);
    expect(again.databaseId).toBe(ownId);
    expect(again.model.databases.filter((d) => d.name === "承認DB")).toHaveLength(1);
    expect(again.model.databases.find((d) => d.id === dbId)!.dsl).toBe(FIXTURE_DSL);
    // 自分のものでも、共有のものと同じ名前に変えての出し直しは断る
    const clash = applyDatabaseDraft(again.model, cart(adminName), { replaceableIds: [ownId] });
    expect(clash.nameTaken).toBe(true);
    expect(new Set(again.model.databases.map((d) => d.name)).size).toBe(again.model.databases.length);
  });

  it("単一のシステムで、空の既定のデータベースしか無いときは、同じ名前でもそれを使う (断らない)", () => {
    const r = applyDatabaseDraft(analysis().model, { ...FIXTURE_DATABASE, database_name: "既定のデータベース" });
    expect(r.applied).toBe(true);
    expect(r.nameTaken).toBeUndefined();
  });

  it("tableOverlap: 大文字小文字を無視し、出したテーブルの過半が既存にある、または既存の過半を含むときだけ同じかもしれない", () => {
    const existing = ["Order", "OrderItem", "Product"];
    expect(tableOverlap(["Product"], existing).similar).toBe(true); // 出したものの全部が既存にある
    expect(tableOverlap(["order", "ORDERITEM", "product"], existing)).toEqual({ common: ["order", "ORDERITEM", "product"], similar: true });
    expect(tableOverlap([...existing, "Extra"], existing).similar).toBe(true); // 既存に 1 つ足しただけ
    expect(tableOverlap(["Order", "Stock", "Shelf"], existing).similar).toBe(false); // 3 つのうち 1 つ (出したものも既存も過半ではない)
    expect(tableOverlap(["Order", "OrderItem", "Stock", "Shelf"], existing).similar).toBe(true); // 既存の過半を含む
    expect(tableOverlap(["Stock"], existing)).toEqual({ common: [], similar: false });
    expect(tableOverlap([], existing).similar).toBe(false);
    expect(tableOverlap(["Order"], []).similar).toBe(false);
  });

  it("submit_database の道具: 共有がありうる (システムが複数) ときだけ、データの中身で名前を付ける説明が出る。理由の項目は、すでにあるデータベースがあるときだけ", () => {
    const desc = (t: ReturnType<typeof submitDatabaseTool>) => (t.parameters as { properties: Record<string, { description?: string }> }).properties;
    expect(desc(SUBMIT_DATABASE_DRAFT_TOOL).database_name!.description).not.toMatch(/ほかのシステム/);
    expect(desc(SUBMIT_DATABASE_DRAFT_TOOL).separate_reason).toBeUndefined();
    expect(desc(submitDatabaseTool({ shareable: true })).database_name!.description).toMatch(/システムの名前にしない。ほかのシステムも同じデータベースを使うため/);
    expect(desc(submitDatabaseTool({ shareable: true })).separate_reason).toBeUndefined();
    const withExisting = submitDatabaseTool({ shareable: true, existing: true });
    expect(desc(withExisting).separate_reason!.description).toMatch(/別のデータベース/);
    expect((withExisting.parameters as { required: string[] }).required).toEqual(["system", "dsl", "tables"]);
    expect(readDatabaseDraft({ system: "s", dsl: "", tables: [], separate_reason: "  別のもの  " })!.separate_reason).toBe("別のもの");
    expect(readDatabaseDraft({ system: "s", dsl: "", tables: [], separate_reason: "  " })!.separate_reason).toBeUndefined();
    expect(resolveDatabaseName("ショップ")).toBe("ショップのデータベース");
  });
});
