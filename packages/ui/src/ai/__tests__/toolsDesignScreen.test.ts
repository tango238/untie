import { describe, expect, it } from "vitest";
import { createRetailSample } from "@untie/core/sample";
import type { CommandResult } from "@untie/core/model/commands";
import type { UntieModel } from "@untie/core/model/types";
import { executeTool, executeToolAsync, MODEL_TOOLS, type ModelEditor } from "../tools";

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
const parse = (s: string) => JSON.parse(s) as Record<string, any>;
const screenOf = (m: UntieModel, id: string) => m.designs[0]!.screens.find((s) => s.id === id)!;

describe("AI の道具: 設計の画面", () => {
  it("3 つの道具が MODEL_TOOLS にあり、非同期版で扱える", async () => {
    const names = MODEL_TOOLS.map((t) => t.name);
    for (const n of ["list_design_screens", "get_design_screen", "set_design_screen_view"]) expect(names).toContain(n);
    const e = editorOf(createRetailSample());
    for (const t of MODEL_TOOLS) expect(String(parse((await executeToolAsync(e, t.name, {})).content).error ?? "")).not.toMatch(/不明な道具/);
    expect((await executeToolAsync(e, "nope", {})).ok).toBe(false);
  });

  it("list_design_screens: 画面ごとに、画面 UI の有無・対応の数・対応が無い項目の数", () => {
    const e = editorOf(createRetailSample());
    const list = parse(executeTool(e, "list_design_screens", {}).content) as unknown as Record<string, any>[];
    const search = list.find((x) => x.id === "ds_pos_search")!;
    expect(search).toMatchObject({ name: "商品・在庫の検索", system: "POSレジ", hasView: true, bindings: 6, unmappedItems: 0 });
    const price = list.find((x) => x.id === "ds_pos_price")!;
    expect(price.hasView).toBe(false);
    expect(price.unmappedItems).toBeUndefined();
  });

  it("get_design_screen: view・bindings・使う情報・遷移・使うデータベースのテーブルと列を返す", () => {
    const e = editorOf(createRetailSample());
    const got = parse(executeTool(e, "get_design_screen", { screen_id: "ds_pos_search" }).content);
    expect(got.hasView).toBe(true);
    expect(got.view.sections).toHaveLength(2);
    expect(got.bindings[0]).toEqual({ item: "keyword", database_id: "db_default", table: "Item", column: "name" });
    expect(got.transitions.some((t: { to: string; toName: string }) => t.to === "ds_pos_disposal" && t.toName === "値引き・廃棄の入力")).toBe(true);
    const item = got.databases[0].tables.find((t: { table: string }) => t.table === "Item");
    expect(item.columns).toContain("price");
    expect(item.informations.length).toBeGreaterThan(0);
    const bare = parse(executeTool(e, "get_design_screen", { screen_id: "ds_pos_price" }).content);
    expect(bare.hasView).toBe(false);
    expect(bare.view).toBeUndefined();
    expect(executeTool(e, "get_design_screen", { screen_id: "nope" }).ok).toBe(false);
    expect(executeTool(e, "get_design_screen", {}).ok).toBe(false);
  });

  it("set_design_screen_view は同期版では実行しない (理由を返す)", () => {
    const e = editorOf(createRetailSample());
    expect(executeTool(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: {} }).ok).toBe(false);
  });

  const VIEW = {
    title: "売価の変更",
    goal: "売価を直す",
    sections: [{ id: "f", title: "入力", kind: "form", fields: [{ item: "newPrice", label: "新しい売価", component: "number" }] }],
    secondaryActions: [{ id: "back", label: "検索へ", kind: "navigate", to: "ds_pos_search" }],
  };

  it("set_design_screen_view: mokkun の検証に通れば view と bindings を置き、対応が無い項目を返す", async () => {
    const e = editorOf(createRetailSample());
    const before = e.model;
    const r = await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: VIEW });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(parse(r.content).unmappedItems).toEqual(["newPrice"]);
    expect(screenOf(e.model, "ds_pos_price").view).toEqual(VIEW);
    expect(e.model).not.toBe(before);
    // bindings を渡すと置き換わる。省くと今のまま
    const r2 = await executeToolAsync(e, "set_design_screen_view", {
      screen_id: "ds_pos_price",
      view: VIEW,
      bindings: [{ item: "newPrice", database_id: "db_default", table: "Item", column: "price" }],
    });
    expect(parse(r2.content).unmappedItems).toEqual([]);
    expect(screenOf(e.model, "ds_pos_price").bindings).toEqual([{ item: "newPrice", databaseId: "db_default", table: "Item", column: "price" }]);
    await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: { ...VIEW, goal: "別" } });
    expect(screenOf(e.model, "ds_pos_price").bindings).toHaveLength(1);
  });

  it("set_design_screen_view: mokkun の検証に通らなければ失敗にして理由を返し、モデルは変えない。JSON 文字列の view も読む", async () => {
    const e = editorOf(createRetailSample());
    const before = e.model;
    const bad = await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: { title: "x", goal: "g", sections: [{ id: "a", title: "A", kind: "bogus" }] } });
    expect(bad.ok).toBe(false);
    expect(parse(bad.content).error).toContain("mokkun の検証に通りません");
    expect(parse(bad.content).error).toContain("sections[0].kind");
    const unknownTarget = await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: { ...VIEW, secondaryActions: [{ id: "x", label: "x", kind: "navigate", to: "ghost" }] } });
    expect(unknownTarget.ok).toBe(false);
    expect(e.model).toBe(before);
    expect((await executeToolAsync(e, "set_design_screen_view", { screen_id: "nope", view: VIEW })).ok).toBe(false);
    expect((await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price" })).ok).toBe(false);
    expect((await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: "{" })).ok).toBe(false);
    expect((await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: VIEW, bindings: [{ item: "x" }] })).ok).toBe(false);
    expect((await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: VIEW, bindings: [{ item: "newPrice", database_id: "db_none", table: "T", column: "c" }] })).ok).toBe(false);
    const fromString = await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: JSON.stringify(VIEW) });
    expect(fromString.ok).toBe(true);
  });

  it("set_design_screen_view: view に無い項目の対応は外して droppedBindings に数える。title / goal は補って検証する。get_design_screen の columns は関連の列を除く", async () => {
    const e = editorOf(createRetailSample());
    const noTitle = { sections: VIEW.sections };
    const r = await executeToolAsync(e, "set_design_screen_view", {
      screen_id: "ds_pos_price",
      view: noTitle,
      bindings: [
        { item: "newPrice", database_id: "db_default", table: "Item", column: "price" },
        { item: "ghost", database_id: "db_default", table: "Item", column: "price" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(parse(r.content).droppedBindings).toBe(1);
    expect(screenOf(e.model, "ds_pos_price").bindings!.map((b) => b.item)).toEqual(["newPrice"]);
    // 省いたときも、view に無くなった項目の対応を今の対応から外す
    const r2 = await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: { ...noTitle, sections: [{ id: "g", title: "別", kind: "readonly", note: "n" }] } });
    expect(parse(r2.content).droppedBindings).toBe(1);
    expect(screenOf(e.model, "ds_pos_price").bindings).toBeUndefined();
    const got = parse(executeTool(e, "get_design_screen", { screen_id: "ds_pos_search" }).content);
    const item = got.databases[0].tables.find((t: { table: string }) => t.table === "Item");
    expect(item.columns).toContain("categoryId");
    expect(item.columns).not.toContain("category");
    expect(item.columns).not.toContain("stock");
  });

  it("set_design_screen_view: 深すぎる view と危ないキーは断る", async () => {
    const e = editorOf(createRetailSample());
    let deep: unknown = "x";
    for (let i = 0; i < 70; i++) deep = { a: deep };
    expect((await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: { deep } })).ok).toBe(false);
    expect((await executeToolAsync(e, "set_design_screen_view", { screen_id: "ds_pos_price", view: '{"__proto__":{"a":1}}' })).ok).toBe(false);
  });
});
