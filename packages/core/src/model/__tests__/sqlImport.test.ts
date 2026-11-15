import { describe, expect, it } from "vitest";
import { addDatabase, setDatabaseDesign, setDatabaseDsl } from "../commands";
import { DSL_MAX_LENGTH, NAME_MAX_LENGTH } from "../limits";
import { parsePrismaDsl, type PrismaField, type PrismaModel, type PrismaSchema } from "../prisma";
import { SQL_IMPORT_LIMITS, sqlFilesToPrismaDsl, sqlToPrismaDsl, type SqlImportResult } from "../sqlImport";
import { emptyModel } from "../types";
import { validateModel } from "../validate";
import { okModel } from "./helpers";
import { HANDWRITTEN_SCHEMA, MYSQL_DUMP, PG_DUMP, SQLITE_SCHEMA } from "./__fixtures__/sqlDumps";

/** 変換した DSL が解析エラー 0 で読めることを確かめて、解析結果を返す */
function schemaOf(r: SqlImportResult): PrismaSchema {
  expect(r.dslErrors).toEqual([]);
  const s = parsePrismaDsl(r.dsl);
  expect(s.errors).toEqual([]);
  return s;
}

const model = (s: PrismaSchema, name: string): PrismaModel => {
  const m = s.models.find((x) => x.name === name);
  if (!m) throw new Error(`model ${name} がありません: ${s.models.map((x) => x.name).join(", ")}`);
  return m;
};
const field = (m: PrismaModel, name: string): PrismaField => {
  const f = m.fields.find((x) => x.name === name);
  if (!f) throw new Error(`field ${m.name}.${name} がありません: ${m.fields.map((x) => x.name).join(", ")}`);
  return f;
};
const attr = (f: PrismaField, name: string) => f.attributes.find((a) => a.name === name);
const blockAttr = (m: PrismaModel, name: string) => m.blockAttributes.filter((a) => a.name === name);
/** 外部キーの側の関連 (fields を持つ @relation) の数 */
const relationCount = (s: PrismaSchema) => s.models.flatMap((m) => m.fields).filter((f) => f.relation?.fields).length;
/** 型が model の field (関連の field) の数 */
const modelTypedCount = (s: PrismaSchema) => {
  const names = new Set(s.models.map((m) => m.name));
  return s.models.flatMap((m) => m.fields).filter((f) => names.has(f.type)).length;
};
const messages = (r: SqlImportResult) => r.notes.map((n) => n.message);
const notesText = (r: SqlImportResult) => messages(r).join("\n");

/** 1 つのテーブルの型の変換を見る */
function typeOf(sql: string, column = "c") {
  const r = sqlToPrismaDsl(sql);
  const s = schemaOf(r);
  const f = field(s.models[0]!, column);
  return { r, f, native: f.attributes.filter((a) => a.name.startsWith("db.")).map((a) => (a.args ? `${a.name}(${a.args})` : a.name)) };
}

describe("pg_dump --schema-only", () => {
  const r = sqlToPrismaDsl(PG_DUMP);
  const s = schemaOf(r);

  it("テーブルと enum が全部出て、解析エラーが 0", () => {
    expect(r.tables.map((t) => t.table)).toEqual(["authors", "publishers", "books", "book_authors", "customers", "addresses", "orders", "order_items"]);
    expect(r.tables.map((t) => t.model)).toEqual(["Authors", "Publishers", "Books", "BookAuthors", "Customers", "Addresses", "Orders", "OrderItems"]);
    expect(s.models.map((m) => m.name)).toEqual(r.tables.map((t) => t.model));
    expect(r.tables.map((t) => t.columns)).toEqual(s.models.map((m) => m.fields.filter((f) => !f.relation && !s.models.some((x) => x.name === f.type)).length));
    expect(r.enums).toEqual(["OrderStatus"]);
    expect(s.enums).toHaveLength(1);
    expect(s.enums[0]).toMatchObject({ name: "OrderStatus", values: ["pending", "paid", "shipped", "cancelled"], mapName: "order_status" });
  });

  it("制約があとから ALTER TABLE で付く: 主キー・一意・外部キー", () => {
    expect(field(model(s, "Authors"), "id")).toMatchObject({ isId: true, type: "Int" });
    expect(field(model(s, "Books"), "isbn").isUnique).toBe(true);
    expect(field(model(s, "Customers"), "email").isUnique).toBe(true);
    // 複合の主キー
    expect(blockAttr(model(s, "BookAuthors"), "id")[0]!.args).toBe("[bookId, authorId]");
    expect(blockAttr(model(s, "OrderItems"), "id")[0]!.args).toBe("[orderId, lineNo]");
    expect(model(s, "BookAuthors").fields.some((f) => f.isId)).toBe(false);
    // CREATE UNIQUE INDEX は複合の一意になる
    expect(blockAttr(model(s, "Addresses"), "unique")[0]!.args).toBe("[customerId, postalCode]");
    // 外部キー 9 本 → 外部キーの側 9 + 参照される側 9
    expect(relationCount(s)).toBe(9);
    expect(modelTypedCount(s)).toBe(18);
    expect(field(model(s, "Books"), "publisher").relation).toEqual({ fields: ["publisherId"], references: ["id"] });
    expect(field(model(s, "Books"), "publisher")).toMatchObject({ type: "Publishers", isOptional: false });
    expect(field(model(s, "Publishers"), "books")).toMatchObject({ type: "Books", isList: true });
  });

  it("連番・IDENTITY・DEFAULT・型", () => {
    // nextval (ALTER … SET DEFAULT) と GENERATED … AS IDENTITY
    expect(field(model(s, "Authors"), "id").defaultValue).toBe("autoincrement()");
    expect(field(model(s, "Books"), "id")).toMatchObject({ type: "BigInt", defaultValue: "autoincrement()" });
    expect(field(model(s, "Publishers"), "id").defaultValue).toBe("autoincrement()");
    // 連番ではない主キー
    expect(field(model(s, "Addresses"), "id").defaultValue).toBeUndefined();
    expect(field(model(s, "Customers"), "id")).toMatchObject({ type: "String", defaultValue: "uuid()" });
    expect(attr(field(model(s, "Customers"), "id"), "db.Uuid")).toBeDefined();
    expect(field(model(s, "Customers"), "createdAt")).toMatchObject({ type: "DateTime", defaultValue: "now()", mapName: "created_at" });
    expect(attr(field(model(s, "Customers"), "createdAt"), "db.Timestamptz")).toBeDefined();
    expect(field(model(s, "Orders"), "orderedAt").defaultValue).toBe("now()");
    // キャスト付きの DEFAULT
    expect(field(model(s, "Publishers"), "country").defaultValue).toBe('"JP"');
    expect(field(model(s, "BookAuthors"), "role").defaultValue).toBe('"author"');
    expect(field(model(s, "Books"), "tags")).toMatchObject({ type: "String", isList: true, isOptional: false, defaultValue: "[]" });
    expect(field(model(s, "Books"), "isActive")).toMatchObject({ type: "Boolean", defaultValue: "true" });
    expect(field(model(s, "Books"), "price")).toMatchObject({ type: "Decimal", defaultValue: "0" });
    expect(attr(field(model(s, "Books"), "price"), "db.Decimal")?.args).toBe("8, 2");
    expect(attr(field(model(s, "Books"), "title"), "db.VarChar")?.args).toBe("255");
    expect(attr(field(model(s, "Books"), "isbn"), "db.Char")?.args).toBe("13");
    expect(field(model(s, "Books"), "metadata")).toMatchObject({ type: "Json", isOptional: true });
    expect(attr(field(model(s, "Books"), "metadata"), "db.JsonB")).toBeDefined();
    expect(field(model(s, "Books"), "cover")).toMatchObject({ type: "Bytes", isOptional: true });
    expect(field(model(s, "Books"), "publishedAt")).toMatchObject({ type: "DateTime", isOptional: true });
    // NOT NULL でない列だけ ?
    expect(field(model(s, "Authors"), "bio").isOptional).toBe(true);
    expect(field(model(s, "Authors"), "name").isOptional).toBe(false);
    // snake_case の列は camelCase にして @map
    expect(field(model(s, "Books"), "publisherId").mapName).toBe("publisher_id");
    expect(model(s, "BookAuthors").mapName).toBe("book_authors");
    expect(model(s, "Books").mapName).toBe("books");
  });

  it("enum の列と DEFAULT", () => {
    expect(field(model(s, "Orders"), "status")).toMatchObject({ type: "OrderStatus", defaultValue: "pending", isOptional: false });
  });

  it("同じテーブルへの外部キーが複数あれば、関連に名前を付けて区別する", () => {
    const orders = model(s, "Orders");
    const billing = field(orders, "billingAddress");
    const shipping = field(orders, "shippingAddress");
    expect(billing).toMatchObject({ type: "Addresses", isOptional: false, relation: { fields: ["billingAddressId"], references: ["id"] } });
    expect(shipping).toMatchObject({ type: "Addresses", isOptional: true, relation: { fields: ["shippingAddressId"], references: ["id"] } });
    expect(billing.attributes.find((a) => a.name === "relation")!.args).toMatch(/^"Orders_billingAddressId", /);
    const back = model(s, "Addresses").fields.filter((f) => f.type === "Orders");
    expect(back).toHaveLength(2);
    expect(back.every((f) => f.isList)).toBe(true);
    expect(new Set(back.map((f) => f.name)).size).toBe(2);
    expect(back.map((f) => attr(f, "relation")!.args).sort()).toEqual(['"Orders_billingAddressId"', '"Orders_shippingAddressId"']);
    // 1 本だけの関連は名前を付けない
    expect(attr(field(orders, "customer"), "relation")!.args).toBe("fields: [customerId], references: [id]");
  });

  it("COMMENT ON は // のコメントになる (model の上・field の行末)", () => {
    expect(r.dsl).toContain("// 著者\nmodel Authors {");
    expect(r.dsl).toMatch(/name\s+String\s+@db\.VarChar\(120\) \/\/ 著者名 \(筆名を含む\)\n/);
    expect(r.dsl).toMatch(/isbn\s+String\s+@unique @db\.Char\(13\) \/\/ ISBN-13 \(ハイフンなし\)\n/);
  });

  it("コメントに */ や model X { や改行があっても、構造は壊れない", () => {
    expect(r.dsl).toContain("// 注文\n// (1 注文 1 行。*/ model Injected { は文字としてそのまま残す)\nmodel Orders {");
    expect(s.models.some((m) => m.name === "Injected")).toBe(false);
    expect(s.models).toHaveLength(8);
  });

  it("読み飛ばしたものは 1 件にまとめ、データの文は 1 行で知らせる", () => {
    const skip = r.notes.filter((n) => n.message.startsWith("読み飛ばした文"));
    expect(skip).toHaveLength(1);
    for (const kind of ["psql のメタコマンド 2 件", "SET 8 件", "CREATE FUNCTION 1 件", "CREATE VIEW 1 件", "CREATE TRIGGER 1 件", "GRANT 1 件", "CREATE SEQUENCE 2 件", "CREATE INDEX (一意でないもの) 1 件"]) {
      expect(skip[0]!.message).toContain(kind);
    }
    const data = r.notes.filter((n) => n.message.startsWith("データの文"));
    expect(data).toHaveLength(1);
    expect(data[0]!.message).toContain("COPY 1 件");
    expect(data[0]!.message).toContain("INSERT 1 件");
    // 変換できないものは無く、全部で 2 件だけ
    expect(r.notes).toHaveLength(2);
  });

  it("COPY のデータ・$$ の本体・文字列の中の ; で、文の切り出しが崩れない", () => {
    // 関数の本体に CREATE TABLE のような文があってもテーブルにならない
    const t = sqlToPrismaDsl(`CREATE FUNCTION f() RETURNS void AS $body$ CREATE TABLE fake (x int); SELECT 'a;b'; $body$ LANGUAGE sql;\nCREATE TABLE real_one (id int);`);
    expect(t.tables.map((x) => x.table)).toEqual(["real_one"]);
    expect(r.tables).toHaveLength(8);
  });

  it("出力は決定的 (同じ入力から同じ文字列)", () => {
    expect(sqlToPrismaDsl(PG_DUMP)).toEqual(r);
    expect(sqlFilesToPrismaDsl([{ path: "a.sql", text: PG_DUMP }]).dsl).toBe(r.dsl);
  });
});

