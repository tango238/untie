// 段階 1 (データ): マイグレーションのフォルダを 1 つの組として扱う。実物の変換器 (sqlFilesToPrismaDsl) を通して、最後の形が合うことまで確かめる。
import { describe, expect, it } from "vitest";
import { parsePrismaDsl } from "@untie/core/model/prisma";
import { emptyModel } from "@untie/core/model/types";
import {
  applyDataImport,
  defaultSchemaLeftovers,
  defaultSchemaSelection,
  findSchemaCandidates,
  isDownMigration,
  partialMigrationGroups,
  planDataImport,
  previewSchema,
  type SchemaCandidate,
  type SchemaInput,
} from "../reverseData";
import { MAX_FILE_BYTES, memorySourceTree } from "../sourceTree";

/** 候補を、画面と同じように、既定の選び方で選んで変換する (選んだ順 = 候補の並び = 当てる順) */
async function scanAndConvert(files: Record<string, string>, selectIds?: (c: (SchemaCandidate & { id: string })[]) => string[]) {
  const { candidates, notes, skipped } = await findSchemaCandidates(memorySourceTree("api", files));
  const withId = candidates.map((c) => ({ ...c, id: c.path }));
  const ids = new Set(selectIds ? selectIds(withId) : defaultSchemaSelection(withId));
  const chosen = withId.filter((c) => ids.has(c.id));
  const inputs: SchemaInput[] = [];
  for (const c of chosen) inputs.push({ path: c.path, kind: c.kind, text: await c.read() });
  const preview = previewSchema(inputs);
  const schema = parsePrismaDsl(preview.dsl);
  return { candidates: withId, chosen: chosen.map((c) => c.path), preview, schema, notes, skipped };
}
/** 変換器はテーブルの名前を Prisma の流儀 (User・Logs) にするので、大文字小文字を無視して引く */
const columnsOf = (r: { schema: ReturnType<typeof parsePrismaDsl> }, table: string) => r.schema.models.find((m) => m.name.toLowerCase() === table.toLowerCase())?.fields.map((f) => f.name.toLowerCase()) ?? [];
const tablesOf = (r: { schema: ReturnType<typeof parsePrismaDsl> }) => r.schema.models.map((m) => m.name.toLowerCase());

