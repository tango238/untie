// 段階 1 (データ): スキーマ定義の候補を探し、SQL・schema.prisma を機械的に DSL へ変換して、データベースに置く。AI は使わない。
import { describe, expect, it, vi } from "vitest";
import { addElement } from "@untie/core/model/commands";
import { emptyModel, type UntieModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import {
  applyDataImport,
  canImportPreview,
  defaultDatabaseName,
  defaultSchemaSelection,
  describeSchemaNotes,
  findSchemaCandidates,
  planDataImport,
  previewSchema,
} from "../reverseData";
import { memorySourceTree } from "../sourceTree";
import { FIXTURE_DSL } from "./fixtures/reverseDraft";

const mocked = vi.hoisted(() => ({ calls: [] as { path: string; text: string }[][], throws: false }));
vi.mock("@untie/core/model/sqlImport", () => ({
  sqlFilesToPrismaDsl: (files: { path: string; text: string }[]) => {
    mocked.calls.push(files);
    if (mocked.throws) throw new Error("未実装");
    const has = files.some((f) => /CREATE TABLE/i.test(f.text));
    return { dsl: has ? FIXTURE_DSL : "", tables: [], enums: [], notes: [{ file: files[0]!.path, line: 3, message: "読み飛ばした文" }, { message: "ファイルの指定なし" }], dslErrors: [] };
  },
}));

const SQL = `CREATE TABLE a (id INT PRIMARY KEY);`;

describe("findSchemaCandidates / defaultSchemaSelection", () => {
  it(".sql と .prisma を探し、CREATE TABLE・model の有無とマイグレーションかどうかを見る。並びはパスの名前順 (数字は数として)", async () => {
    const tree = memorySourceTree("api", {
      "db/schema.sql": SQL,
      "db/migrations/10_add.sql": "ALTER TABLE a ADD COLUMN b INT;",
      "db/migrations/2_init.sql": SQL,
      "prisma/schema.prisma": "model A {\n  id String @id\n}\n",
      "docs/notes.sql": "-- メモだけ",
      "src/index.ts": "export {}",
      ".env": "KEY=1",
    });
    const { candidates } = await findSchemaCandidates(tree);
    expect(candidates.map((c) => c.path)).toEqual(["db/migrations/2_init.sql", "db/migrations/10_add.sql", "db/schema.sql", "docs/notes.sql", "prisma/schema.prisma"]);
    const by = Object.fromEntries(candidates.map((c) => [c.path, c]));
    expect(by["db/schema.sql"]).toMatchObject({ kind: "sql", hasTables: true, migration: false });
    expect(by["db/migrations/2_init.sql"]).toMatchObject({ hasTables: true, migration: true, group: "db/migrations", order: 1 });
    expect(by["db/migrations/10_add.sql"]).toMatchObject({ hasTables: false, migration: true });
    expect(by["docs/notes.sql"]!.hasTables).toBe(false);
    expect(by["prisma/schema.prisma"]).toMatchObject({ kind: "prisma", hasTables: true });
    expect(await by["db/schema.sql"]!.read()).toBe(SQL);
  });

  it("既定の選び方: schema.prisma > ダンプ (マイグレーションではない SQL) > マイグレーションの組。CREATE TABLE の無い単独のファイルは選ばない", () => {
    const c = (id: string, kind: "sql" | "prisma", hasTables: boolean, group?: string, down = false) => ({ id, kind, hasTables, migration: group !== undefined, group, down });
    expect([...defaultSchemaSelection([c("p", "prisma", true), c("d", "sql", true), c("m", "sql", true, "mig")])]).toEqual(["p"]);
    expect([...defaultSchemaSelection([c("d", "sql", true), c("m", "sql", true, "mig"), c("n", "sql", false)])]).toEqual(["d"]);
    // マイグレーションの組は、CREATE TABLE を含むかに関係なく、進む向きを全部選ぶ (取り消し用は選ばない)
    expect([...defaultSchemaSelection([c("m1", "sql", true, "mig"), c("m2", "sql", true, "mig"), c("m3", "sql", false, "mig"), c("m4", "sql", true, "mig", true)])]).toEqual(["m1", "m2", "m3"]);
    expect(defaultSchemaSelection([c("n", "sql", false)]).size).toBe(0);
    expect(defaultSchemaSelection([c("a", "sql", false, "mig")]).size).toBe(0);
    expect(defaultSchemaSelection([]).size).toBe(0);
  });

  it("SQL が多すぎるときは先頭だけ調べ、残りを知らせる", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1005; i++) files[`m/${String(i).padStart(4, "0")}.sql`] = SQL;
    const { candidates, notes, skipped } = await findSchemaCandidates(memorySourceTree("many", files));
    expect(candidates).toHaveLength(1000);
    expect(skipped.overLimit).toBe(5);
    expect(notes[0]).toMatch(/1005 件/);
  });
});

