// 依頼に入れるテーブルの絞り込みと get_table、テーブルと情報の対応付け (機械的な候補・対象のデータベース・すきま)。
import { describe, expect, it } from "vitest";
import { addElement, setDesignDatabases } from "@untie/core/model/commands";
import { emptyModel, type UntieModel } from "@untie/core/model/types";
import { applyDataImport } from "../reverseData";
import { applyMappingSuggestions, mappingGap, suggestMappings, systemDatabaseIds, unmappedInSystem } from "../reverseLogic";
import { describeTablesForRequest, executeGetTable, linesMentioning, selectTablesForRequest, TABLE_REQUEST_LIMITS } from "../reverseTables";

/** n 個のテーブルを持つ DSL (列は cols 個。Order は OrderItem と関連) */
function bigDsl(n: number, cols = 16): string {
  const col = (i: number) => `  col${i} String`;
  const tables = Array.from({ length: n }, (_, t) => {
    const extra = t === 0 ? "\n  items OrderItem[]" : t === 1 ? "\n  orderId String\n  order Order @relation(fields: [orderId], references: [id])" : "";
    const name = t === 0 ? "Order" : t === 1 ? "OrderItem" : `Table${t}`;
    return `model ${name} {\n  id String @id\n${Array.from({ length: cols }, (_, i) => col(i)).join("\n")}${extra}\n}`;
  });
  return `${tables.join("\n\n")}\n`;
}
const withDb = (dsl: string, name = "DB"): UntieModel => applyDataImport(emptyModel("m"), { name, dsl }).model;

describe("画面 UI の依頼に入れるテーブルの絞り込み", () => {
  it("200 テーブル × 16 列でも、画面に関わるテーブル (名前が手がかりに出るもの) と関連先を列つきで、残りは名前だけにする。依頼は短くなる", () => {
    const model = withDb(bigDsl(200));
    const ids = model.databases.map((d) => d.id);
    // 絞らずに全部を入れたときの依頼の大きさ (列が全部入る。実物の 200 テーブルでは、約 30 万文字)
    const full = JSON.stringify(selectTablesForRequest(model, ids, "", { fullTables: 1000, fullChars: 10_000_000, nameOnly: 1000 }), null, 2);
    expect(full.length).toBeGreaterThan(250_000);
    const views = selectTablesForRequest(model, ids, "注文一覧画面 (src/pages/Order.tsx)。Table150 も表示する");
    const shown = views[0]!.tables.map((t) => t.table);
    expect(shown).toContain("Order");
    expect(shown).toContain("Table150");
    // Order の関連先 (OrderItem) も入る
    expect(shown).toContain("OrderItem");
    expect(shown.length).toBeLessThanOrEqual(TABLE_REQUEST_LIMITS.fullTables);
    expect(views[0]!.tables.find((t) => t.table === "Order")!.columns.length).toBe(17);
    expect(views[0]!.otherTables!.length + shown.length).toBe(200);
    expect(views[0]!.otherTables).not.toContain("Order");
    const text = describeTablesForRequest(model, ids, "Order").text;
    expect(text.length).toBeLessThan(60_000);
    expect(text.length * 5).toBeLessThan(full.length);
    expect(describeTablesForRequest(model, ids, "Order").narrowed).toBe(true);
  });

  it("テーブルが少なければ、すべて列つきで入れ、名前だけの一覧は出ない (絞らない)", () => {
    const model = withDb(bigDsl(10));
    const r = describeTablesForRequest(model, model.databases.map((d) => d.id), "");
    expect(r.narrowed).toBe(false);
    expect(JSON.parse(r.text)[0].tables).toHaveLength(10);
  });

  it("手がかりは、もとの名前 (@@map)・テーブルが表す情報の名前でも当たり、短すぎる名前は偶然の一致を避けて数えない", () => {
    const dsl = `model Tbl {\n  id String @id\n  @@map("t_orders")\n}\n\nmodel X {\n  id String @id\n}\n\n${bigDsl(60, 2).replace(/model Order \{/, "model Ord {").replace(/items OrderItem\[\]/, "").replace(/model OrderItem \{/, "model Oi {").replace(/orderId String\n {2}order Order @relation\(fields: \[orderId\], references: \[id\]\)/, "")}`;
    let model = withDb(dsl);
    const info = addElement(model, { kind: "information", name: "受注" });
    expect(info.ok).toBe(true);
    model = (info as { model: UntieModel }).model;
    const id = model.elements.find((e) => e.name === "受注")!.id;
    model = { ...model, databases: [{ ...model.databases[0]!, tables: [{ table: "Tbl", informationIds: [id] }] }] };
    const dbIds = model.databases.map((d) => d.id);
    expect(selectTablesForRequest(model, dbIds, "受注の画面", { fullTables: 1, fullChars: 100000, nameOnly: 50 })[0]!.tables.map((t) => t.table)).toEqual(["Tbl"]);
    expect(selectTablesForRequest(model, dbIds, "t_orders を読む", { fullTables: 1, fullChars: 100000, nameOnly: 50 })[0]!.tables.map((t) => t.table)).toEqual(["Tbl"]);
    // 「X」は 1 文字 (英字 3 文字未満) なので、手がかりに出ていても当てない
    expect(selectTablesForRequest(model, dbIds, "x x x", { fullTables: 1, fullChars: 100000, nameOnly: 50 })[0]!.tables.map((t) => t.table)).not.toContain("X");
  });

  it("文字数の上限でも切る。名前だけの一覧にも上限があり、超えた分は件数を note に出す", () => {
    const model = withDb(bigDsl(120, 40));
    const v = selectTablesForRequest(model, model.databases.map((d) => d.id), "", { fullTables: 100, fullChars: 6000, nameOnly: 20 })[0]!;
    expect(JSON.stringify(v.tables).length).toBeLessThan(12_000);
    expect(v.otherTables).toHaveLength(20);
    expect(v.note).toMatch(/120/);
  });

  it("linesMentioning: 調査結果から、その画面の名前を含む行だけを取る (綴りの違いも同じ)", () => {
    expect(linesMentioning("## 画面\n- 注文 一覧: orders テーブル\n- 在庫: stock", "注文一覧")).toBe("- 注文 一覧: orders テーブル");
    expect(linesMentioning("a\nb", "")).toBe("");
  });
});

