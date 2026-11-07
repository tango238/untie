import { describe, expect, it } from "vitest";
import { addDatabase, addDesignScreens, clearDesignScreenView, removeDatabase, setDatabaseDsl, setDesignScreenBindings, setDesignScreenView } from "../commands";
import { checkDesign } from "../designCheck";
import { columnBindingKey, viewBindingSlots, viewShapeProblem } from "../designView";
import { VIEW_JSON_MAX_LENGTH, VIEW_MAX_DEPTH, VIEW_MAX_NODES } from "../limits";
import { repairModel } from "../repair";
import { emptyModel, type UntieModel } from "../types";
import { validateModel } from "../validate";
import { retailSample } from "../../sample";
import { expectFail, okModel } from "./helpers";

const DSL = `model Item {
  id    String @id
  name  String
  price Int
}
`;

const VIEW = {
  title: "検索",
  goal: "探す",
  sections: [
    { id: "cond", title: "条件", kind: "form", fields: [{ item: "keyword", label: "キーワード", component: "text" }] },
    { id: "res", title: "結果", kind: "list", list: { columns: [{ id: "name", label: "名前" }, { id: "price", label: "価格" }] } },
  ],
};

/** 設計 (システム sys_a) に画面 d1 と、DSL のあるデータベース db_x */
function base(): UntieModel {
  let m = emptyModel();
  m.elements = [
    { id: "sys_a", kind: "system", name: "予約システム" },
    { id: "scr_1", kind: "screen", name: "予約検索", systemId: "sys_a" },
    { id: "actor_1", kind: "actor", name: "受付" },
    { id: "actor_2", kind: "actor", name: "店長" },
    { id: "ext_1", kind: "externalActor", name: "客" },
    { id: "biz_1", kind: "business", name: "予約" },
    { id: "buc_1", kind: "buc", name: "予約", businessId: "biz_1", isDefault: true },
    { id: "act_1", kind: "activity", name: "受ける", bucId: "buc_1" },
    { id: "uc_1", kind: "usecase", name: "検索する" },
  ] as UntieModel["elements"];
  const rel = (kind: string, sourceId: string, targetId: string) => ({ id: `rel_${sourceId}_${targetId}`, kind, sourceId, targetId });
  m.relations = [rel("actorActivity", "actor_1", "act_1"), rel("actorActivity", "actor_2", "act_1"), rel("actorActivity", "ext_1", "act_1"), rel("activityUsecase", "act_1", "uc_1"), rel("usecaseScreen", "uc_1", "scr_1")] as UntieModel["relations"];
  m = okModel(addDesignScreens(m, { systemId: "sys_a", screens: [{ id: "d1", source: { kind: "screen", screenId: "scr_1" } }, { id: "d_top", source: { kind: "builtin", builtin: "top" } }], transitions: [] }));
  m = okModel(addDatabase(m, { id: "db_x", name: "予約DB" }));
  return okModel(setDatabaseDsl(m, { id: "db_x", dsl: DSL }));
}
const screenOf = (m: UntieModel, id = "d1") => m.designs[0]!.screens.find((s) => s.id === id)!;
const binding = (item: string, column = "name") => ({ item, databaseId: "db_x", table: "Item", column });

describe("viewBindingSlots", () => {
  it("項目 (fields[].item) と一覧の列 (<セクションの id>.<列の id>) を並び順に返す。重複と壊れた形は読み飛ばす", () => {
    expect(viewBindingSlots(VIEW).map((s) => [s.key, s.kind, s.label])).toEqual([
      ["keyword", "field", "キーワード"],
      ["res.name", "column", "名前"],
      ["res.price", "column", "価格"],
    ]);
    expect(columnBindingKey("res", "name")).toBe("res.name");
    expect(viewBindingSlots(undefined)).toEqual([]);
    expect(viewBindingSlots({ sections: [null, { id: "a", fields: [{ item: "x" }, { item: "x" }, 1, { label: "item なし" }] }] }).map((s) => s.key)).toEqual(["x"]);
  });
});