describe("previewSchema", () => {
  it("SQL を sqlFilesToPrismaDsl に、渡した順で渡し、テーブルの数と列の数を DSL から数える。気づいたことはどのファイルかを持つ", () => {
    mocked.calls.length = 0;
    const p = previewSchema([
      { path: "a.sql", kind: "sql", text: SQL },
      { path: "b.sql", kind: "sql", text: "-- 2" },
    ]);
    expect(mocked.calls[0]!.map((f) => f.path)).toEqual(["a.sql", "b.sql"]);
    expect(p.tables.map((t) => [t.name, t.columns])).toEqual([["Order", 4], ["OrderItem", 4], ["Product", 3]]);
    expect(p.dslErrors).toEqual([]);
    expect(canImportPreview(p)).toBe(true);
    expect(describeSchemaNotes(p.notes)).toEqual(["a.sql:3: 読み飛ばした文", "ファイルの指定なし"]);
  });

  it("schema.prisma は DSL そのものとして使う (datasource・generator は読み飛ばされる)。AI も SQL の変換も呼ばない", () => {
    mocked.calls.length = 0;
    const text = `generator client {\n  provider = "prisma-client-js"\n}\ndatasource db {\n  provider = "postgresql"\n  url = env("X")\n}\n${FIXTURE_DSL}`;
    const p = previewSchema([{ path: "schema.prisma", kind: "prisma", text }]);
    expect(mocked.calls).toHaveLength(0);
    expect(p.tables.map((t) => t.name)).toEqual(["Order", "OrderItem", "Product"]);
    expect(canImportPreview(p)).toBe(true);
  });

  it("DSL に解析エラーがあれば、取り込めない。テーブルが無くても取り込めない。変換が例外なら理由を持つ", () => {
    const bad = previewSchema([{ path: "x.prisma", kind: "prisma", text: "model {" }]);
    expect(bad.dslErrors.length).toBeGreaterThan(0);
    expect(canImportPreview(bad)).toBe(false);
    expect(canImportPreview(previewSchema([{ path: "x.sql", kind: "sql", text: "SELECT 1;" }]))).toBe(false);
    mocked.throws = true;
    const failed = previewSchema([{ path: "x.sql", kind: "sql", text: SQL }]);
    mocked.throws = false;
    expect(failed.failure).toMatch(/変換できませんでした/);
    expect(canImportPreview(failed)).toBe(false);
  });
});

describe("applyDataImport", () => {
  const dsl = FIXTURE_DSL;
  const withSystem = (m: UntieModel) => {
    const r = addElement(m, { kind: "system", name: "S" });
    if (!r.ok) throw new Error(r.reason);
    return r.model;
  };

  it("システム・情報が無いモデルにも、データベースを足せる。テーブルの対応は付けない", () => {
    const r = applyDataImport(emptyModel("m"), { name: "バックエンドのデータベース", dsl });
    expect(r.failure).toBeUndefined();
    expect(r.replaced).toBe(false);
    expect(r.model.databases).toHaveLength(1);
    expect(r.model.databases[0]!.tables).toEqual([]);
    expect(r.model.designs).toEqual([]);
    expect(validateModel(JSON.parse(JSON.stringify(r.model))).ok).toBe(true);
  });

  it("空の既定のデータベースだけがあるときは、それに名前を付けて使う。ほかのデータベースがあれば足す", () => {
    const base = withSystem(emptyModel("m"));
    const withDefault = { ...base, databases: [{ id: "db_default", name: "データベース", dsl: "", tables: [] }] };
    const r = applyDataImport(withDefault, { name: "A", dsl });
    expect(r.model.databases.map((d) => [d.id, d.name])).toEqual([["db_default", "A"]]);
    const r2 = applyDataImport(r.model, { name: "B", dsl });
    expect(r2.model.databases.map((d) => d.name)).toEqual(["A", "B"]);
  });

  it("同じ名前のデータベースは、id を変えずに置き換える。plan は、外れる対応の件数を先に知らせる (モデルは変えない)", () => {
    const first = applyDataImport(emptyModel("m"), { name: "DB", dsl }).model;
    const id = first.databases[0]!.id;
    const smaller = dsl.replace(/\/\/ 商品\nmodel Product \{[\s\S]*?\n\}\n/, "").replace(/  productId String\n  product   Product @relation\(fields: \[productId\], references: \[id\]\)\n/, "");
    const plan = planDataImport(first, { name: "DB", dsl: smaller });
    expect(plan.replaces).toBe(true);
    expect(first.databases).toHaveLength(1);
    const r = applyDataImport(first, { name: "DB", dsl: smaller });
    expect(r.replaced).toBe(true);
    expect(r.model.databases).toHaveLength(1);
    expect(r.model.databases[0]!.id).toBe(id);
    expect(planDataImport(first, { name: "別の名前", dsl }).replaces).toBe(false);
  });

  it("名前が空・DSL にエラー・テーブルが無いときは置かず、理由を返す", () => {
    const base = emptyModel("m");
    expect(applyDataImport(base, { name: " ", dsl }).failure).toMatch(/名前/);
    expect(applyDataImport(base, { name: "A", dsl: "model {" }).failure).toMatch(/解析エラー/);
    expect(applyDataImport(base, { name: "A", dsl: "" }).failure).toMatch(/テーブルが 1 つも無い/);
    expect(applyDataImport(base, { name: "A", dsl: "model {" }).model).toBe(base);
  });
});

describe("defaultDatabaseName", () => {
  it("ソースのラベル、無ければフォルダ名から「〇〇のデータベース」。どちらも無ければ「データベース」", () => {
    expect(defaultDatabaseName("バックエンド", "aozora-api")).toBe("バックエンドのデータベース");
    expect(defaultDatabaseName("", "aozora-api")).toBe("aozora-apiのデータベース");
    expect(defaultDatabaseName("", "")).toBe("データベース");
    expect(defaultDatabaseName("あ".repeat(300), "").length).toBeLessThanOrEqual(200);
  });
});