describe("mysqldump --no-data", () => {
  const r = sqlToPrismaDsl(MYSQL_DUMP);
  const s = schemaOf(r);

  it("テーブル・enum・解析エラー 0", () => {
    expect(r.tables.map((t) => t.model)).toEqual(["Members", "Categories", "Items", "Loans", "ItemTags", "Reservations"]);
    expect(r.tables.map((t) => t.columns)).toEqual([5, 3, 10, 5, 2, 5]);
    expect(r.enums).toEqual(["ItemsKind", "ReservationsStatus"]);
    expect(s.enums.map((e) => e.values)).toEqual([
      ["book", "dvd", "magazine"],
      ["waiting", "ready", "expired"],
    ]);
  });

  it("AUTO_INCREMENT・COMMENT・バッククォート・ENGINE の COMMENT", () => {
    const members = model(s, "Members");
    expect(field(members, "id")).toMatchObject({ isId: true, defaultValue: "autoincrement()" });
    expect(r.dsl).toContain('// 会員 (it\'s a "test")\nmodel Members {');
    expect(r.dsl).toMatch(/name\s+String\s+@db\.VarChar\(100\) \/\/ 氏名; 本名\n/);
    expect(field(members, "email").isUnique).toBe(true);
    expect(r.dsl).toContain("// 蔵書\nmodel Items {");
  });

  it("型: tinyint(1) は真偽値、unsigned、enum、ON UPDATE、DEFAULT", () => {
    const items = model(s, "Items");
    expect(field(model(s, "Members"), "isActive")).toMatchObject({ type: "Boolean", defaultValue: "true" });
    expect(field(items, "isAvailable")).toMatchObject({ type: "Boolean", defaultValue: "true" });
    expect(field(items, "id")).toMatchObject({ type: "BigInt", defaultValue: "autoincrement()" });
    expect(attr(field(items, "id"), "db.UnsignedBigInt")).toBeDefined();
    expect(attr(field(model(s, "Categories"), "id"), "db.UnsignedSmallInt")).toBeDefined();
    expect(field(model(s, "Categories"), "id").type).toBe("Int");
    expect(field(items, "kind")).toMatchObject({ type: "ItemsKind", defaultValue: "book", isOptional: false });
    expect(field(model(s, "Reservations"), "status")).toMatchObject({ type: "ReservationsStatus", defaultValue: "waiting" });
    expect(field(items, "price")).toMatchObject({ type: "Decimal", defaultValue: "0.00" });
    expect(attr(field(items, "price"), "db.Decimal")?.args).toBe("10, 2");
    expect(attr(field(items, "summary"), "db.MediumText")).toBeDefined();
    expect(field(items, "extra")).toMatchObject({ type: "Json", isOptional: true });
    expect(field(items, "createdAt")).toMatchObject({ type: "DateTime", defaultValue: "now()" });
    expect(attr(field(items, "createdAt"), "db.DateTime")?.args).toBe("6");
    // ON UPDATE CURRENT_TIMESTAMP は @updatedAt
    expect(attr(field(items, "updatedAt"), "updatedAt")).toBeDefined();
    expect(field(items, "updatedAt").defaultValue).toBeUndefined();
    expect(field(model(s, "Reservations"), "note")).toMatchObject({ type: "String", isOptional: true });
    expect(attr(field(model(s, "Reservations"), "note"), "db.Text")).toBeDefined();
  });

  it("KEY・UNIQUE KEY・CONSTRAINT … FOREIGN KEY、自己参照", () => {
    expect(relationCount(s)).toBe(7);
    expect(blockAttr(model(s, "Loans"), "unique")[0]!.args).toBe("[itemId, loanedAt]");
    expect(blockAttr(model(s, "ItemTags"), "id")[0]!.args).toBe("[itemId, tag]");
    const cat = model(s, "Categories");
    const parent = field(cat, "parent");
    expect(parent).toMatchObject({ type: "Categories", isOptional: true, relation: { fields: ["parentId"], references: ["id"] } });
    expect(attr(parent, "relation")!.args).toMatch(/^"Categories_parentId", /);
    const children = cat.fields.find((f) => f.type === "Categories" && f.isList)!;
    expect(children).toBeDefined();
    expect(attr(children, "relation")!.args).toBe('"Categories_parentId"');
  });

  it("INSERT・LOCK TABLES・DELIMITER のトリガー・条件付きコメントで切り出しが崩れない", () => {
    expect(r.tables).toHaveLength(6);
    const skip = r.notes.find((n) => n.message.startsWith("読み飛ばした文"))!.message;
    expect(skip).toContain("LOCK 1 件");
    expect(skip).toContain("UNLOCK 1 件");
    expect(skip).toContain("DELIMITER");
    expect(r.notes.filter((n) => n.message.startsWith("データの文"))).toHaveLength(1);
    expect(notesText(r)).not.toContain("田中");
  });
});

describe("SQLite の .schema・手書きの schema.sql", () => {
  it("Laravel の .schema: 引用符付きの名前・AUTOINCREMENT・CREATE UNIQUE INDEX・インラインの外部キー・トリガー", () => {
    const r = sqlToPrismaDsl(SQLITE_SCHEMA);
    const s = schemaOf(r);
    // sqlite_sequence は内部のテーブルなので出さない
    expect(r.tables.map((t) => t.table)).toEqual(["migrations", "projects", "users", "tasks", "comments", "project_members", "attachments"]);
    expect(field(model(s, "Projects"), "id")).toMatchObject({ isId: true, type: "Int", defaultValue: "autoincrement()" });
    expect(field(model(s, "Projects"), "name").isUnique).toBe(true);
    expect(field(model(s, "Users"), "email").isUnique).toBe(true);
    expect(field(model(s, "Projects"), "archived")).toMatchObject({ type: "Boolean", defaultValue: "false" });
    expect(field(model(s, "Tasks"), "priority")).toMatchObject({ type: "Int", defaultValue: "3" });
    expect(field(model(s, "Tasks"), "estimate")).toMatchObject({ type: "Float", isOptional: true });
    expect(field(model(s, "Tasks"), "assignee")).toMatchObject({ type: "Users", isOptional: true });
    expect(blockAttr(model(s, "ProjectMembers"), "id")[0]!.args).toBe("[projectId, userId]");
    expect(field(model(s, "ProjectMembers"), "role").defaultValue).toBe('"member"');
    // 型を省略した INTEGER PRIMARY KEY は rowid の別名 (連番)
    expect(field(model(s, "Attachments"), "id")).toMatchObject({ isId: true, defaultValue: "autoincrement()" });
    expect(field(model(s, "Attachments"), "task")).toMatchObject({ type: "Tasks", isOptional: true });
    expect(field(model(s, "Attachments"), "bytes")).toMatchObject({ type: "Bytes" });
    expect(relationCount(s)).toBe(7);
    // トリガーの BEGIN … END の中の ; で切れず、そのあとの CREATE TABLE も読める
    expect(r.notes.find((n) => n.message.startsWith("読み飛ばした文"))!.message).toContain("CREATE TRIGGER 1 件");
  });

  it("手書きの schema.sql: SERIAL・インラインの PRIMARY KEY / REFERENCES・CHECK・CURRENT_DATE", () => {
    const r = sqlToPrismaDsl(HANDWRITTEN_SCHEMA);
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.model)).toEqual(["Departments", "Employees", "TimeEntries"]);
    expect(field(model(s, "Departments"), "deptCode")).toMatchObject({ isId: true, type: "String", mapName: "dept_code" });
    expect(attr(field(model(s, "Departments"), "deptCode"), "db.Char")?.args).toBe("4");
    expect(field(model(s, "Employees"), "id")).toMatchObject({ isId: true, type: "Int", defaultValue: "autoincrement()" });
    expect(field(model(s, "Employees"), "active")).toMatchObject({ type: "Boolean", defaultValue: "true" });
    expect(field(model(s, "Employees"), "salary")).toMatchObject({ type: "Decimal", isOptional: true });
    // 受けられない式は dbgenerated で、生の文字列として残す
    expect(field(model(s, "Employees"), "hiredOn").defaultValue).toBe('dbgenerated("CURRENT_DATE")');
    expect(blockAttr(model(s, "TimeEntries"), "id")[0]!.args).toBe("[employeeId, workDate]");
    expect(field(model(s, "Employees"), "manager")).toMatchObject({ type: "Employees", isOptional: true });
    expect(relationCount(s)).toBe(3);
    expect(r.notes.find((n) => n.message.startsWith("読み飛ばした文"))?.message ?? "").toContain("CHECK 制約");
  });
});