describe("マイグレーションの組: 進む向きを全部当てる (CREATE TABLE を含むかに関係なく)", () => {
  it("Flyway: V1 (CREATE) と V2 (ALTER ADD COLUMN) と V10 (ALTER) を、番号の数の順 (V2 は V10 より前) に全部選び、最後の形 (age 列つき) になる", async () => {
    const r = await scanAndConvert({
      "db/migration/V1__init.sql": "CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50));",
      "db/migration/V10__more.sql": "ALTER TABLE users ADD COLUMN email VARCHAR(100);",
      "db/migration/V2__add.sql": "ALTER TABLE users ADD COLUMN age INT;",
    });
    expect(r.candidates.map((c) => c.path)).toEqual(["db/migration/V1__init.sql", "db/migration/V2__add.sql", "db/migration/V10__more.sql"]);
    expect(r.candidates.map((c) => c.order)).toEqual([1, 2, 3]);
    expect(r.candidates.map((c) => c.hasTables)).toEqual([true, false, false]);
    expect(r.chosen).toEqual(["db/migration/V1__init.sql", "db/migration/V2__add.sql", "db/migration/V10__more.sql"]);
    expect(columnsOf(r, "users")).toEqual(expect.arrayContaining(["id", "name", "age", "email"]));
    expect(r.candidates.some((c) => c.orderUncertain)).toBe(false);
  });

  it("DROP TABLE だけのマイグレーションも当たり、消したテーブルが残らない", async () => {
    const r = await scanAndConvert({
      "db/migrations/001_init.sql": "CREATE TABLE a (id INT PRIMARY KEY);\nCREATE TABLE b (id INT PRIMARY KEY);",
      "db/migrations/002_drop_b.sql": "DROP TABLE b;",
    });
    expect(r.chosen).toHaveLength(2);
    expect(tablesOf(r)).toEqual(["a"]);
  });

  it("golang-migrate: *.up.sql だけを選び、*.down.sql (CREATE TABLE を含んでも) は候補に出すが選ばない。印が付く", async () => {
    const r = await scanAndConvert({
      "migrations/000001_init.up.sql": "CREATE TABLE a (id INT PRIMARY KEY);\nCREATE TABLE b (id INT PRIMARY KEY);",
      "migrations/000001_init.down.sql": "DROP TABLE b;\nDROP TABLE a;",
      "migrations/000002_x.up.sql": "DROP TABLE a;",
      "migrations/000002_x.down.sql": "CREATE TABLE a (id INT PRIMARY KEY);",
    });
    expect(r.candidates.map((c) => [c.path, c.down])).toEqual([
      ["migrations/000001_init.up.sql", false],
      ["migrations/000001_init.down.sql", true],
      ["migrations/000002_x.up.sql", false],
      ["migrations/000002_x.down.sql", true],
    ]);
    expect(r.chosen).toEqual(["migrations/000001_init.up.sql", "migrations/000002_x.up.sql"]);
    // 取り消し用に CREATE TABLE a があっても、消えているはずの a は残らない
    expect(tablesOf(r)).toEqual(["b"]);
  });

  it("取り消し用の名前: down・rollback・revert・undo・Flyway の U 始まり。ふつうの名前は取り消し用にしない", () => {
    for (const p of ["a.down.sql", "down.sql", "001_x_down.sql", "U3__undo.sql", "001_rollback.sql", "x_revert_users.sql", "undo.sql", "down/001.sql"]) expect(isDownMigration(p), p).toBe(true);
    for (const p of ["V1__init.sql", "001_add_users.sql", "20240101_create_downloads.sql", "V3__add_countdown.sql", "up.sql"]) expect(isDownMigration(p), p).toBe(false);
  });

  it("Prisma の migrations/<時刻>_<名前>/migration.sql は、フォルダ名の時刻の順に当てる", async () => {
    const r = await scanAndConvert({
      "prisma/migrations/20240301000000_add_age/migration.sql": 'ALTER TABLE "User" ADD COLUMN "age" INTEGER;',
      "prisma/migrations/20240101000000_init/migration.sql": 'CREATE TABLE "User" ("id" SERIAL PRIMARY KEY, "name" TEXT);',
      "prisma/migrations/20240201000000_rename/migration.sql": 'ALTER TABLE "User" ADD COLUMN "email" TEXT;',
    });
    expect(r.candidates.map((c) => c.path)).toEqual([
      "prisma/migrations/20240101000000_init/migration.sql",
      "prisma/migrations/20240201000000_rename/migration.sql",
      "prisma/migrations/20240301000000_add_age/migration.sql",
    ]);
    expect(r.chosen).toHaveLength(3);
    expect(columnsOf(r, "User")).toEqual(expect.arrayContaining(["id", "name", "email", "age"]));
  });

  it("ゼロ埋めの有無・桁の違い・版の区切りが混ざっても、番号を数として比べる", async () => {
    const { candidates } = await findSchemaCandidates(
      memorySourceTree("api", {
        "migrations/2_x.sql": "SELECT 1;",
        "migrations/10_y.sql": "SELECT 1;",
        "migrations/009_z.sql": "SELECT 1;",
        "migrations/1_a.sql": "CREATE TABLE a (id INT);",
      }),
    );
    expect(candidates.map((c) => c.path)).toEqual(["migrations/1_a.sql", "migrations/2_x.sql", "migrations/009_z.sql", "migrations/10_y.sql"]);
    const v = await findSchemaCandidates(memorySourceTree("api", { "db/migration/V1_2__b.sql": "SELECT 1;", "db/migration/V1_10__c.sql": "SELECT 1;", "db/migration/V1_1__a.sql": "CREATE TABLE a (id INT);" }));
    expect(v.candidates.map((c) => c.path)).toEqual(["db/migration/V1_1__a.sql", "db/migration/V1_2__b.sql", "db/migration/V1_10__c.sql"]);
  });

  it("順が決められない組 (番号の無い名前・同じ番号) は、名前順にして「順を確かめて」の印を付ける", async () => {
    const a = await findSchemaCandidates(memorySourceTree("api", { "migrations/init.sql": "CREATE TABLE a (id INT);", "migrations/later.sql": "ALTER TABLE a ADD COLUMN x INT;" }));
    expect(a.candidates.every((c) => c.orderUncertain)).toBe(true);
    const b = await findSchemaCandidates(memorySourceTree("api", { "migrations/001_a.sql": "CREATE TABLE a (id INT);", "migrations/001_b.sql": "ALTER TABLE a ADD COLUMN x INT;" }));
    expect(b.candidates.every((c) => c.orderUncertain)).toBe(true);
    const ok = await findSchemaCandidates(memorySourceTree("api", { "migrations/001_a.sql": "CREATE TABLE a (id INT);", "migrations/002_b.sql": "ALTER TABLE a ADD COLUMN x INT;" }));
    expect(ok.candidates.some((c) => c.orderUncertain)).toBe(false);
  });

  it("マイグレーションのフォルダの外でも、同じフォルダに並ぶ、順番を表す名前の SQL (2 つ以上) は 1 つの組", async () => {
    const r = await scanAndConvert({ "sql/001_init.sql": "CREATE TABLE a (id INT PRIMARY KEY);", "sql/002_add.sql": "ALTER TABLE a ADD COLUMN x INT;", "sql/seed.sql": "INSERT INTO a VALUES (1);" });
    expect(r.candidates.find((c) => c.path === "sql/001_init.sql")!.group).toBe("sql");
    expect(r.candidates.find((c) => c.path === "sql/seed.sql")!.group).toBeUndefined();
    expect(r.chosen).toEqual(["sql/001_init.sql", "sql/002_add.sql"]);
    expect(columnsOf(r, "a")).toContain("x");
  });
});

