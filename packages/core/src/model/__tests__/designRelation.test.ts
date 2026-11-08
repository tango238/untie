import { describe, expect, it } from "vitest";
import { createRetailSample } from "../../sample";
import { okModel } from "./helpers";
import { addDatabase, setDatabaseDsl, setDesignDatabases, setTableInformation } from "../commands";
import { checkDesign } from "../designCheck";
import { buildRelationGraph, relationInformationIds } from "../designRelation";
import { systemInformationIds, unmappedInformationIds } from "../designData";
import { unboundSlots } from "../designView";

const SYS = "sys_pos";

describe("buildRelationGraph", () => {
  const model = createRetailSample();
  const g = buildRelationGraph(model, SYS);

  it("情報は、システムが使う情報とテーブルに対応した情報の和 (分析の情報の並び順)", () => {
    const ids = g.informations.map((i) => i.id);
    for (const id of systemInformationIds(model, SYS)) expect(ids).toContain(id);
    for (const id of ["info_item", "info_stock", "info_sale", "info_payment", "info_stocktake"]) expect(ids).toContain(id);
    const order = model.elements.filter((e) => ids.includes(e.id)).map((e) => e.id);
    expect(ids).toEqual(order);
  });

  it("テーブルは DSL の全 model。情報の対応と、項目を使う画面を持つ", () => {
    expect(g.databases).toHaveLength(1);
    const names = g.databases[0]!.tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Item", "StockLevel", "Sale", "SaleLine", "Payment", "Stocktake"]));
    const item = g.databases[0]!.tables.find((t) => t.name === "Item")!;
    expect(item.informationIds).toEqual(["info_item"]);
    expect(item.columns.find((c) => c.name === "name")!.usedBy).toEqual(["ds_pos_search"]);
    // 同じ画面が同じ列を複数の項目で使っても 1 本 (Item.name は keyword と results.name の 2 項目)
    const lines = g.edges.filter((e) => e.kind === "columnScreen" && e.table === "Item" && e.column === "name" && e.screenId === "ds_pos_search");
    expect(lines).toHaveLength(1);
    expect(item.columns.find((c) => c.name === "id")!.usedBy).toEqual([]);
  });

  it("線は 情報 → テーブル と 列 → 画面", () => {
    expect(g.edges).toContainEqual({ kind: "informationTable", informationId: "info_item", databaseId: "db_default", table: "Item" });
    expect(g.edges).toContainEqual({ kind: "columnScreen", databaseId: "db_default", table: "Payment", column: "amount", screenId: "ds_pos_sale" });
  });

  it("画面は設計の画面すべて。列の対応が無い項目の数を持つ", () => {
    const design = model.designs.find((d) => d.systemId === SYS)!;
    expect(g.screens.map((s) => s.id)).toEqual(design.screens.map((s) => s.id));
    expect(g.screens.find((s) => s.id === "ds_pos_top")!.unbound).toBe(0);
    expect(g.screens.find((s) => s.id === "ds_pos_signin")!.hasView).toBe(false);
  });

  it("存在しない列を指す対応は線にしない", () => {
    const design = model.designs.find((d) => d.systemId === SYS)!;
    const broken = {
      ...model,
      designs: model.designs.map((d) =>
        d === design ? { ...d, screens: d.screens.map((s) => (s.id === "ds_pos_sale" ? { ...s, bindings: [...(s.bindings ?? []), { item: "x", databaseId: "db_default", table: "Payment", column: "nothing" }] } : s)) } : d,
      ),
    };
    const g2 = buildRelationGraph(broken, SYS);
    expect(g2.edges.some((e) => e.kind === "columnScreen" && e.column === "nothing")).toBe(false);
    expect(g2.edges).toHaveLength(g.edges.length);
  });

  it("使わないデータベースを指す対応は線にしない", () => {
    let m = okModel(addDatabase(createRetailSample(), { id: "db_b", name: "分析用" }));
    m = okModel(setDatabaseDsl(m, { id: "db_b", dsl: "model Other {\n  id String @id\n}\n" }));
    m = {
      ...m,
      designs: m.designs.map((d) => ({ ...d, screens: d.screens.map((s) => (s.id === "ds_pos_sale" ? { ...s, bindings: [...(s.bindings ?? []), { item: "x", databaseId: "db_b", table: "Other", column: "id" }] } : s)) })),
    };
    const g2 = buildRelationGraph(m, SYS);
    expect(g2.edges).toHaveLength(g.edges.length);
    expect(g2.databases.map((d) => d.id)).toEqual(["db_default"]);
  });

  it("DSL に無いテーブルにだけ対応づけた情報は、未対応にならず missingTables に出る", () => {
    const m = okModel(setTableInformation(createRetailSample(), { id: "db_default", table: "Ghost", informationIds: ["info_item"] }));
    const m2 = okModel(setTableInformation(m, { id: "db_default", table: "Item", informationIds: [] }));
    const g2 = buildRelationGraph(m2, SYS);
    expect(g2.informations.find((i) => i.id === "info_item")!.unmapped).toBe(false);
    expect(g2.databases[0]!.missingTables).toEqual([{ name: "Ghost", informationIds: ["info_item"] }]);
    expect(g2.edges.some((e) => e.kind === "informationTable" && e.informationId === "info_item")).toBe(false);
  });

  it("relationInformationIds は図の情報と一致する。範囲外の情報は含まない", () => {
    const m = createRetailSample();
    const ids = relationInformationIds(m, SYS);
    expect([...ids].sort()).toEqual(buildRelationGraph(m, SYS).informations.map((i) => i.id).sort());
    expect(ids.has("no_such_info")).toBe(false);
  });

  it("設計が無くても落ちず、情報だけを返す", () => {
    const g3 = buildRelationGraph(createRetailSample(), "sys_accounting");
    expect(g3.noDesign).toBe(true);
    expect(g3.databases).toEqual([]);
    expect(g3.screens).toEqual([]);
    expect(g3.informations.every((i) => !i.unmapped)).toBe(true);
  });
});