describe("マイグレーションの積み重ね", () => {
  const V1 = `CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(50) NOT NULL, mail VARCHAR(100));
CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), title TEXT);
CREATE TABLE tmp_logs (id INT, message TEXT);
`;
  const V2 = `ALTER TABLE users ADD COLUMN age INTEGER;
ALTER TABLE users RENAME COLUMN mail TO email;
ALTER TABLE users ALTER COLUMN name TYPE VARCHAR(200);
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE users ADD CONSTRAINT users_ghost_key UNIQUE (ghost);
ALTER TABLE posts DROP COLUMN title;
ALTER TABLE posts ADD COLUMN body TEXT, ADD COLUMN published BOOLEAN DEFAULT FALSE;
ALTER TABLE posts ALTER COLUMN body SET NOT NULL;
DROP TABLE tmp_logs;
ALTER TABLE posts RENAME TO articles;
CREATE TABLE IF NOT EXISTS users (id INT);
ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER;
`;
  const V3 = "ALTER TABLE `users` MODIFY COLUMN `name` VARCHAR(255) NOT NULL COMMENT '名前';\nALTER TABLE `users` CHANGE `age` `years` INT NULL;\nALTER TABLE `users` ADD COLUMN `nick` VARCHAR(20) AFTER `name`;\nRENAME TABLE `articles` TO `entries`;\nALTER TABLE `users` DROP COLUMN `nick`;\n";

  it("渡した順に当てて、最後の形になる", () => {
    const r = sqlFilesToPrismaDsl([
      { path: "V1__init.sql", text: V1 },
      { path: "V2__changes.sql", text: V2 },
    ]);
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.table)).toEqual(["users", "articles"]);
    const users = model(s, "Users");
    expect(users.fields.filter((f) => !f.relation && f.type !== "Articles").map((f) => f.name)).toEqual(["id", "name", "email", "age"]);
    expect(field(users, "name")).toMatchObject({ type: "String", isOptional: false });
    expect(attr(field(users, "name"), "db.VarChar")?.args).toBe("200");
    expect(field(users, "email")).toMatchObject({ isOptional: false, isUnique: true });
    expect(field(users, "age")).toMatchObject({ type: "Int", isOptional: true });
    const articles = model(s, "Articles");
    expect(articles.mapName).toBe("articles");
    expect(articles.fields.map((f) => f.name)).toEqual(["id", "userId", "body", "published", "user"]);
    expect(field(articles, "body")).toMatchObject({ type: "String", isOptional: false });
    expect(field(articles, "published")).toMatchObject({ type: "Boolean", defaultValue: "false", isOptional: true });
    // テーブルの改名のあとも、外部キーは同じテーブルを指す
    expect(field(articles, "user")).toMatchObject({ type: "Users", relation: { fields: ["userId"], references: ["id"] } });
    expect(field(users, "articles")).toMatchObject({ type: "Articles", isList: true });
    // 削除したテーブル・列は残らない
    expect(r.dsl).not.toContain("TmpLogs");
    expect(r.dsl).not.toContain("title");
  });

  it("notes に file が入る (ファイルごとの変換できなかったもの)", () => {
    const r = sqlFilesToPrismaDsl([
      { path: "V1__init.sql", text: V1 },
      { path: "V2__changes.sql", text: V2 },
    ]);
    const ghost = r.notes.find((n) => n.message.includes("ghost"));
    expect(ghost).toMatchObject({ file: "V2__changes.sql", line: 6 });
    expect(r.notes.every((n) => n.file === undefined || n.file === "V1__init.sql" || n.file === "V2__changes.sql")).toBe(true);
  });

  it("sqlToPrismaDsl の notes には file が入らない", () => {
    const r = sqlToPrismaDsl(`${V1}${V2}`);
    expect(r.notes.every((n) => n.file === undefined)).toBe(true);
    expect(r.notes.find((n) => n.message.includes("ghost"))?.line).toBe(3 + 6);
  });

  it("MySQL の MODIFY・CHANGE・AFTER・RENAME TABLE (3 つ目のファイル)", () => {
    const r = sqlFilesToPrismaDsl([
      { path: "V1.sql", text: V1 },
      { path: "V2.sql", text: V2 },
      { path: "V3.sql", text: V3 },
    ]);
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.table)).toEqual(["users", "entries"]);
    const users = model(s, "Users");
    expect(users.fields.filter((f) => f.type !== "Entries").map((f) => f.name)).toEqual(["id", "name", "email", "years"]);
    expect(attr(field(users, "name"), "db.VarChar")?.args).toBe("255");
    expect(r.dsl).toMatch(/name\s+String\s+@db\.VarChar\(255\) \/\/ 名前\n/);
    expect(field(users, "years")).toMatchObject({ type: "Int", isOptional: true });
  });

  it("順が違えば結果も違う (渡した順に当てる)", () => {
    const a = sqlFilesToPrismaDsl([
      { path: "1.sql", text: "CREATE TABLE t (a int);" },
      { path: "2.sql", text: "ALTER TABLE t ADD COLUMN b int;\nALTER TABLE t DROP COLUMN a;" },
    ]);
    const b = sqlFilesToPrismaDsl([
      { path: "2.sql", text: "ALTER TABLE t ADD COLUMN b int;\nALTER TABLE t DROP COLUMN a;" },
      { path: "1.sql", text: "CREATE TABLE t (a int);" },
    ]);
    expect(schemaOf(a).models[0]!.fields.map((f) => f.name)).toEqual(["b"]);
    expect(schemaOf(b).models[0]!.fields.map((f) => f.name)).toEqual(["a"]);
  });

  it("DROP TABLE のあとの同じ名前の CREATE TABLE は新しい定義。DROP したテーブルへの外部キーは消える", () => {
    const r = sqlToPrismaDsl(`CREATE TABLE a (id int primary key);
CREATE TABLE b (id int primary key, a_id int REFERENCES a(id));
DROP TABLE a;
CREATE TABLE a (code text primary key);
`);
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.table)).toEqual(["b", "a"]);
    expect(model(s, "B").fields.map((f) => f.name)).toEqual(["id", "aId"]);
    expect(model(s, "A").fields.map((f) => f.name)).toEqual(["code"]);
  });

  it("DROP COLUMN は、その列を使う主キー・一意・外部キーも消す", () => {
    const r = sqlToPrismaDsl(`CREATE TABLE p (id int primary key);
CREATE TABLE c (a int, b int, UNIQUE (a, b), FOREIGN KEY (a) REFERENCES p(id));
ALTER TABLE c DROP COLUMN a;
`);
    const s = schemaOf(r);
    expect(model(s, "C").blockAttributes).toEqual([{ name: "map", args: '"c"' }]);
    expect(relationCount(s)).toBe(0);
  });

  it("列の改名のあとも、制約と外部キーが付いてくる", () => {
    const r = sqlToPrismaDsl(`CREATE TABLE p (id int primary key);
CREATE TABLE c (pid int NOT NULL REFERENCES p(id), UNIQUE (pid));
ALTER TABLE p RENAME COLUMN id TO code;
ALTER TABLE c RENAME COLUMN pid TO parent_code;
`);
    const s = schemaOf(r);
    expect(field(model(s, "C"), "parentCode")).toMatchObject({ isUnique: true });
    expect(field(model(s, "C"), "p").relation).toEqual({ fields: ["parentCode"], references: ["code"] });
    // 外部キーの列が一意なので、参照される側は 1 対 1
    expect(field(model(s, "P"), "c")).toMatchObject({ type: "C", isList: false, isOptional: true });
  });
});

describe("文の切り出し", () => {
  const tableNames = (sql: string) => sqlToPrismaDsl(sql).tables.map((t) => t.table);

  it("文字列の中の ;・--・''・コメントの記号", () => {
    const r = sqlToPrismaDsl(`CREATE TABLE a (id int, note text DEFAULT 'x; y -- z /* w ''q'' # r');
CREATE TABLE b (id int); -- CREATE TABLE ghost (id int);
/* CREATE TABLE ghost2 (id int); */ CREATE TABLE c (id int);
`);
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.table)).toEqual(["a", "b", "c"]);
    expect(field(model(s, "A"), "note").defaultValue).toBe(`"x; y -- z /* w 'q' # r"`);
  });

  it("MySQL のバックスラッシュのエスケープと # のコメント", () => {
    const r = sqlToPrismaDsl("CREATE TABLE `a` (\n  `id` int, # コメント CREATE TABLE ghost (id int);\n  `n` varchar(10) COMMENT 'it\\'s; \"ok\"\\\\' DEFAULT 'a\\'b'\n) ENGINE=InnoDB;\nCREATE TABLE `b` (`id` int);");
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.table)).toEqual(["a", "b"]);
    expect(r.dsl).toContain(`// it's; "ok"\\`);
    expect(field(model(s, "A"), "n").defaultValue).toBe(`"a'b"`);
  });

  it("DELIMITER で区切りを変えたトリガー・プロシージャの中の ; で切れない", () => {
    const sql = `CREATE TABLE \`a\` (id int) ENGINE=InnoDB;
DELIMITER $$
CREATE PROCEDURE p()
BEGIN
  CREATE TABLE ghost (x int);
  INSERT INTO a VALUES (1);
END$$
DELIMITER ;
CREATE TABLE \`b\` (id int) ENGINE=InnoDB;
`;
    expect(tableNames(sql)).toEqual(["a", "b"]);
  });

  it("MySQL の /*! … */ の条件付きコメントは丸ごと読み飛ばす", () => {
    expect(tableNames("/*!40101 SET NAMES utf8 */;\n/*!50001 CREATE TABLE hidden (id int) */;\nCREATE TABLE a (id int) ENGINE=InnoDB;\n")).toEqual(["a"]);
  });

  it("PostgreSQL の入れ子の /* */ とドル引用", () => {
    expect(tableNames("/* a /* b */ CREATE TABLE ghost (id int); */ CREATE TABLE a (id int);\nSELECT $q$ ; CREATE TABLE ghost (x int) $q$;\nCREATE TABLE b (id int);")).toEqual(["a", "b"]);
  });

  it("BEGIN … END (ドル引用なし) の CREATE TRIGGER / FUNCTION の中の ; で切れない", () => {
    const sql = `CREATE TRIGGER t AFTER INSERT ON a BEGIN
  UPDATE a SET x = 1; CASE WHEN 1 THEN 1 END;
  CREATE TABLE ghost (x int);
END;
CREATE TABLE a (id int);
CREATE FUNCTION f() RETURNS int BEGIN IF 1 THEN RETURN 1; END IF; RETURN 2; END;
CREATE TABLE b (id int);`;
    expect(tableNames(sql)).toEqual(["a", "b"]);
  });

  it("列の名前が begin・event でも、CREATE TABLE が切れない", () => {
    expect(tableNames("CREATE TABLE a (begin int, event int); CREATE TABLE b (id int);")).toEqual(["a", "b"]);
  });

  it("COPY のデータは \\. まで読み飛ばす (データの中の ; や CREATE TABLE で切れない)", () => {
    const sql = "CREATE TABLE a (id int, t text);\nCOPY public.a (id, t) FROM stdin;\n1\tCREATE TABLE ghost (x int);\n2\t;--\n\\.\nCREATE TABLE b (id int);\n";
    const r = sqlToPrismaDsl(sql);
    expect(r.tables.map((t) => t.table)).toEqual(["a", "b"]);
    expect(r.notes.some((n) => n.message.includes("COPY 1 件"))).toBe(true);
  });

  it("COPY のデータが \\. で終わっていなければ、最後まで読み飛ばして知らせる", () => {
    const r = sqlToPrismaDsl("CREATE TABLE a (id int);\nCOPY a (id) FROM stdin;\n1\n2\n");
    expect(r.tables.map((t) => t.table)).toEqual(["a"]);
    expect(notesText(r)).toContain("COPY のデータが");
  });

  it("途中で終わった文・閉じていない引用符やかっこ", () => {
    const r = sqlToPrismaDsl("CREATE TABLE a (id int, name varchar(10)");
    expect(r.tables.map((t) => t.table)).toEqual(["a"]);
    expect(notesText(r)).toContain("閉じられていません");
    expect(schemaOf(r).models[0]!.fields.map((f) => f.name)).toEqual(["id", "name"]);
    expect(tableNames("CREATE TABLE a (id int);\nCREATE TABLE b (id int, x text DEFAULT 'abc")).toEqual(["a", "b"]);
  });

  it("括弧つきの [名前] と type[] を区別する", () => {
    const r = sqlToPrismaDsl("CREATE TABLE [dbo].[Order Items] ([Item Id] int NOT NULL, tags text[], PRIMARY KEY ([Item Id]));");
    const s = schemaOf(r);
    expect(r.tables[0]).toMatchObject({ table: "Order Items", model: "OrderItems" });
    expect(field(s.models[0]!, "itemId")).toMatchObject({ isId: true, mapName: "Item Id" });
    expect(field(s.models[0]!, "tags")).toMatchObject({ isList: true, type: "String" });
  });
});