describe("get_table", () => {
  const model = withDb(`model Order {\n  id String @id\n  customer String?\n  items OrderItem[]\n  @@map("orders")\n}\n\nmodel OrderItem {\n  id String @id\n  orderId String\n  order Order @relation(fields: [orderId], references: [id])\n}\n`);
  const ids = model.databases.map((d) => d.id);
  it("テーブルの名前 (もとの名前・綴りの違いも) で、列と型・関連を返す。ほかのテーブルは返さない", () => {
    for (const name of ["Order", "orders", "ＯＲＤＥＲ"]) {
      const r = executeGetTable(model, ids, { table: name });
      expect(r.ok, name).toBe(true);
      const body = JSON.parse(r.content);
      expect(body.table).toBe("Order");
      expect(body.columns).toEqual([{ name: "id", type: "String" }, { name: "customer", type: "String?" }]);
      expect(body.relations).toEqual([{ field: "items", table: "OrderItem", list: true }]);
    }
  });
  it("見つからない・名前が無い・範囲外のデータベースは、エラーにする", () => {
    expect(executeGetTable(model, ids, { table: "Nothing" }).ok).toBe(false);
    expect(executeGetTable(model, ids, {}).ok).toBe(false);
    expect(executeGetTable(model, [], { table: "Order" }).ok).toBe(false);
    expect(executeGetTable(model, ids, { table: "Order", database: "別のデータベース" }).ok).toBe(false);
  });
});