describe("問題の判定は checkDesign と同じ", () => {
  it("対応のない情報が informationUnmapped と一致する", () => {
    let m = createRetailSample();
    m = okModel(setTableInformation(m, { id: "db_default", table: "Item", informationIds: [] }));
    const unmapped = unmappedInformationIds(m, SYS);
    expect(unmapped).toContain("info_item");
    const fromCheck = checkDesign(m, SYS).problems.filter((p) => p.type === "informationUnmapped").map((p) => p.target!.id);
    expect(fromCheck.sort()).toEqual([...unmapped].sort());
    expect(buildRelationGraph(m, SYS).informations.find((i) => i.id === "info_item")!.unmapped).toBe(true);
  });

  it("使うデータベースが無いときは対応なしを数えない (noDatabase が知らせる)", () => {
    let m = createRetailSample();
    m = { ...m, databases: [] };
    expect(unmappedInformationIds(m, SYS)).toEqual([]);
  });

  it("列の対応が無い項目の数が bindingUnmapped と一致する", () => {
    const m = createRetailSample();
    const design = m.designs.find((d) => d.systemId === SYS)!;
    const cleared = { ...m, designs: m.designs.map((d) => ({ ...d, screens: d.screens.map((s) => (s.id === "ds_pos_sale" ? { ...s, bindings: [] } : s)) })) };
    const sale = design.screens.find((s) => s.id === "ds_pos_sale")!;
    expect(unboundSlots(sale)).toEqual([]);
    expect(unboundSlots({ ...sale, bindings: [] }).map((s: { key: string }) => s.key)).toEqual(["lines.item", "lines.quantity", "lines.price", "method", "amount"]);
    const warn = checkDesign(cleared, SYS).warnings.find((w) => w.type === "bindingUnmapped" && w.target!.id === "ds_pos_sale");
    expect(warn).toBeDefined();
    expect(buildRelationGraph(cleared, SYS).screens.find((s) => s.id === "ds_pos_sale")!.unbound).toBe(5);
  });

  it("form 以外の項目 (summary) は数えない", () => {
    const m = createRetailSample();
    const top = m.designs.find((d) => d.systemId === SYS)!.screens.find((s) => s.id === "ds_pos_top")!;
    expect(unboundSlots(top)).toEqual([]);
  });
});

describe("複数のデータベース", () => {
  it("使うデータベースごとにテーブルを持つ", () => {
    let m = createRetailSample();
    m = okModel(addDatabase(m, { id: "db_b", name: "分析用" }));
    m = okModel(setDesignDatabases(m, { systemId: SYS, databaseIds: ["db_default", "db_b"] }));
    const g = buildRelationGraph(m, SYS);
    expect(g.databases.map((d) => d.id)).toEqual(["db_default", "db_b"]);
    expect(g.databases[1]!.tables).toEqual([]);
  });
});