describe("フレームワークのマイグレーションの生の SQL", () => {
  it("Prisma の migration.sql (引用符付きの名前・SERIAL・enum・CREATE UNIQUE INDEX・AddForeignKey)", () => {
    const r = sqlFilesToPrismaDsl([
      {
        path: "prisma/migrations/20240101_init/migration.sql",
        text: `-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "authorId" INTEGER NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
`,
      },
      {
        path: "prisma/migrations/20240201_add_bio/migration.sql",
        text: `-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bio" TEXT;
`,
      },
    ]);
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.model)).toEqual(["User", "Post"]);
    expect(r.enums).toEqual(["Role"]);
    expect(field(model(s, "User"), "role")).toMatchObject({ type: "Role", defaultValue: "USER" });
    expect(field(model(s, "User"), "email").isUnique).toBe(true);
    expect(field(model(s, "User"), "createdAt")).toMatchObject({ type: "DateTime", defaultValue: "now()" });
    expect(attr(field(model(s, "User"), "createdAt"), "db.Timestamp")).toBeUndefined();
    expect(field(model(s, "User"), "bio")).toMatchObject({ type: "String", isOptional: true });
    expect(field(model(s, "Post"), "author").relation).toEqual({ fields: ["authorId"], references: ["id"] });
    expect(field(model(s, "User"), "post")).toMatchObject({ type: "Post", isList: true });
    // 名前が同じなので @map は付かない
    expect(model(s, "User").mapName).toBeUndefined();
    expect(field(model(s, "Post"), "authorId").mapName).toBeUndefined();
  });

  it("Flyway の V1__init.sql・golang-migrate の *.up.sql (MySQL 風)", () => {
    const r = sqlFilesToPrismaDsl([
      {
        path: "V1__init.sql",
        text: `CREATE TABLE accounts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  login VARCHAR(40) NOT NULL UNIQUE,
  balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE TABLE transfers (
  id BIGINT AUTO_INCREMENT,
  from_id BIGINT NOT NULL,
  to_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_from FOREIGN KEY (from_id) REFERENCES accounts (id),
  CONSTRAINT fk_to FOREIGN KEY (to_id) REFERENCES accounts (id)
) ENGINE=InnoDB;
`,
      },
      {
        path: "000002_add_index.up.sql",
        text: "ALTER TABLE transfers ADD INDEX idx_from (from_id);\nALTER TABLE accounts ADD UNIQUE INDEX uq_login_opened (login, opened_at);\nALTER TABLE accounts DROP INDEX uq_login_opened;\nALTER TABLE transfers ADD COLUMN memo VARCHAR(200) NULL AFTER amount;",
      },
    ]);
    const s = schemaOf(r);
    expect(model(s, "Transfers").fields.filter((f) => f.type === "Accounts").map((f) => f.name)).toEqual(["from", "to"]);
    expect(model(s, "Transfers").fields.map((f) => f.name).slice(0, 5)).toEqual(["id", "fromId", "toId", "amount", "memo"]);
    expect(model(s, "Accounts").blockAttributes.filter((a) => a.name === "unique")).toEqual([]);
    expect(field(model(s, "Accounts"), "login").isUnique).toBe(true);
    expect(relationCount(s)).toBe(2);
  });

  it("Rails の structure.sql (pg_dump 形式。schema_migrations の INSERT)", () => {
    const r = sqlToPrismaDsl(`SET statement_timeout = 0;
CREATE TABLE public.ar_internal_metadata (
    key character varying NOT NULL,
    value character varying,
    created_at timestamp(6) without time zone NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);
CREATE TABLE public.users (
    id bigint NOT NULL,
    email character varying DEFAULT ''::character varying NOT NULL
);
CREATE SEQUENCE public.users_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;
ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);
ALTER TABLE ONLY public.ar_internal_metadata ADD CONSTRAINT ar_internal_metadata_pkey PRIMARY KEY (key);
ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX index_users_on_email ON public.users USING btree (email);
SET search_path TO "$user", public;
INSERT INTO "schema_migrations" (version) VALUES
('20240101000000'),
('20240102000000');
`);
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.model)).toEqual(["ArInternalMetadata", "Users"]);
    expect(field(model(s, "ArInternalMetadata"), "key").isId).toBe(true);
    expect(attr(field(model(s, "ArInternalMetadata"), "createdAt"), "db.Timestamp")?.args).toBe("6");
    expect(field(model(s, "Users"), "email")).toMatchObject({ isUnique: true, defaultValue: '""' });
    expect(field(model(s, "Users"), "id").defaultValue).toBe("autoincrement()");
  });

  it("SQLite のテーブルの PRIMARY KEY (\"id\" AUTOINCREMENT) とバッククォートの名前", () => {
    const r = sqlToPrismaDsl('CREATE TABLE `notes` (`id` INTEGER NOT NULL, `body` TEXT, PRIMARY KEY(`id` AUTOINCREMENT));\nCREATE TABLE sqlite_sequence(name,seq);');
    const s = schemaOf(r);
    expect(field(model(s, "Notes"), "id")).toMatchObject({ isId: true, defaultValue: "autoincrement()" });
    expect(r.tables).toHaveLength(1);
  });

  it("SQL Server の GO と [名前]・IDENTITY・NVARCHAR(MAX)", () => {
    const r = sqlToPrismaDsl(`CREATE TABLE [dbo].[Customers] (
  [Id] INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  [Name] NVARCHAR(MAX) NULL,
  [Active] BIT NOT NULL DEFAULT 1
)
GO
CREATE TABLE [dbo].[Orders] ([Id] INT IDENTITY NOT NULL PRIMARY KEY, [CustomerId] INT NOT NULL REFERENCES [dbo].[Customers]([Id]))
GO
`);
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.model)).toEqual(["Customers", "Orders"]);
    expect(field(model(s, "Customers"), "id")).toMatchObject({ isId: true, defaultValue: "autoincrement()" });
    expect(field(model(s, "Customers"), "active")).toMatchObject({ type: "Boolean", defaultValue: "true" });
    expect(field(model(s, "Orders"), "customer")).toMatchObject({ type: "Customers" });
  });

  it("MySQL の文字セットつきの DEFAULT と PRIMARY KEY … USING BTREE", () => {
    const r = sqlToPrismaDsl("CREATE TABLE `t` (`id` int NOT NULL, `s` varchar(10) DEFAULT _utf8mb4'abc', PRIMARY KEY (`id`) USING BTREE) ENGINE=InnoDB;");
    const s = schemaOf(r);
    expect(field(model(s, "T"), "s").defaultValue).toBe('"abc"');
    expect(field(model(s, "T"), "id").isId).toBe(true);
  });
});

describe("名前の整え方", () => {
  const dslOf = (sql: string) => {
    const r = sqlToPrismaDsl(sql);
    return { r, s: schemaOf(r) };
  };

  it("snake_case のテーブルは PascalCase にして、違えば @@map。単数形にはしない", () => {
    const { r, s } = dslOf("CREATE TABLE order_items (id int); CREATE TABLE Orders (id int); CREATE TABLE ORDER_LINES (id int); CREATE TABLE userProfiles (id int);");
    expect(r.tables.map((t) => [t.table, t.model])).toEqual([
      ["order_items", "OrderItems"],
      ["Orders", "Orders"],
      ["ORDER_LINES", "OrderLines"],
      ["userProfiles", "UserProfiles"],
    ]);
    expect(model(s, "OrderItems").mapName).toBe("order_items");
    expect(model(s, "Orders").mapName).toBeUndefined();
    expect(model(s, "OrderLines").mapName).toBe("ORDER_LINES");
  });

  it("同じ名前になるテーブル (order_items と OrderItems、スキーム違いの同名) は番号で区別する", () => {
    const { r, s } = dslOf("CREATE TABLE order_items (id int); CREATE TABLE \"OrderItems\" (id int); CREATE TABLE audit.users (id int); CREATE TABLE users (id int); CREATE TABLE other.users (id int);");
    expect(r.tables.map((t) => t.model)).toEqual(["OrderItems", "OrderItems2", "Users", "Users2", "Users3"]);
    expect(model(s, "OrderItems2").mapName).toBe("OrderItems");
    expect(model(s, "Users3").mapName).toBe("users");
    expect(r.tables.map((t) => t.table)).toEqual(["order_items", "OrderItems", "users", "users", "users"]);
  });

  it("予約語 (型の名前)・数字始まり・日本語・引用符付き・スキーマ名つき", () => {
    const { r, s } = dslOf(`CREATE TABLE string (id int);
CREATE TABLE "json" (id int);
CREATE TABLE "1st_table" (id int);
CREATE TABLE 顧客 (id int);
CREATE TABLE \`受注 明細\` (id int);
CREATE TABLE "my table" (id int);
CREATE TABLE public."Quoted""Name" (id int);
CREATE TABLE shop.public_items (id int);
`);
    expect(r.tables.map((t) => t.model)).toEqual(["StringTable", "JsonTable", "Table1stTable", "Table4", "Table5", "MyTable", "QuotedName", "ShopPublicItems".replace("ShopPublicItems", "PublicItems")]);
    expect(model(s, "Table4").mapName).toBe("顧客");
    expect(model(s, "Table5").mapName).toBe("受注 明細");
    expect(model(s, "MyTable").mapName).toBe("my table");
    expect(model(s, "QuotedName").mapName).toBe('Quoted"Name');
    expect(r.tables[7]!.table).toBe("public_items");
  });

  it("列の名前: camelCase にして @map、衝突・予約・日本語・数字始まり", () => {
    const { s } = dslOf(`CREATE TABLE t (
  id int, user_id int, "userId" int, UserName text, "ID2" int, created_at timestamp, "2fa_enabled" boolean, 氏名 text, "my col" int, "a-b" int, "a_b" int
);`);
    const names = model(s, "T").fields.map((f) => [f.name, f.mapName]);
    expect(names).toEqual([
      ["id", undefined],
      ["userId", "user_id"],
      ["userId2", "userId"],
      ["userName", "UserName"],
      ["id2", "ID2"],
      ["createdAt", "created_at"],
      ["column2faEnabled", "2fa_enabled"],
      ["column8", "氏名"],
      ["myCol", "my col"],
      ["aB", "a-b"],
      ["aB2", "a_b"],
    ]);
  });

  it("enum の名前と値 (識別子にできない値は @map)", () => {
    const { r, s } = dslOf(`CREATE TYPE public.order_status AS ENUM ('new', 'in progress', '2fa', 'a-b', 'a_b', '', '日本語');
CREATE TABLE t (s public.order_status);`);
    expect(r.enums).toEqual(["OrderStatus"]);
    const e = s.enums[0]!;
    expect(e.mapName).toBe("order_status");
    expect(e.values).toEqual(["new", "in_progress", "V2fa", "a_b", "a_b2", "VALUE", "VALUE2"]);
    expect(r.dsl).toContain('in_progress @map("in progress")');
    expect(r.dsl).toContain('a_b2');
    expect(r.dsl).toContain('VALUE2 @map("日本語")');
  });

  it("名前の長さは上限に収める", () => {
    const long = "x".repeat(500);
    const r = sqlToPrismaDsl(`CREATE TABLE ${long} (${long}2 int, ${long}3 int);`);
    const s = schemaOf(r);
    expect(s.models[0]!.name.length).toBeLessThanOrEqual(NAME_MAX_LENGTH);
    for (const f of s.models[0]!.fields) expect(f.name.length).toBeLessThanOrEqual(NAME_MAX_LENGTH);
    expect(r.tables[0]!.table.length).toBeLessThanOrEqual(NAME_MAX_LENGTH);
    expect(new Set(s.models[0]!.fields.map((f) => f.name)).size).toBe(2);
  });
});