describe("既定の選び方の優先と複数", () => {
  it("1 つにまとまったスキーマ (ダンプ・schema.sql) があれば、それだけを選び、マイグレーションの組は選ばない (二重にならない)", async () => {
    const r = await scanAndConvert({
      "db/schema.sql": "CREATE TABLE a (id INT PRIMARY KEY, x INT);",
      "db/migrations/001_init.sql": "CREATE TABLE a (id INT PRIMARY KEY);",
      "db/migrations/002_x.sql": "ALTER TABLE a ADD COLUMN x INT;",
    });
    expect(r.chosen).toEqual(["db/schema.sql"]);
    expect(r.preview.dslErrors).toEqual([]);
  });

  it("schema.prisma があれば、それを優先する", async () => {
    const r = await scanAndConvert({ "prisma/schema.prisma": "model A {\n  id Int @id\n}\n", "db/schema.sql": "CREATE TABLE b (id INT);", "migrations/1_x.sql": "CREATE TABLE c (id INT);" });
    expect(r.chosen).toEqual(["prisma/schema.prisma"]);
  });

  it("複数の道具のマイグレーション (migrations/ と prisma/migrations/) は混ぜず、ファイルの多い 1 つの組だけを選ぶ。選ばなかった組は知らせる", async () => {
    const files = {
      "migrations/001_a.sql": "CREATE TABLE a (id INT PRIMARY KEY);",
      "migrations/002_a.sql": "ALTER TABLE a ADD COLUMN x INT;",
      "prisma/migrations/20240101_init/migration.sql": 'CREATE TABLE "A" ("id" INT);',
    };
    const r = await scanAndConvert(files);
    expect(r.chosen).toEqual(["migrations/001_a.sql", "migrations/002_a.sql"]);
    expect(defaultSchemaLeftovers(r.candidates).groups).toEqual(["prisma/migrations"]);
  });

  it("ソースが複数のとき、既定はスキーマの見つかった先頭のソースだけ。取り込んだソースは skipRows に入れると、次のソースを選ぶ", () => {
    const c = (id: string, rowKey: number, kind: "sql" | "prisma" = "sql") => ({ id, rowKey, kind, hasTables: true, migration: false, down: false, group: undefined });
    const cands = [c("a1", 1), c("b1", 2), c("b2", 2)];
    expect([...defaultSchemaSelection(cands)]).toEqual(["a1"]);
    expect(defaultSchemaLeftovers(cands).rows).toEqual([2]);
    expect([...defaultSchemaSelection(cands, new Set([1]))]).toEqual(["b1", "b2"]);
    expect(defaultSchemaLeftovers(cands, new Set([1])).rows).toEqual([]);
    expect(defaultSchemaSelection(cands, new Set([1, 2])).size).toBe(0);
  });

  it("一部だけ選んだ組・取り消し用を選んだ組を見つける (全部選んだ組・選んでいない組は見つけない)", async () => {
    const { candidates } = await findSchemaCandidates(
      memorySourceTree("api", { "migrations/001_a.up.sql": "CREATE TABLE a (id INT);", "migrations/001_a.down.sql": "DROP TABLE a;", "migrations/002_b.up.sql": "ALTER TABLE a ADD COLUMN x INT;" }),
    );
    const withId = candidates.map((c) => ({ ...c, id: c.path }));
    const up = withId.filter((c) => !c.down).map((c) => c.id);
    expect(partialMigrationGroups(withId, new Set(up))).toEqual([]);
    expect(partialMigrationGroups(withId, new Set([up[0]!]))).toEqual(["migrations"]);
    expect(partialMigrationGroups(withId, new Set([...up, "migrations/001_a.down.sql"]))).toEqual(["migrations"]);
    expect(partialMigrationGroups(withId, new Set())).toEqual([]);
  });
});