describe("viewBindingSlots: 種類で数える", () => {
  it("list のセクションは列だけ、ほかは項目だけを数える (切り替えたあとの古い中身は数えない)", () => {
    const view = {
      sections: [
        { id: "a", kind: "list", fields: [{ item: "old", label: "古い" }], list: { columns: [{ id: "c", label: "C" }] } },
        { id: "b", kind: "form", fields: [{ item: "new", label: "新" }], list: { columns: [{ id: "d", label: "D" }] } },
        { id: "c", kind: "summary", fields: [{ item: "calc", label: "計算" }] },
      ],
    };
    expect(viewBindingSlots(view).map((x) => [x.key, x.sectionKind])).toEqual([["a.c", "list"], ["new", "form"], ["calc", "summary"]]);
  });
});

describe("viewShapeProblem / 画面 UI の形の上限", () => {
  it("深さ・節の数・使えないキーを断る。普通の view は通る", () => {
    expect(viewShapeProblem(VIEW)).toBeNull();
    let deep: unknown = "x";
    for (let i = 0; i < VIEW_MAX_DEPTH + 1; i++) deep = { a: deep };
    expect(viewShapeProblem(deep)).toMatch(/深すぎ/);
    const shared = Array.from({ length: 1000 }, () => 1);
    const wide = { a: shared, b: shared, c: Array.from({ length: 60 }, () => shared) };
    expect(viewShapeProblem(wide)).toMatch(/大きすぎ/);
    expect(viewShapeProblem(Array.from({ length: VIEW_MAX_NODES }, () => 0))).toMatch(/大きすぎ/);
    expect(viewShapeProblem(JSON.parse('{"a":{"__proto__":{"x":1}}}'))).toMatch(/使えないキー/);
    expect(viewShapeProblem({ constructor: 1 })).toMatch(/使えないキー/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(viewShapeProblem(cyclic)).toMatch(/深すぎ/);
  });

  it("コマンドは深すぎる・大きすぎる・危ないキーの view を断る", () => {
    const m = base();
    let deep: unknown = "x";
    for (let i = 0; i < VIEW_MAX_DEPTH + 1; i++) deep = { a: deep };
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: { deep } }), /深すぎ/);
    const shared = Array.from({ length: 1000 }, () => 1);
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: { rows: Array.from({ length: 60 }, () => shared) } }), /大きすぎ/);
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: JSON.parse('{"__proto__":{"x":1}}') }), /使えないキー/);
  });

  it("repairModel は、大きすぎる・深すぎる・危ない view を持つ画面から view と bindings だけを捨てる (画面は残す)", () => {
    let m = okModel(setDesignScreenView(base(), { systemId: "sys_a", id: "d1", view: VIEW, bindings: [binding("keyword")] }));
    m = okModel(setDesignScreenView(m, { systemId: "sys_a", id: "d_top", view: VIEW, bindings: [binding("keyword")] }));
    const broken = JSON.parse(JSON.stringify(m)) as UntieModel;
    const [d1, top] = broken.designs[0]!.screens;
    d1!.view = { note: "あ".repeat(VIEW_JSON_MAX_LENGTH) };
    let deep: unknown = "x";
    for (let i = 0; i < VIEW_MAX_DEPTH + 1; i++) deep = { a: deep };
    top!.view = { deep } as Record<string, unknown>;
    const r = repairModel(broken);
    const screens = r.model.designs[0]!.screens;
    expect(screens.map((s) => s.id)).toEqual(["d1", "d_top"]);
    for (const s of screens) {
      expect(s.view).toBeUndefined();
      expect(s.bindings).toBeUndefined();
    }
    expect(r.changes.filter((c) => c.includes("画面 UI")).length).toBe(2);
    const ok = repairModel(m);
    expect(ok.model.designs[0]!.screens[0]!.view).toEqual(VIEW);
    const proto = JSON.parse(JSON.stringify(m)) as UntieModel;
    proto.designs[0]!.screens[0]!.view = JSON.parse('{"title":"t","x":{"__proto__":{"y":1}}}');
    expect(repairModel(proto).model.designs[0]!.screens[0]!.view).toBeUndefined();
  });
});