describe("型の対応", () => {
  it("PostgreSQL の主な型", () => {
    const cases: [string, string, string[], { list?: boolean; optional?: boolean }?][] = [
      ["smallint", "Int", ["db.SmallInt"]],
      ["integer", "Int", []],
      ["int4", "Int", []],
      ["bigint", "BigInt", []],
      ["real", "Float", ["db.Real"]],
      ["double precision", "Float", []],
      ["numeric(12,3)", "Decimal", ["db.Decimal(12, 3)"]],
      ["numeric", "Decimal", []],
      ["money", "Decimal", ["db.Money"]],
      ["boolean", "Boolean", []],
      ["character varying(255)", "String", ["db.VarChar(255)"]],
      ["varchar", "String", []],
      ["character(8)", "String", ["db.Char(8)"]],
      ["text", "String", []],
      ["citext", "String", ["db.Citext"]],
      ["uuid", "String", ["db.Uuid"]],
      ["json", "Json", ["db.Json"]],
      ["jsonb", "Json", ["db.JsonB"]],
      ["bytea", "Bytes", ["db.ByteA"]],
      ["date", "DateTime", ["db.Date"]],
      ["time without time zone", "DateTime", ["db.Time"]],
      ["time(3) with time zone", "DateTime", ["db.Timetz(3)"]],
      ["timestamp without time zone", "DateTime", []],
      ["timestamp(6) without time zone", "DateTime", ["db.Timestamp(6)"]],
      ["timestamp with time zone", "DateTime", ["db.Timestamptz"]],
      ["timestamp(3) with time zone", "DateTime", ["db.Timestamptz(3)"]],
      ["inet", "String", ["db.Inet"]],
      ["xml", "String", ["db.Xml"]],
      ["text[]", "String", [], { list: true }],
      ["integer[][]", "Int", [], { list: true }],
      ["character varying(20)[]", "String", ["db.VarChar(20)"], { list: true }],
      ["integer ARRAY", "Int", [], { list: true }],
      ["serial", "Int", []],
      ["bigserial", "BigInt", []],
      ["smallserial", "Int", ["db.SmallInt"]],
    ];
    for (const [sql, prisma, db, opts] of cases) {
      const { f, native } = typeOf(`CREATE TABLE t (c ${sql} NOT NULL);\nCREATE EXTENSION x; SELECT pg_catalog.x();`);
      expect([sql, f.type, f.isList, native]).toEqual([sql, prisma, !!opts?.list, db]);
    }
    expect(typeOf("CREATE TABLE t (c serial);").f.defaultValue).toBe("autoincrement()");
    expect(typeOf("CREATE TABLE t (c serial);").f.isOptional).toBe(false);
    // 配列は ? を付けない
    expect(typeOf("CREATE TABLE t (c text[]);\nSELECT 1::int;").f).toMatchObject({ isList: true, isOptional: false });
  });

  it("MySQL の主な型", () => {
    const cases: [string, string, string[]][] = [
      ["tinyint(1)", "Boolean", []],
      ["tinyint(4)", "Int", ["db.TinyInt"]],
      ["tinyint unsigned", "Int", ["db.UnsignedTinyInt"]],
      ["smallint(6)", "Int", ["db.SmallInt"]],
      ["mediumint", "Int", ["db.MediumInt"]],
      ["int(11)", "Int", []],
      ["int unsigned", "Int", ["db.UnsignedInt"]],
      ["bigint(20) unsigned", "BigInt", ["db.UnsignedBigInt"]],
      ["float", "Float", ["db.Float"]],
      ["double", "Float", []],
      ["decimal(10,2)", "Decimal", ["db.Decimal(10, 2)"]],
      ["bit(1)", "Boolean", []],
      ["bit(8)", "Bytes", ["db.Bit(8)"]],
      ["char(36)", "String", ["db.Char(36)"]],
      ["varchar(191)", "String", ["db.VarChar(191)"]],
      ["tinytext", "String", ["db.TinyText"]],
      ["text", "String", ["db.Text"]],
      ["mediumtext", "String", ["db.MediumText"]],
      ["longtext", "String", ["db.LongText"]],
      ["json", "Json", []],
      ["blob", "Bytes", ["db.Blob"]],
      ["longblob", "Bytes", ["db.LongBlob"]],
      ["binary(16)", "Bytes", ["db.Binary(16)"]],
      ["varbinary(255)", "Bytes", ["db.VarBinary(255)"]],
      ["date", "DateTime", ["db.Date"]],
      ["time(3)", "DateTime", ["db.Time(3)"]],
      ["datetime", "DateTime", []],
      ["datetime(6)", "DateTime", ["db.DateTime(6)"]],
      ["timestamp", "DateTime", ["db.Timestamp(0)"]],
      ["year", "Int", ["db.Year"]],
    ];
    for (const [sql, prisma, db] of cases) {
      const { f, native } = typeOf("CREATE TABLE `t` (`c` " + sql + " NOT NULL) ENGINE=InnoDB;");
      expect([sql, f.type, native]).toEqual([sql, prisma, db]);
    }
  });

  it("SQLite の主な型 (型の書き方は自由)", () => {
    const cases: [string, string][] = [
      ["INTEGER", "Int"],
      ["INT", "Int"],
      ["BIGINT", "BigInt"],
      ["TEXT", "String"],
      ["VARCHAR(20)", "String"],
      ["NVARCHAR(100)", "String"],
      ["REAL", "Float"],
      ["FLOAT", "Float"],
      ["DOUBLE", "Float"],
      ["NUMERIC", "Decimal"],
      ["DECIMAL(10,5)", "Decimal"],
      ["BOOLEAN", "Boolean"],
      ["DATETIME", "DateTime"],
      ["TIMESTAMP", "DateTime"],
      ["DATE", "DateTime"],
      ["BLOB", "Bytes"],
      ["JSON", "Json"],
    ];
    for (const [sql, prisma] of cases) {
      const { f } = typeOf(`CREATE TABLE t (c ${sql} NOT NULL);\nPRAGMA foreign_keys = ON;`);
      expect([sql, f.type]).toEqual([sql, prisma]);
    }
    // 型が無い列は String にして、notes に残す
    const r = sqlToPrismaDsl("CREATE TABLE t (id INTEGER PRIMARY KEY, a, b NOT NULL);\nPRAGMA x;");
    expect(field(schemaOf(r).models[0]!, "a")).toMatchObject({ type: "String", isOptional: true });
    expect(r.notes.filter((n) => n.message.includes("型が書かれていない")).map((n) => n.line)).toEqual([1, 1]);
  });

  it("対応のない型は String にして、元の型を行末のコメントと notes に残す", () => {
    const r = sqlToPrismaDsl(`CREATE TABLE t (
  id int,
  area geometry(Point,4326),
  span interval,
  net cidr,
  flags set('a','b'),
  col mood_type
);`);
    const s = schemaOf(r);
    for (const n of ["area", "span", "net", "flags", "col"]) expect(field(s.models[0]!, n).type).toBe("String");
    expect(r.dsl).toMatch(/area\s+String\?\s+\/\/ 元の型: geometry\(Point,4326\)\n/);
    expect(r.dsl).toMatch(/flags\s+String\?\s+\/\/ 元の型: set\('a','b'\)\n/);
    expect(r.notes.filter((n) => n.message.includes("対応がないため、String にしました")).map((n) => n.line)).toEqual([3, 4, 5, 6, 7]);
  });

  it("CREATE DOMAIN は元の型にたどる", () => {
    const r = sqlToPrismaDsl("CREATE DOMAIN public.email AS character varying(254) NOT NULL;\nCREATE TABLE t (c public.email NOT NULL, d email);");
    const s = schemaOf(r);
    expect(attr(field(s.models[0]!, "c"), "db.VarChar")?.args).toBe("254");
    expect(field(s.models[0]!, "d").type).toBe("String");
  });

  it("MySQL の enum の列は、列ごとの enum (テーブル名 + 列名) になる", () => {
    const r = sqlToPrismaDsl("CREATE TABLE `a` (`kind` enum('x','y z','y_z') NOT NULL, `other` ENUM('x') DEFAULT NULL) ENGINE=InnoDB;");
    const s = schemaOf(r);
    expect(r.enums).toEqual(["AKind", "AOther"]);
    expect(s.enums[0]!.values).toEqual(["x", "y_z", "y_z2"]);
    expect(field(s.models[0]!, "other")).toMatchObject({ type: "AOther", isOptional: true });
  });

  it("PostgreSQL の enum の配列の列", () => {
    const r = sqlToPrismaDsl("CREATE TYPE color AS ENUM ('red','green');\nCREATE TABLE t (c color[] DEFAULT '{}'::color[], d public.color DEFAULT 'green');");
    const s = schemaOf(r);
    expect(field(s.models[0]!, "c")).toMatchObject({ type: "Color", isList: true, defaultValue: "[]" });
    expect(field(s.models[0]!, "d")).toMatchObject({ type: "Color", defaultValue: "green" });
  });
});