describe("テーブルと情報の対応: 機械的な候補・対象のデータベース・すきま", () => {
  /** 情報「注文」「商品」と、テーブル Order (@@map("注文"))・Product・Misc を持つモデル。システム「ショップ」は設計を持つ */
  function shop(): { model: UntieModel; system: string; info: Record<string, string> } {
    let m = withDb(`model Order {\n  id String @id\n  @@map("注文")\n}\n\nmodel Product {\n  id String @id\n}\n\nmodel Misc {\n  id String @id\n}\n`, "ショップDB");
    const add = (kind: "information" | "system" | "actor" | "business", name: string, init?: object) => {
      const r = addElement(m, { kind, name, ...(init ? { init } : {}) } as never);
      if (!r.ok) throw new Error(r.reason);
      m = r.model;
      return r.id;
    };
    const info = { 注文: add("information", "注文"), 商品: add("information", "商品"), 返品: add("information", "返品") };
    const system = add("system", "ショップ");
    const actor = add("actor", "担当");
    const biz = add("business", "受注");
    void actor;
    void biz;
    return { model: m, system, info };
  }

  it("テーブルの名前・もとの名前 (@@map)・テーブルの説明 (///) が情報の名前と一致するものを、AI を使わずに結ぶ候補にする (大文字小文字・全角半角・空白の違いも一致)", () => {
    const { model, info } = shop();
    const found = suggestMappings(model);
    expect(found.map((s) => [s.table, s.informationName, s.via]).sort()).toEqual([
      ["Order", "注文", "もとの名前"],
    ]);
    const withDoc = { ...model, databases: [{ ...model.databases[0]!, dsl: model.databases[0]!.dsl.replace("model Product {", "/// 商　品\nmodel Product {") }] };
    expect(suggestMappings(withDoc).map((s) => [s.table, s.informationName, s.via]).sort()).toEqual([["Order", "注文", "もとの名前"], ["Product", "商品", "テーブルの説明"]]);
    const applied = applyMappingSuggestions(withDoc, suggestMappings(withDoc));
    expect(applied.applied).toBe(2);
    expect(applied.model.databases[0]!.tables.find((t) => t.table === "Product")!.informationIds).toEqual([info.商品]);
    // もう一度は、すでに結んだものを数えない・すでに対応のあるテーブルは候補にしない
    expect(suggestMappings(applied.model)).toEqual([]);
    expect(applyMappingSuggestions(applied.model, suggestMappings(withDoc)).applied).toBe(0);
  });

  it("対象のデータベースは、設計が実際に使うもの。設計が無い・使うデータベースにテーブルが無いシステムは、テーブルのあるデータベースすべて", () => {
    let { model, system } = shop();
    // 2 つ目のデータベース
    const second = applyDataImport(model, { name: "別のDB", dsl: "model Other {\n  id String @id\n}\n" });
    model = second.model;
    const [a, b] = model.databases.map((d) => d.id) as [string, string];
    expect(systemDatabaseIds(model, system)).toEqual([a, b]);
    const withDesign = { ...model, designs: [{ systemId: system, screens: [], transitions: [], layout: { navigation: [] }, databaseIds: [b] }] } as unknown as UntieModel;
    expect(systemDatabaseIds(withDesign, system)).toEqual([b]);
    // 使うデータベースの外のテーブルへの対応は、数えない
    const other = { ...withDesign, databases: withDesign.databases.map((d) => (d.id === a ? { ...d, tables: [{ table: "Order", informationIds: ["x"] }] } : d)) };
    expect(unmappedInSystem(other, system)).toEqual(unmappedInSystem(withDesign, system));
    void setDesignDatabases;
  });

  it("すきま: どのテーブルにも対応していない情報 (システムが使うものと、どの操作も使っていないもの) と、どの情報にも対応していないテーブルの数。情報かテーブルが無ければ 0", () => {
    const { model } = shop();
    // 操作が情報を扱っていないので、システムが使う情報は無いが、どの操作も使っていない情報 (注文・商品・返品) も、対応の対象に数える
    expect(mappingGap(model).informations).toBe(3);
    expect(mappingGap(model).systems).toBe(0);
    expect(mappingGap(model).tables).toBe(3);
    expect(mappingGap(emptyModel("m"))).toEqual({ informations: 0, tables: 0, systems: 0 });
  });
});