describe("setDesignScreenView", () => {
  it("view と bindings を置く (JSON の写しを持つ)。bindings を省くと今のまま、空にすると消える", () => {
    let m = okModel(setDesignScreenView(base(), { systemId: "sys_a", id: "d1", view: VIEW, bindings: [binding("keyword")] }));
    expect(screenOf(m).view).toEqual(VIEW);
    expect(screenOf(m).view).not.toBe(VIEW);
    expect(screenOf(m).bindings).toEqual([binding("keyword")]);
    m = okModel(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: { ...VIEW, goal: "別" } }));
    expect(screenOf(m).bindings).toEqual([binding("keyword")]);
    m = okModel(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: VIEW, bindings: [] }));
    expect(screenOf(m).bindings).toBeUndefined();
    const v = validateModel(JSON.parse(JSON.stringify(m)));
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it("設計・画面が無い、view がオブジェクトでない、大きすぎるときは失敗", () => {
    const m = base();
    expectFail(setDesignScreenView(m, { systemId: "sys_none", id: "d1", view: VIEW }), /設計が存在しません/);
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "nope", view: VIEW }), /設計に無い画面/);
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: [] as never }), /オブジェクト/);
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: null as never }), /オブジェクト/);
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: { note: "あ".repeat(VIEW_JSON_MAX_LENGTH) } }), /画面 UI.*までです/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: circular }), /深すぎ/);
    expect(screenOf(m).view).toBeUndefined();
  });

  it("bindings の item の重複・存在しないデータベース・空のテーブルや列は失敗", () => {
    const m = base();
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: VIEW, bindings: [binding("a"), binding("a", "price")] }), /重なって/);
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: VIEW, bindings: [{ ...binding("a"), databaseId: "db_none" }] }), /データベースが存在しません/);
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: VIEW, bindings: [{ ...binding("a"), table: "" }] }), /空/);
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: VIEW, bindings: [binding("")] }), /空/);
    expectFail(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: VIEW, bindings: [binding("あ".repeat(201))] }), /名前/);
  });
});

describe("clearDesignScreenView / setDesignScreenBindings", () => {
  it("画面 UI を消すと、対応も消える", () => {
    let m = okModel(setDesignScreenView(base(), { systemId: "sys_a", id: "d1", view: VIEW, bindings: [binding("keyword")] }));
    m = okModel(clearDesignScreenView(m, { systemId: "sys_a", id: "d1" }));
    expect(screenOf(m).view).toBeUndefined();
    expect(screenOf(m).bindings).toBeUndefined();
    expectFail(clearDesignScreenView(m, { systemId: "sys_a", id: "nope" }), /設計に無い画面/);
  });

  it("対応だけを置き換える。空で消える。検証は同じ", () => {
    let m = okModel(setDesignScreenBindings(base(), { systemId: "sys_a", id: "d1", bindings: [binding("x")] }));
    expect(screenOf(m).bindings).toEqual([binding("x")]);
    m = okModel(setDesignScreenBindings(m, { systemId: "sys_a", id: "d1", bindings: [] }));
    expect(screenOf(m).bindings).toBeUndefined();
    expectFail(setDesignScreenBindings(m, { systemId: "sys_a", id: "d1", bindings: [binding("a"), binding("a")] }), /重なって/);
    expectFail(setDesignScreenBindings(m, { systemId: "sys_none", id: "d1", bindings: [] }), /設計が存在しません/);
  });

  it("データベースを消すと、そのデータベースを指す対応も消える (既存)", () => {
    let m = okModel(setDesignScreenView(base(), { systemId: "sys_a", id: "d1", view: VIEW, bindings: [binding("keyword")] }));
    m = okModel(removeDatabase(m, { id: "db_x" }));
    expect(screenOf(m).bindings).toBeUndefined();
  });
});