describe("DEFAULT の変換", () => {
  const def = (column: string, sql = "CREATE TABLE t") => {
    const r = sqlToPrismaDsl(`${sql} (c ${column});`);
    const f = field(schemaOf(r).models[0]!, "c");
    return { v: f.defaultValue, r, f };
  };

  it("定数・関数・キャスト", () => {
    expect(def("int DEFAULT 5").v).toBe("5");
    expect(def("int DEFAULT -5").v).toBe("-5");
    expect(def("int DEFAULT (0)").v).toBe("0");
    expect(def("int DEFAULT '7'::integer").v).toBe("7");
    expect(def("bigint DEFAULT 0::bigint").v).toBe("0");
    expect(def("numeric(5,2) DEFAULT 1.50").v).toBe("1.50");
    expect(def("double precision DEFAULT '0.5'").v).toBe("0.5");
    expect(def("text DEFAULT ''").v).toBe('""');
    expect(def("text DEFAULT 'it''s'").v).toBe('"it\'s"');
    expect(def("varchar(10) DEFAULT 'a'::character varying").v).toBe('"a"');
    expect(def("text DEFAULT E'a\\nb'").v).toBe('"a\\nb"');
    expect(def("boolean DEFAULT false").v).toBe("false");
    expect(def("boolean DEFAULT 't'").v).toBe("true");
    expect(def("boolean DEFAULT 'no'::boolean").v).toBe("false");
    expect(def("int DEFAULT NULL").v).toBeUndefined();
    expect(def("timestamp DEFAULT now()").v).toBe("now()");
    expect(def("timestamptz DEFAULT (now())").v).toBe("now()");
    expect(def("timestamp DEFAULT CURRENT_TIMESTAMP").v).toBe("now()");
    expect(def("timestamp(6) DEFAULT CURRENT_TIMESTAMP(6)").v).toBe("now()");
    expect(def("timestamp DEFAULT LOCALTIMESTAMP").v).toBe("now()");
    expect(def("timestamp DEFAULT 'now'::text::timestamp").v).toBe("now()");
    expect(def("timestamp DEFAULT '2020-01-02 03:04:05'").v).toBe('"2020-01-02T03:04:05Z"');
    expect(def("date DEFAULT '2020-01-02'::date").v).toBe('"2020-01-02T00:00:00Z"');
    expect(def("timestamptz DEFAULT '2020-01-02 03:04:05+09'").v).toBe('"2020-01-02T03:04:05+09:00"');
    expect(def("uuid DEFAULT gen_random_uuid()").v).toBe("uuid()");
    expect(def("uuid DEFAULT public.uuid_generate_v4()").v).toBe("uuid()");
    expect(def("varchar(36) DEFAULT (uuid())").v).toBe("uuid()");
    expect(def("jsonb DEFAULT '{}'::jsonb").v).toBe('"{}"');
    expect(def("text[] DEFAULT ARRAY[]::text[]").v).toBe("[]");
    expect(def("integer[] DEFAULT '{}'").v).toBe("[]");
  });

  it("連番: nextval・serial・IDENTITY・AUTO_INCREMENT・AUTOINCREMENT", () => {
    expect(def("int DEFAULT nextval('public.t_c_seq'::regclass)").v).toBe("autoincrement()");
    expect(def("int GENERATED BY DEFAULT AS IDENTITY").v).toBe("autoincrement()");
    expect(def("bigint GENERATED ALWAYS AS IDENTITY (START WITH 100)").v).toBe("autoincrement()");
    expect(def("int NOT NULL AUTO_INCREMENT").v).toBe("autoincrement()");
    expect(def("int PRIMARY KEY AUTOINCREMENT").v).toBe("autoincrement()");
    // Int・BigInt 以外の連番は付けずに知らせる
    const r = def("text DEFAULT nextval('s')").r;
    expect(r.notes.some((n) => n.message.includes("連番"))).toBe(true);
  });

  it("受けられない式は dbgenerated で安全に残し、長すぎるものは落とす", () => {
    expect(def("text DEFAULT lower('A') || 'b'").v).toBe(`dbgenerated("lower('A') || 'b'")`);
    expect(def("timestamp DEFAULT (now() AT TIME ZONE 'utc'::text)").v).toBe(`dbgenerated("now() AT TIME ZONE 'utc'::text")`);
    expect(def("int DEFAULT (1 + 2)").v).toBe('dbgenerated("1 + 2")');
    expect(def('text DEFAULT \'a"b\\c\'').v).toBe('"a\\"b\\\\c"');
    const long = def(`text DEFAULT lower(${"'x',".repeat(100)}'y')`);
    expect(long.v).toBeUndefined();
    expect(long.r.notes.some((n) => n.message.includes("DEFAULT") && n.line === 1)).toBe(true);
    const bad = def("boolean DEFAULT 'maybe'");
    expect(bad.v).toBe(`dbgenerated("'maybe'")`);
    expect(def("timestamp DEFAULT '0000-00-00 00:00:00'").v).toBe(`dbgenerated("'0000-00-00 00:00:00'")`);
  });

  it("DEFAULT の文字列に改行・引用符・} があっても DSL は壊れない", () => {
    const r = sqlToPrismaDsl("CREATE TABLE t (a text DEFAULT E'x\\n}\\nmodel Evil {\\n\"', b text DEFAULT '}', c text DEFAULT 'a // b');");
    const s = schemaOf(r);
    expect(s.models).toHaveLength(1);
    expect(field(s.models[0]!, "b").defaultValue).toBe('"}"');
    expect(field(s.models[0]!, "c").defaultValue).toBe('"a // b"');
  });
});

describe("関連 (外部キー)", () => {
  it("1 対多: 外部キーの側に関連、参照される側に一覧", () => {
    const r = sqlToPrismaDsl("CREATE TABLE users (id int PRIMARY KEY);\nCREATE TABLE posts (id int PRIMARY KEY, author_id int NOT NULL, editor_id int, FOREIGN KEY (author_id) REFERENCES users(id));");
    const s = schemaOf(r);
    expect(field(model(s, "Posts"), "author")).toMatchObject({ type: "Users", isOptional: false, isList: false });
    expect(field(model(s, "Users"), "posts")).toMatchObject({ type: "Posts", isList: true, isOptional: false });
    // 外部キーでない列は関連にならない
    expect(model(s, "Posts").fields.map((f) => f.name)).toEqual(["id", "authorId", "editorId", "author"]);
    expect(attr(field(model(s, "Posts"), "author"), "relation")!.args).toBe("fields: [authorId], references: [id]");
  });

  it("外部キーが NULL 可なら関連も ?", () => {
    const s = schemaOf(sqlToPrismaDsl("CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id));"));
    expect(field(model(s, "B"), "a")).toMatchObject({ isOptional: true });
  });

  it("1 対 1 (外部キーの列が一意か主キー): 参照される側は ?", () => {
    const s = schemaOf(
      sqlToPrismaDsl(`CREATE TABLE users (id int PRIMARY KEY);
CREATE TABLE profiles (user_id int PRIMARY KEY REFERENCES users(id), bio text);
CREATE TABLE settings (id int PRIMARY KEY, user_id int NOT NULL UNIQUE REFERENCES users(id));`),
    );
    expect(field(model(s, "Users"), "profiles")).toMatchObject({ type: "Profiles", isList: false, isOptional: true });
    expect(field(model(s, "Users"), "settings")).toMatchObject({ type: "Settings", isList: false, isOptional: true });
    expect(field(model(s, "Profiles"), "user")).toMatchObject({ type: "Users", isOptional: false });
  });

  it("自己参照 (関連に名前を付ける)", () => {
    const s = schemaOf(sqlToPrismaDsl("CREATE TABLE nodes (id int PRIMARY KEY, parent_id int REFERENCES nodes(id));"));
    const nodes = model(s, "Nodes");
    expect(nodes.fields.map((f) => f.name)).toEqual(["id", "parentId", "parent", "nodes"]);
    expect(field(nodes, "parent")).toMatchObject({ type: "Nodes", isOptional: true });
    expect(field(nodes, "nodes")).toMatchObject({ type: "Nodes", isList: true });
    expect(attr(field(nodes, "parent"), "relation")!.args).toBe('"Nodes_parentId", fields: [parentId], references: [id]');
    expect(attr(field(nodes, "nodes"), "relation")!.args).toBe('"Nodes_parentId"');
  });

  it("同じテーブルへの外部キーが複数 (名前が重ならない)", () => {
    const s = schemaOf(
      sqlToPrismaDsl(`CREATE TABLE people (id int PRIMARY KEY);
CREATE TABLE messages (id int PRIMARY KEY, from_id int NOT NULL REFERENCES people(id), to_id int NOT NULL REFERENCES people(id), cc_id int REFERENCES people(id));`),
    );
    const msg = model(s, "Messages");
    expect(msg.fields.filter((f) => f.type === "People").map((f) => f.name)).toEqual(["from", "to", "cc"]);
    const back = model(s, "People").fields.filter((f) => f.type === "Messages");
    expect(back).toHaveLength(3);
    expect(new Set(back.map((f) => f.name)).size).toBe(3);
    const names = [...msg.fields, ...back].map((f) => attr(f, "relation")?.args.match(/^"([^"]+)"/)?.[1]).filter(Boolean);
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(3);
  });

  it("複合の外部キー", () => {
    const s = schemaOf(
      sqlToPrismaDsl(`CREATE TABLE tenants (tenant_id int, code text, PRIMARY KEY (tenant_id, code));
CREATE TABLE items (id int PRIMARY KEY, tenant_id int NOT NULL, tenant_code text NOT NULL, FOREIGN KEY (tenant_id, tenant_code) REFERENCES tenants (tenant_id, code));`),
    );
    const f = field(model(s, "Items"), "tenants");
    expect(f.relation).toEqual({ fields: ["tenantId", "tenantCode"], references: ["tenantId", "code"] });
    expect(f.isOptional).toBe(false);
    expect(field(model(s, "Tenants"), "items")).toMatchObject({ type: "Items", isList: true });
  });

  it("参照先の列を省略した REFERENCES は、参照先の主キー", () => {
    const s = schemaOf(sqlToPrismaDsl("CREATE TABLE a (code text PRIMARY KEY);\nCREATE TABLE b (id int, a_code text REFERENCES a);"));
    expect(field(model(s, "B"), "a").relation).toEqual({ fields: ["aCode"], references: ["code"] });
  });

  it("参照先のテーブルが SQL に無い: 関連にせず、列は残して notes と行末のコメントに残す", () => {
    const r = sqlToPrismaDsl("CREATE TABLE a (\n  id int PRIMARY KEY,\n  owner_id int REFERENCES accounts(id)\n);");
    const s = schemaOf(r);
    expect(s.models).toHaveLength(1);
    expect(model(s, "A").fields.map((f) => f.name)).toEqual(["id", "ownerId"]);
    expect(r.dsl).toMatch(/ownerId\s+Int\?\s+@map\("owner_id"\) \/\/ 参照先: accounts\(id\)\n/);
    const note = r.notes.find((n) => n.message.includes("accounts"))!;
    expect(note).toMatchObject({ line: 3 });
  });

  it("参照先に主キーが無い・参照先の列が無い・列の数が合わない", () => {
    const r = sqlToPrismaDsl(`CREATE TABLE nopk (x int);
CREATE TABLE a (id int PRIMARY KEY, n int REFERENCES nopk, m int REFERENCES nopk(zzz), k int);
CREATE TABLE b (p int, q int, FOREIGN KEY (p, q) REFERENCES a(id));`);
    const s = schemaOf(r);
    expect(relationCount(s)).toBe(0);
    expect(r.notes.filter((n) => n.message.includes("外部キー")).map((n) => n.line)).toEqual([3, 2, 2]);
  });

  it("関連の field の名前が既存の列とぶつからない", () => {
    const s = schemaOf(
      sqlToPrismaDsl(`CREATE TABLE users (id int PRIMARY KEY, posts text);
CREATE TABLE posts (id int PRIMARY KEY, user_id int REFERENCES users(id), "user" text);`),
    );
    for (const m of s.models) expect(new Set(m.fields.map((f) => f.name)).size).toBe(m.fields.length);
    const posts = model(s, "Posts");
    expect(field(posts, "user").type).toBe("String");
    expect(posts.fields.find((f) => f.type === "Users")!.name).not.toBe("user");
    expect(model(s, "Users").fields.find((f) => f.type === "Posts")!.name).not.toBe("posts");
  });

  it("関連の field は、型が model の field だけ (画面の列の候補では除かれる)", () => {
    const s = schemaOf(sqlToPrismaDsl(PG_DUMP));
    const names = new Set(s.models.map((m) => m.name));
    for (const m of s.models) {
      for (const f of m.fields) {
        if (names.has(f.type)) expect(f.relation?.fields !== undefined || f.isList || f.isOptional).toBe(true);
        else expect(f.relation).toBeUndefined();
      }
    }
    // 値の列は ER 図・画面の項目の対応の列になる
    const orders = model(s, "Orders");
    expect(orders.fields.filter((f) => !names.has(f.type)).map((f) => f.name)).toEqual(["id", "customerId", "status", "billingAddressId", "shippingAddressId", "total", "orderedAt"]);
  });
});