describe("大きなダンプと、落ちたものの知らせ", () => {
  const bigDump = (): string => `CREATE TABLE logs (id INT PRIMARY KEY, body TEXT);\n${"INSERT INTO logs VALUES (1, 'データ入りの行です');\n".repeat(16000)}`;

  it("512KB を超える SQL のダンプも候補に出て、テーブルの定義を見つけ、既定で選ばれ、全部読める。AI の道具 (files・readFile の一覧) には出ない", async () => {
    const dump = bigDump();
    expect(dump.length).toBeGreaterThan(MAX_FILE_BYTES);
    const tree = memorySourceTree("api", { "db/dump.sql": dump, "src/a.ts": "export {}" });
    const { candidates } = await findSchemaCandidates(tree);
    expect(candidates.map((c) => [c.path, c.hasTables])).toEqual([["db/dump.sql", true]]);
    expect(candidates[0]!.size).toBeGreaterThan(MAX_FILE_BYTES);
    expect([...defaultSchemaSelection(candidates.map((c) => ({ ...c, id: c.path })))]).toEqual(["db/dump.sql"]);
    expect((await candidates[0]!.read()).length).toBe(dump.length);
    // 道具の側 (一覧・読み取り) には出さない
    const { visibleFiles } = await import("../sourceTree");
    expect(visibleFiles(tree).map((f) => f.path)).toEqual(["src/a.ts"]);
    const preview = previewSchema([{ path: "db/dump.sql", kind: "sql", text: await candidates[0]!.read() }]);
    expect(preview.tables.map((t) => t.name.toLowerCase())).toEqual(["logs"]);
  });

  it("秘密になりうる名前・除外フォルダの下・上限を超えるものは候補に入れず、件数と理由を notes に出す", async () => {
    const dump = bigDump();
    const tree = memorySourceTree("api", { "db/ok.sql": dump, "node_modules/x/seed.sql": "CREATE TABLE z (id INT);", "secrets/prod.sql": "CREATE TABLE s (id INT);" });
    const { candidates, notes, skipped } = await findSchemaCandidates(tree);
    expect(candidates.map((c) => c.path)).toEqual(["db/ok.sql"]);
    expect(skipped.folder).toBeGreaterThanOrEqual(1);
    expect(notes.join("\n")).toMatch(/除外したフォルダ/);
    expect(notes.join("\n")).toMatch(/SQL のファイルを選ぶ/);
  });

  it("読めなかったファイルは候補に入れず、件数を notes に出す。大きなファイルの判定は先頭だけを読む", async () => {
    const dump = `${bigDump()}${"INSERT INTO logs VALUES (2, 'もっと行');\n".repeat(40000)}`;
    const tree = memorySourceTree("api", { "db/a.sql": "CREATE TABLE a (id INT);", "db/big.sql": dump });
    const reads: [string, number | undefined][] = [];
    const inner = tree.schemaFiles!;
    const broken = {
      ...tree,
      schemaFiles: {
        ...inner,
        read: async (path: string, maxBytes?: number) => {
          reads.push([path, maxBytes]);
          if (path === "db/a.sql") throw new Error("権限が切れました");
          return inner.read(path, maxBytes);
        },
      },
    };
    const { candidates, notes, skipped } = await findSchemaCandidates(broken);
    expect(candidates.map((c) => c.path)).toEqual(["db/big.sql"]);
    expect(skipped.unreadable).toBe(1);
    expect(notes.join("\n")).toMatch(/読めなかった SQL/);
    expect(notes.join("\n")).toMatch(/権限/);
    // 大きなファイルは、判定のために先頭の一定量だけ読む
    expect(reads.find(([p]) => p === "db/big.sql")![1]).toBeLessThan(dump.length);
  });
});

describe("同じテーブルが多く重なる別の名前のデータベース", () => {
  const dsl = "model A {\n  id Int @id\n}\n\nmodel B {\n  id Int @id\n}\n\nmodel C {\n  id Int @id\n}\n";
  it("知らせる (止めない)。名前が同じなら置き換えなので知らせない。重なりが少なければ知らせない", () => {
    const base = applyDataImport(emptyModel("m"), { name: "旧データベース", dsl }).model;
    const plan = planDataImport(base, { name: "新データベース", dsl });
    expect(plan.overlaps).toHaveLength(1);
    expect(plan.overlaps[0]!.message).toBe("データベース「旧データベース」と同じテーブルが 3 個あります。置き換えるなら同じ名前にしてください");
    const r = applyDataImport(base, { name: "新データベース", dsl });
    expect(r.failure).toBeUndefined();
    expect(r.warnings).toContain(plan.overlaps[0]!.message);
    expect(r.model.databases).toHaveLength(2);
    expect(planDataImport(base, { name: "旧データベース", dsl }).overlaps).toEqual([]);
    expect(planDataImport(base, { name: "別", dsl: "model Z {\n  id Int @id\n}\n" }).overlaps).toEqual([]);
  });
});