describe("checkDesign: 列の対応が無い項目 / 画面 UI がまだ無い画面", () => {
  const warn = (m: UntieModel, type: string) => checkDesign(m, "sys_a").warnings.filter((w) => w.type === type);

  it("画面 UI の項目と列のうち対応が無いものを、画面ごとに 1 行で数える。readonly / summary の項目も数える", () => {
    let m = okModel(setDesignScreenView(base(), { systemId: "sys_a", id: "d1", view: VIEW, bindings: [binding("keyword")] }));
    const w = warn(m, "bindingUnmapped");
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("画面「予約検索」");
    expect(w[0]!.message).toContain("2 件");
    expect(w[0]!.message).toContain("名前、価格");
    expect(w[0]!.target).toEqual({ kind: "screen", id: "d1" });
    // 全部結べば出ない
    m = okModel(setDesignScreenBindings(m, { systemId: "sys_a", id: "d1", bindings: [binding("keyword"), binding("res.name"), binding("res.price", "price")] }));
    expect(warn(m, "bindingUnmapped")).toHaveLength(0);
  });

  it("readonly / summary の項目は数えない (計算した値は結ばなくてよい)。form の項目と list の列は数える", () => {
    const m = okModel(
      setDesignScreenView(base(), {
        systemId: "sys_a",
        id: "d1",
        view: { title: "t", goal: "g", sections: [{ id: "s", title: "要約", kind: "summary", fields: [{ item: "total", label: "合計", component: "text" }] }, { id: "r", title: "表示", kind: "readonly", fields: [{ item: "x", label: "X", component: "text" }] }] },
      }),
    );
    expect(warn(m, "bindingUnmapped")).toHaveLength(0);
  });

  it("画面 UI の無い画面は (g) で数え、(i) では数えない。画面 UI を足すと (g) の件数が減る", () => {
    const m = base();
    expect(warn(m, "screenWithoutView")[0]!.message).toContain("2 件");
    expect(warn(m, "bindingUnmapped")).toHaveLength(0);
    const m2 = okModel(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: VIEW, bindings: [] }));
    expect(warn(m2, "screenWithoutView")[0]!.message).toContain("1 件");
  });

  it("存在しない列を指す対応はエラー (d) のまま", () => {
    const m = okModel(setDesignScreenView(base(), { systemId: "sys_a", id: "d1", view: VIEW, bindings: [binding("keyword", "nope")] }));
    expect(checkDesign(m, "sys_a").problems.map((p) => p.type)).toContain("bindingInvalid");
  });
});

describe("店舗サンプルの画面 UI", () => {
  const design = retailSample.designs.find((d) => d.systemId === "sys_pos")!;
  const withView = design.screens.filter((s) => s.view !== undefined);

  it("POSレジの 3 画面 (商品・在庫の検索、レジ打ち、トップページ) に view と bindings がある", () => {
    expect(withView.map((s) => s.id).sort()).toEqual(["ds_pos_sale", "ds_pos_search", "ds_pos_top"]);
    for (const s of withView) {
      // 入力の項目と一覧の列はすべて対応が付いている (要約の値は計算した値なので結ばない)
      const bound = new Set((s.bindings ?? []).map((b) => b.item));
      expect(viewBindingSlots(s.view).filter((x) => !bound.has(x.key) && (x.kind === "column" || x.sectionKind === "form"))).toEqual([]);
    }
  });

  it("検証: 画面 UI の無い画面の警告の件数が減り、対応のエラー・対応の無い項目の警告は出ない", () => {
    const r = checkDesign(retailSample, "sys_pos");
    expect(r.problems.filter((p) => p.type === "bindingInvalid")).toEqual([]);
    expect(r.warnings.filter((w) => w.type === "bindingUnmapped")).toEqual([]);
    const without = design.screens.filter((s) => s.view === undefined).length;
    expect(r.warnings.find((w) => w.type === "screenWithoutView")!.message).toContain(`${without} 件`);
    expect(without).toBe(design.screens.length - 3);
  });

  it("検索の一覧の行 (最初の列) は、値引き・廃棄の入力へ遷移する", () => {
    const search = design.screens.find((s) => s.id === "ds_pos_search")!;
    const columns = ((search.view as { sections: { list?: { columns: { to?: string }[] } }[] }).sections.find((x) => x.list)!.list!.columns);
    expect(columns[0]!.to).toBe("ds_pos_disposal");
    expect(design.screens.some((s) => s.id === "ds_pos_disposal")).toBe(true);
  });
});