describe("変換しないもの・あいまいなもの", () => {
  it("条件つき・式の一意インデックスは一意にせず、notes に行番号つきで残す", () => {
    const r = sqlToPrismaDsl(`CREATE TABLE u (id int PRIMARY KEY, email text, deleted_at timestamp);
CREATE UNIQUE INDEX u_email_live ON u (email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX u_email_lower ON u (lower(email));
CREATE UNIQUE INDEX u_ok ON u (email, deleted_at);
`);
    const s = schemaOf(r);
    expect(blockAttr(model(s, "U"), "unique").map((a) => a.args)).toEqual(["[email, deletedAt]"]);
    expect(field(model(s, "U"), "email").isUnique).toBe(false);
    expect(r.notes.filter((n) => n.message.includes("u_email_live") || n.message.includes("式を含む")).map((n) => n.line)).toEqual([2, 3]);
  });

  it("外部キーが、あとで作られるテーブルを指しても結べる (FOREIGN_KEY_CHECKS=0 のダンプ)", () => {
    const s = schemaOf(sqlToPrismaDsl("CREATE TABLE `child` (`id` int NOT NULL, `pid` int NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `fk` FOREIGN KEY (`pid`) REFERENCES `parent` (`id`)) ENGINE=InnoDB;\nCREATE TABLE `parent` (`id` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB;"));
    expect(field(model(s, "Child"), "parent").relation).toEqual({ fields: ["pid"], references: ["id"] });
  });

  it("TEMP・仮想テーブル・CREATE TABLE AS・パーティションの子は読み飛ばして、知らせる", () => {
    const r = sqlToPrismaDsl(`CREATE TEMP TABLE tmp (x int);
CREATE VIRTUAL TABLE ft USING fts5(a);
CREATE TABLE snap AS SELECT 1;
CREATE TABLE parent (id int, at date) PARTITION BY RANGE (at);
CREATE TABLE child PARTITION OF parent FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE sqlite_stat1 (tbl, idx, stat);
`);
    schemaOf(r);
    expect(r.tables.map((t) => t.table)).toEqual(["parent"]);
    expect(r.notes.filter((n) => n.line !== undefined && /snap|child/.test(n.message)).map((n) => n.line)).toEqual([3, 5]);
    expect(r.notes.find((n) => n.message.startsWith("読み飛ばした文"))!.message).toContain("CREATE TEMP TABLE 1 件");
  });

  it("同じテーブルをもう一度作ったら、あとの定義に置き換えて知らせる。同じ列名の重ねも知らせる", () => {
    const r = sqlToPrismaDsl("CREATE TABLE a (x int);\nCREATE TABLE a (y int, y text);");
    expect(schemaOf(r).models[0]!.fields.map((f) => f.name)).toEqual(["y"]);
    expect(r.notes.map((n) => n.line)).toEqual(expect.arrayContaining([2]));
  });

  it("大文字小文字だけが違う名前は同じものとして扱う", () => {
    const s = schemaOf(sqlToPrismaDsl('CREATE TABLE Users (Id int PRIMARY KEY);\nALTER TABLE USERS ADD COLUMN "Name" text;'));
    expect(s.models[0]!.fields.map((f) => f.name)).toEqual(["id", "name"]);
  });

  it("DSL の上限を超えるときは、出さなかったテーブルへの関連を持たない (解析エラー 0)", () => {
    const cols = Array.from({ length: 30 }, (_, i) => `column_number_${i} varchar(100) NOT NULL DEFAULT 'abcdefghijklmnop'`).join(", ");
    let sql = "";
    for (let i = 0; i < 400; i++) sql += `CREATE TABLE tbl_${i} (id int PRIMARY KEY, ${i > 0 ? `prev_id int REFERENCES tbl_${i - 1}(id), ` : ""}${cols});\n`;
    const r = sqlToPrismaDsl(sql);
    const s = schemaOf(r);
    expect(r.tables.length).toBeLessThan(400);
    expect(r.dsl.length).toBeLessThanOrEqual(DSL_MAX_LENGTH);
    // 最後に出したテーブルは、あとのテーブルから参照されない
    expect(model(s, s.models[s.models.length - 1]!.name).fields.filter((f) => f.isList && /^Tbl/.test(f.type))).toEqual([]);
  });
});

describe("壊れた入力・悪意のある入力", () => {
  const garbage = [
    "",
    "   \n\t  ",
    "Hello, world! これは SQL ではありません。",
    "{ \"a\": 1 }",
    "CREATE",
    "CREATE TABLE",
    "CREATE TABLE (",
    "CREATE TABLE t",
    "CREATE TABLE t (",
    "CREATE TABLE t (a int",
    "CREATE TABLE t (a int,,, b",
    "CREATE TABLE t (a int) CREATE TABLE u (b int);",
    "CREATE TABLE t (a int DEFAULT",
    "CREATE TABLE t (a int DEFAULT ((((",
    "CREATE TABLE t (a int REFERENCES",
    "CREATE TABLE t (a int, FOREIGN KEY",
    "CREATE TABLE t (a int, FOREIGN KEY (a) REFERENCES",
    "CREATE TABLE t (a int, PRIMARY KEY (",
    "CREATE TABLE t (a int, UNIQUE",
    "ALTER TABLE",
    "ALTER TABLE t",
    "ALTER TABLE t ADD",
    "ALTER TABLE t ALTER COLUMN",
    "ALTER TABLE t RENAME",
    "DROP TABLE",
    "DROP",
    "COMMENT ON",
    "COMMENT ON TABLE",
    "COMMENT ON COLUMN t. IS",
    "RENAME TABLE",
    "'unterminated",
    '"unterminated',
    "`unterminated",
    "[unterminated",
    "/* unterminated",
    "-- only comment",
    "$$ unterminated",
    "$tag$ unterminated",
    "DELIMITER",
    "DELIMITER $$\nCREATE TABLE t (a int)$$",
    "CREATE TRIGGER t BEGIN BEGIN BEGIN",
    "COPY t FROM stdin;\n1",
    "\\connect x\n\\",
    "\0\0\0\u0001\u0002",
    ")))((()));;;;",
    "CREATE TABLE t (a int);;;;;; ;",
    "CREATE TYPE x AS ENUM (",
    "CREATE TYPE x AS ENUM ('a', 1, , 'b'",
    "CREATE UNIQUE INDEX",
    "CREATE UNIQUE INDEX i ON",
    "CREATE UNIQUE INDEX i ON t (",
    "ALTER TYPE x ADD VALUE",
  ];

  it("例外を投げず、DSL は解析エラー 0", () => {
    for (const g of garbage) {
      const r = sqlToPrismaDsl(g);
      expect([g, r.dslErrors]).toEqual([g, []]);
      if (r.dsl !== "") expect(parsePrismaDsl(r.dsl).errors).toEqual([]);
      expect(r.tables.length === 0 ? r.dsl : "x").toBe(r.tables.length === 0 ? "" : "x");
    }
    expect(sqlToPrismaDsl("Hello").notes.map((n) => n.message)).toContain("テーブルの定義 (CREATE TABLE) が見つかりませんでした");
  });

  it("文字列以外・undefined が来ても例外を投げない", () => {
    expect(() => sqlToPrismaDsl(undefined as unknown as string)).not.toThrow();
    expect(() => sqlFilesToPrismaDsl([{ path: "a", text: null as unknown as string }, null as unknown as { path: string; text: string }])).not.toThrow();
    expect(sqlFilesToPrismaDsl([]).dsl).toBe("");
  });

  it("乱数で作った SQL のかけらでも、例外を投げず DSL は壊れない", () => {
    const vocab = ["CREATE", "TABLE", "ALTER", "ADD", "COLUMN", "DROP", "RENAME", "TO", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE", "CONSTRAINT", "NOT", "NULL", "DEFAULT", "(", ")", ",", ";", "t", "u", "a", "b", "id", "int", "text", "varchar(10)", "'x'", "'it''s", "\"q\"", "`b`", "[c]", "--", "/*", "*/", "::", "$$", "enum", "('a','b')", "IF", "EXISTS", "ONLY", "COMMENT", "ON", "IS", "TYPE", "AS", "ENUM", "}", "{", "model", "//", "\n", "\\.", "COPY", "FROM", "stdin", "DELIMITER", "BEGIN", "END", "CASE", "INDEX", "AUTO_INCREMENT", "GENERATED", "ALWAYS", "IDENTITY", "CHECK", "COLLATE", "MODIFY", "CHANGE", "AFTER", "FIRST", "TYPE", "SET", "DATA", "public.", ".", "="];
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 400; i++) {
      const n = 1 + (rnd() % 60);
      const parts: string[] = [];
      for (let j = 0; j < n; j++) parts.push(vocab[rnd() % vocab.length]!);
      const sql = parts.join(rnd() % 4 === 0 ? "" : " ");
      const r = sqlToPrismaDsl(sql);
      expect([sql, r.dslErrors]).toEqual([sql, []]);
    }
  });

  it("名前・コメント・DEFAULT・enum の値に } や改行や model X { や // を入れても、model の数は増えない", () => {
    const evil = "x}\nmodel Evil {\n  a Int\n}\n// \"; \\ \u2028 \u202e \u0000 \ufeff";
    const idq = evil.replace(/"/g, '""');
    const sql = `CREATE TYPE "e}${"\n"}enum Z {" AS ENUM ('a}', 'b\nmodel Y {', '${"//".repeat(3)}', '"q"');
CREATE TABLE "${idq}" (
  "${idq}" int PRIMARY KEY, -- 1 行のコメント model Evil {
  "x2" "e}${"\n"}enum Z {" DEFAULT 'a}',
  "y" text DEFAULT E'${evil.replace(/\n/g, "\\n")}' COMMENT '${evil}',
  "z" text REFERENCES "${idq}" ("${idq}")
);
COMMENT ON TABLE "${idq}" IS '${evil}';
COMMENT ON COLUMN "${idq}"."y" IS '${evil}';
COMMENT ON COLUMN "${idq}"."x2" IS '*/ model Evil2 { */';
`;
    const r = sqlToPrismaDsl(sql);
    const s = schemaOf(r);
    expect(s.models).toHaveLength(1);
    expect(s.enums.length).toBeLessThanOrEqual(1);
    expect(s.models.every((m) => /^[A-Za-z_]\w*$/.test(m.name))).toBe(true);
    expect(r.tables).toHaveLength(1);
    // 生成した DSL に、改行以外の制御文字・行区切り・向きを変える文字が残らない
    // eslint-disable-next-line no-control-regex
    expect(r.dsl).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/);
    // モデルの行は model と } だけ
    const heads = r.dsl.split("\n").filter((l) => /^(model|enum) /.test(l));
    expect(heads).toHaveLength(r.enums.length + 1);
    // 列も全部読める
    expect(r.tables[0]!.columns).toBe(4);
    expect(s.models[0]!.fields).toHaveLength(6);
  });

  it("識別子の注入: 制御文字だけの名前・空の名前・予約語", () => {
    const r = sqlToPrismaDsl('CREATE TABLE "\u0000\u0001" ("" int, "\n" int, "}" int, "model" int, "enum" int, "@id" int);');
    const s = schemaOf(r);
    expect(s.models).toHaveLength(1);
    expect(s.models[0]!.fields.every((f) => /^[A-Za-z_]\w*$/.test(f.name))).toBe(true);
    expect(new Set(s.models[0]!.fields.map((f) => f.name)).size).toBe(s.models[0]!.fields.length);
  });

  it("1 行が数十万文字でも固まらず、名前は上限に収まる", () => {
    const t0 = Date.now();
    for (const sql of [`CREATE TABLE t (a varchar(${"1".repeat(300_000)}));`, `CREATE TABLE t (a text DEFAULT '${"x".repeat(300_000)}');`, `CREATE TABLE ${"a".repeat(300_000)} (${"b".repeat(300_000)} int);`, `-- ${"c".repeat(300_000)}\nCREATE TABLE t (a int COMMENT '${"d".repeat(300_000)}');`, "(".repeat(300_000), `CREATE TABLE t (a int DEFAULT ${"(".repeat(100_000)}1${")".repeat(100_000)});`, `CREATE TABLE t (${"a int,".repeat(100_000)} z int);`]) {
      const r = sqlToPrismaDsl(sql);
      expect(r.dslErrors).toEqual([]);
      for (const m of parsePrismaDsl(r.dsl).models) {
        expect(m.name.length).toBeLessThanOrEqual(NAME_MAX_LENGTH);
        for (const f of m.fields) expect(f.name.length).toBeLessThanOrEqual(NAME_MAX_LENGTH);
      }
    }
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("COMMENT が長くても DSL は大きくなりすぎない", () => {
    const r = sqlToPrismaDsl(`CREATE TABLE t (a int);\nCOMMENT ON TABLE t IS '${"あ".repeat(100_000)}';\nCOMMENT ON COLUMN t.a IS '${"い".repeat(100_000)}';`);
    expect(r.dslErrors).toEqual([]);
    expect(r.dsl.length).toBeLessThan(10_000);
  });
});

describe("上限と性能", () => {
  const manyTables = (n: number, cols = 8) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const cs = ["id integer NOT NULL"];
      for (let c = 0; c < cols; c++) cs.push(`col_${c} character varying(50)`);
      out.push(`CREATE TABLE public.table_${i} (\n  ${cs.join(",\n  ")}\n);\nALTER TABLE ONLY public.table_${i} ADD CONSTRAINT table_${i}_pkey PRIMARY KEY (id);`);
      if (i > 0) out.push(`ALTER TABLE ONLY public.table_${i} ADD CONSTRAINT table_${i}_fk FOREIGN KEY (col_0) REFERENCES public.table_${i - 1}(id);`);
    }
    return out.join("\n");
  };

  it("上限の定数", () => {
    expect(SQL_IMPORT_LIMITS.maxDslChars).toBe(DSL_MAX_LENGTH);
    expect(SQL_IMPORT_LIMITS.maxTables).toBeGreaterThanOrEqual(1000);
    expect(SQL_IMPORT_LIMITS.maxChars).toBeGreaterThanOrEqual(10_000_000);
  });

  it("テーブル数千 + 数 MB のダンプが数秒以内。出力の DSL は DSL_MAX_LENGTH 以内で、超えたぶんは notes に残る", () => {
    const sql = manyTables(3000, 8);
    expect(sql.length).toBeGreaterThan(900_000);
    const t0 = Date.now();
    const r = sqlToPrismaDsl(sql);
    const ms = Date.now() - t0;
    expect(r.dsl.length).toBeLessThanOrEqual(DSL_MAX_LENGTH);
    expect(r.dslErrors).toEqual([]);
    expect(r.tables.length).toBeGreaterThan(300);
    expect(r.tables.length).toBeLessThan(3000);
    expect(parsePrismaDsl(r.dsl).models).toHaveLength(r.tables.length);
    expect(notesText(r)).toMatch(/上限 \(200000 文字\) を超えるため、後ろの \d+ 個のテーブル/);
    // 出したテーブルは先頭から、SQL に出てきた順
    expect(r.tables.map((t) => t.table)).toEqual(Array.from({ length: r.tables.length }, (_, i) => `table_${i}`));
    expect(ms).toBeLessThan(5000);
  });

  it("テーブルの数の上限を超えたら、以降を読まずに notes に残す", () => {
    const n = SQL_IMPORT_LIMITS.maxTables + 50;
    let sql = "";
    for (let i = 0; i < n; i++) sql += `CREATE TABLE t${i} (id int);\n`;
    const t0 = Date.now();
    const r = sqlToPrismaDsl(sql);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.tables.length).toBeLessThanOrEqual(SQL_IMPORT_LIMITS.maxTables);
    expect(notesText(r)).toContain(`テーブルの数が上限 (${SQL_IMPORT_LIMITS.maxTables})`);
    expect(r.dslErrors).toEqual([]);
    expect(r.dsl.length).toBeLessThanOrEqual(DSL_MAX_LENGTH);
  });

  it("列の数の上限", () => {
    const cols = Array.from({ length: SQL_IMPORT_LIMITS.maxColumnsPerTable + 100 }, (_, i) => `c${i} int`).join(", ");
    const r = sqlToPrismaDsl(`CREATE TABLE wide (${cols});`);
    expect(r.tables[0]!.columns).toBeLessThanOrEqual(SQL_IMPORT_LIMITS.maxColumnsPerTable);
    expect(notesText(r)).toContain(`列が上限 (${SQL_IMPORT_LIMITS.maxColumnsPerTable})`);
    expect(r.dslErrors).toEqual([]);
  });

  it("enum の値の数の上限", () => {
    const vals = Array.from({ length: SQL_IMPORT_LIMITS.maxEnumValues + 20 }, (_, i) => `'v${i}'`).join(",");
    const r = sqlToPrismaDsl(`CREATE TYPE e AS ENUM (${vals});\nCREATE TABLE t (c e);`);
    expect(parsePrismaDsl(r.dsl).enums[0]!.values).toHaveLength(SQL_IMPORT_LIMITS.maxEnumValues);
    expect(notesText(r)).toContain("値が上限");
  });

  it("入力の大きさの上限を超えたぶんは読まずに notes に残す", () => {
    const pad = "x".repeat(SQL_IMPORT_LIMITS.maxChars);
    const r = sqlToPrismaDsl(`CREATE TABLE a (id int);\n-- ${pad}\nCREATE TABLE b (id int);`);
    expect(r.tables.map((t) => t.table)).toEqual(["a"]);
    expect(notesText(r)).toContain("先頭の");
    const files = sqlFilesToPrismaDsl([
      { path: "big.sql", text: "CREATE TABLE a (id int);\n-- " + "y".repeat(SQL_IMPORT_LIMITS.maxChars) },
      { path: "next.sql", text: "CREATE TABLE b (id int);" },
    ]);
    expect(files.tables.map((t) => t.table)).toEqual(["a"]);
    expect(files.notes.find((n) => n.message.includes("読みませんでした"))).toMatchObject({ file: "next.sql" });
  });

  it("データ入りの数 MB のダンプ (INSERT・COPY) が数秒以内で、データはテーブルにならない", () => {
    const rows: string[] = [];
    for (let i = 0; i < 40_000; i++) rows.push(`(${i},'name ${i}; -- x ''q'' \\' CREATE TABLE ghost${i} (a int);','2020-01-01',NULL,1.5)`);
    const insert = `INSERT INTO a VALUES ${rows.join(",")};\n`;
    const copy = `COPY b (id, t) FROM stdin;\n${Array.from({ length: 40_000 }, (_, i) => `${i}\tCREATE TABLE ghost2_${i} (a int); -- ;`).join("\n")}\n\\.\n`;
    const sql = `CREATE TABLE a (id int PRIMARY KEY, name text, d date, x int, y float);\nCREATE TABLE b (id int PRIMARY KEY, t text);\n${insert}${copy}${insert}CREATE TABLE c (id int);\n`;
    expect(sql.length).toBeGreaterThan(3_000_000);
    const t0 = Date.now();
    const r = sqlToPrismaDsl(sql);
    const ms = Date.now() - t0;
    expect(r.tables.map((t) => t.table)).toEqual(["a", "b", "c"]);
    expect(r.dslErrors).toEqual([]);
    expect(r.notes.find((n) => n.message.startsWith("データの文"))?.message).toContain("INSERT 2 件");
    expect(ms).toBeLessThan(4000);
    // MySQL 方言 (バックスラッシュのエスケープ) でも
    const my = `CREATE TABLE \`a\` (id int) ENGINE=InnoDB;\n${insert}CREATE TABLE \`c\` (id int) ENGINE=InnoDB;\n`;
    const t1 = Date.now();
    expect(sqlToPrismaDsl(my).tables.map((t) => t.table)).toEqual(["a", "c"]);
    expect(Date.now() - t1).toBeLessThan(4000);
  });

  it("入力の大きさに対して線形に伸びる", () => {
    const small = manyTables(200, 8) + "\n" + `INSERT INTO t VALUES ${"(1,'a;b'),".repeat(20_000)}(2,'c');\n`;
    const big = small.repeat(8);
    expect(big.length).toBeGreaterThan(small.length * 7);
    // ウォームアップ
    sqlToPrismaDsl(small);
    const time = (sql: string) => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        sqlToPrismaDsl(sql);
        best = Math.min(best, Date.now() - t0);
      }
      return best;
    };
    const a = time(small);
    const b = time(big);
    // 8 倍の大きさで、2 乗なら 64 倍。線形なら 8 倍前後。余裕を見て 24 倍未満
    expect(b).toBeLessThan(Math.max(a, 3) * 24);
  });

  it("正規表現の後戻りで固まらない形の入力", () => {
    const t0 = Date.now();
    for (const sql of ["a".repeat(2_000_000) + "!", "'" + "a'".repeat(500_000), '"' + '""'.repeat(500_000), "/*".repeat(300_000), "$a$".repeat(300_000), "--".repeat(500_000), "\\".repeat(500_000), "CREATE TABLE t (" + "a ".repeat(300_000) + ")", "CREATE TABLE t (a " + "numeric(1,1) ".repeat(100_000) + ")", "ALTER TABLE t " + "ADD COLUMN a int, ".repeat(50_000), `CREATE TABLE t (id int);\n` + "ALTER TABLE t ADD COLUMN c int;\n".repeat(20_000)]) {
      const r = sqlToPrismaDsl(sql);
      expect(r.dslErrors).toEqual([]);
    }
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});

describe("設計モードのデータベースへ置く", () => {
  it("生成した DSL を setDatabaseDsl / setDatabaseDesign で置いて、validateModel を通る", () => {
    for (const sql of [PG_DUMP, MYSQL_DUMP, SQLITE_SCHEMA, HANDWRITTEN_SCHEMA]) {
      const r = sqlToPrismaDsl(sql);
      expect(r.dsl.length).toBeGreaterThan(0);
      let m = okModel(addDatabase(emptyModel(), { id: "db_sql", name: "取り込み" }));
      m = okModel(setDatabaseDsl(m, { id: "db_sql", dsl: r.dsl }));
      expect(validateModel(m).ok).toBe(true);
      expect(m.databases.find((d) => d.id === "db_sql")!.dsl).toBe(r.dsl);
      const m2 = okModel(setDatabaseDesign(m, { id: "db_sql", dsl: r.dsl, tables: r.tables.map((t) => ({ table: t.model, informationIds: [] })) }));
      const v = validateModel(m2);
      expect(v.ok).toBe(true);
      // model の名前が、そのまま設計のテーブルの名前になる (checkTableName を通る)
      for (const t of r.tables) expect(/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.model)).toBe(true);
    }
  });

  it("DSL の上限ぎりぎりまで大きくしても、置ける", () => {
    const r = sqlToPrismaDsl(
      Array.from({ length: 3000 }, (_, i) => `CREATE TABLE t_${i} (id int primary key, ${Array.from({ length: 10 }, (_, c) => `c_${c} text`).join(", ")});`).join("\n"),
    );
    expect(r.dsl.length).toBeLessThanOrEqual(DSL_MAX_LENGTH);
    let m = okModel(addDatabase(emptyModel(), { id: "db_big", name: "大きい" }));
    m = okModel(setDatabaseDsl(m, { id: "db_big", dsl: r.dsl }));
    expect(validateModel(m).ok).toBe(true);
  });
});
