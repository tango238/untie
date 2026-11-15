import { describe, expect, it } from "vitest";
import { addDatabase, setDatabaseDesign, setDatabaseDsl } from "../commands";
import { DSL_MAX_LENGTH, NAME_MAX_LENGTH } from "../limits";
import { parsePrismaDsl, type PrismaField, type PrismaModel, type PrismaSchema } from "../prisma";
import { SQL_IMPORT_LIMITS, sqlFilesToPrismaDsl, sqlToPrismaDsl, type SqlImportResult } from "../sqlImport";
import { emptyModel } from "../types";
import { validateModel } from "../validate";
import { okModel } from "./helpers";
import { HANDWRITTEN_SCHEMA, MYSQL_DUMP, PG_DUMP, SQLITE_SCHEMA, SQLSERVER_SCRIPT } from "./__fixtures__/sqlDumps";

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
    // 改行などの制御文字は、DSL の解析器が読み直せる形で書けないので空白にして、notes に残す
    expect(def("text DEFAULT E'a\\nb'").v).toBe('"a b"');
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
    expect(r.notes.filter((n) => n.line !== undefined && /snap|child/.test(n.message)).map((n) => n.line)).toEqual([3]);
    // パーティションの子は、読み飛ばしたものを 1 件にまとめて知らせる
    expect(r.notes.filter((n) => n.message.includes("パーティションの子")).map((n) => n.message)).toEqual([expect.stringContaining("child")]);
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
      for (let c = 0; c < cols; c++) cs.push(c === 0 ? "col_0 integer" : `col_${c} character varying(50)`);
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

// ---------------------------------------------------------------------------------------------
// レビューの指摘 (実際に SQL を通して確かめたもの) の再現

describe("DSL への注入 (SQL 由来の文字列が、整形を通らずに DSL へ出ない)", () => {
  /** 改行・\r・}・//・"・\・model X { を含む文字列 */
  const EVILS = ["x\nmodel Evil {\n  a Int\n}", "x\rmodel Evil {\r  a Int\r}", "x\r\nmodel Evil {\r\n  a Int\r\n}", "x}\n}\nenum Z {", "x // y\nmodel Evil {", 'x"\nmodel Evil {', "x\\\nmodel Evil {", "model Evil {", "x\u2028model Evil {\u2029", "x\u0085model Evil {", "}\nmodel Evil {\n}\n//"];
  const id = (e: string) => `"${e.replace(/"/g, '""')}"`;
  const str = (e: string) => `'${e.replace(/'/g, "''")}'`;

  /** DSL に model Evil・enum Z が出ず、model の数が表の数と同じで、行の形が model / enum の見出し・}・字下げ・コメントだけ */
  function expectSafe(r: SqlImportResult, tables: number, label: string) {
    expect([label, r.dslErrors]).toEqual([label, []]);
    const s = parsePrismaDsl(r.dsl);
    expect([label, s.errors]).toEqual([label, []]);
    expect([label, r.tables.length]).toEqual([label, tables]);
    expect([label, s.models.length]).toEqual([label, tables]);
    expect(s.models.map((m) => m.name)).not.toContain("Evil");
    expect(s.enums.map((m) => m.name)).not.toContain("Z");
    for (const line of r.dsl.split("\n")) {
      const ok = line === "" || line === "}" || /^(model|enum) [A-Za-z_]\w* \{$/.test(line) || line.startsWith("  ") || line.startsWith("//");
      expect([label, line, ok]).toEqual([label, line, true]);
      expect(/^\s*(model|enum)\s+(Evil|Z)\b/.test(line)).toBe(false);
    }
    // 改行以外の制御文字・行区切り・向きを変える文字が DSL に残らない
    // eslint-disable-next-line no-control-regex
    expect(r.dsl).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/);
  }

  const P = "CREATE TABLE p (id int PRIMARY KEY);\n";
  const cases: [string, (e: string) => string, number][] = [
    ["テーブルの名前", (e) => `CREATE TABLE ${id(e)} (id int PRIMARY KEY);`, 1],
    ["列の名前", (e) => `CREATE TABLE t (id int PRIMARY KEY, ${id(e)} int);`, 1],
    ["参照先のテーブルの名前 (SQL にない)", (e) => `CREATE TABLE t (id int PRIMARY KEY, x int REFERENCES ${id(e)} (id));`, 1],
    ["参照先のテーブルの名前と列の名前 (SQL にない)", (e) => `CREATE TABLE t (id int PRIMARY KEY, x int REFERENCES ${id(e)} (${id(e)}));`, 1],
    ["参照先の列の名前 (表はあるが列がない)", (e) => `${P}CREATE TABLE t (id int PRIMARY KEY, x int REFERENCES p (${id(e)}));`, 2],
    ["テーブルの外部キーの参照先 (SQL にない)", (e) => `CREATE TABLE t (id int PRIMARY KEY, x int, FOREIGN KEY (x) REFERENCES ${id(e)} (${id(e)}));`, 1],
    ["外部キーの制約名", (e) => `${P}CREATE TABLE t (id int PRIMARY KEY, x int, CONSTRAINT ${id(e)} FOREIGN KEY (x) REFERENCES p (id));`, 2],
    ["一意制約の名前", (e) => `CREATE TABLE t (id int PRIMARY KEY, x int, CONSTRAINT ${id(e)} UNIQUE (x));`, 1],
    ["主キーの制約名", (e) => `CREATE TABLE t (id int, CONSTRAINT ${id(e)} PRIMARY KEY (id));`, 1],
    ["インデックスの名前", (e) => `CREATE TABLE t (id int PRIMARY KEY, x int);\nCREATE UNIQUE INDEX ${id(e)} ON t (x);`, 1],
    ["型の名前 (対応がない型)", (e) => `CREATE TABLE t (id int PRIMARY KEY, x ${id(e)});`, 1],
    ["型の名前 (長さ・配列つき)", (e) => `CREATE TABLE t (id int PRIMARY KEY, x ${id(e)}(10), y ${id(e)}[]);`, 1],
    ["型の名前 (スキーマつき)", (e) => `CREATE TABLE t (id int PRIMARY KEY, x ${id(e)}.${id(e)});`, 1],
    ["enum の名前と値と DEFAULT", (e) => `CREATE TYPE ${id(e)} AS ENUM (${str(e)}, 'ok');\nCREATE TABLE t (id int PRIMARY KEY, x ${id(e)} DEFAULT ${str(e)});`, 1],
    ["enum の値の追加と改名", (e) => `CREATE TYPE s AS ENUM ('a');\nALTER TYPE s ADD VALUE ${str(e)};\nALTER TYPE s RENAME VALUE 'a' TO ${str(`${e}!`)};\nCREATE TABLE t (id int PRIMARY KEY, x s DEFAULT 'a');`, 1],
    ["MySQL の enum の値", (e) => `CREATE TABLE \`t\` (\`id\` int PRIMARY KEY, \`x\` enum(${str(e)}, 'b') DEFAULT 'b') ENGINE=InnoDB;`, 1],
    ["DEFAULT の文字列", (e) => `CREATE TABLE t (id int PRIMARY KEY, x text DEFAULT ${str(e)});`, 1],
    ["DEFAULT の式", (e) => `CREATE TABLE t (id int PRIMARY KEY, x text DEFAULT (${str(e)} || 'a'), y int DEFAULT ${id(e)});`, 1],
    ["列の COMMENT", (e) => `CREATE TABLE t (id int PRIMARY KEY, x int COMMENT ${str(e)});`, 1],
    ["テーブルの COMMENT=", (e) => `CREATE TABLE t (id int PRIMARY KEY) COMMENT=${str(e)};`, 1],
    ["COMMENT ON", (e) => `CREATE TABLE t (id int PRIMARY KEY, x int);\nCOMMENT ON TABLE t IS ${str(e)};\nCOMMENT ON COLUMN t.x IS ${str(e)};`, 1],
    ["ドメインの名前と元の型", (e) => `CREATE DOMAIN ${id(e)} AS ${id(`${e}2`)};\nCREATE TABLE t (id int PRIMARY KEY, x ${id(e)});`, 1],
    ["ドメインの名前 (対応する型)", (e) => `CREATE DOMAIN ${id(e)} AS varchar(10);\nCREATE TABLE t (id int PRIMARY KEY, x ${id(e)} DEFAULT ${str(e)});`, 1],
    ["INHERITS の親の名前", (e) => `CREATE TABLE t (id int PRIMARY KEY) INHERITS (${id(e)});`, 1],
    ["LIKE の元の名前", (e) => `CREATE TABLE t (LIKE ${id(e)});`, 1],
    ["パーティションの名前", (e) => `CREATE TABLE ${id(e)} PARTITION OF p FOR VALUES IN (1);\nCREATE TABLE t (id int PRIMARY KEY);`, 1],
    ["ALTER・RENAME の名前", (e) => `CREATE TABLE t (id int PRIMARY KEY, a int);\nALTER TABLE t ADD COLUMN ${id(e)} int;\nALTER TABLE t RENAME COLUMN ${id(e)} TO ${id(`${e}2`)};\nALTER TABLE t ADD CONSTRAINT ${id(e)} FOREIGN KEY (a) REFERENCES ${id(e)} (id);`, 1],
  ];

  for (const [label, make, tables] of cases) {
    it(`${label}に改行・\\r・}・//・"・\\・model X { を入れても、model も enum も増えず、DSL は壊れない`, () => {
      for (const e of EVILS) expectSafe(sqlToPrismaDsl(make(e)), tables, `${label}: ${JSON.stringify(e)}`);
    });
  }

  it("参照先のテーブルが無い外部キーの注記は、改行を行に分けて // を付ける (再現: 参照先の名前に model Evil { を入れる)", () => {
    for (const nl of ["\n", "\r", "\r\n"]) {
      const r = sqlToPrismaDsl(`CREATE TABLE t (id int PRIMARY KEY, x int REFERENCES "a${nl}model Evil {${nl} x Int${nl}}" (id));`);
      expect(r.dslErrors).toEqual([]);
      expect(parsePrismaDsl(r.dsl).models.map((m) => m.name)).toEqual(["T"]);
      expect(r.dsl).toContain("// 参照先: a");
      expect(r.dsl).toContain("// model Evil {");
    }
  });

  it("MySQL のバッククォートの名前・SQL Server の [名前] の中の改行と } でも", () => {
    const r = sqlToPrismaDsl("CREATE TABLE `a\nmodel Evil {\n}` (`id` int PRIMARY KEY, `b\n}` int REFERENCES `c\nmodel Evil {` (id)) ENGINE=InnoDB;");
    expectSafe(r, 1, "mysql");
    const m = sqlToPrismaDsl("CREATE TABLE [a model Evil {] ([id] int PRIMARY KEY, [b}] int);");
    expectSafe(m, 1, "mssql");
  });

  it("ファイルのパスに改行や } があっても、DSL には出ない (notes の file には入る)", () => {
    for (const e of EVILS) {
      const r = sqlFilesToPrismaDsl([{ path: e, text: "CREATE TABLE t (id int PRIMARY KEY, x int REFERENCES nowhere(id));" }]);
      expectSafe(r, 1, `path: ${JSON.stringify(e)}`);
      expect(r.dsl).not.toContain("Evil");
      expect(r.notes.some((n) => n.file !== undefined)).toBe(true);
    }
  });

  it("名前・コメント・型・DEFAULT・参照先を全部同時に入れた 1 つの SQL でも", () => {
    const e = EVILS.join(" ");
    const sql = `CREATE TYPE ${id(e)} AS ENUM (${str(e)});
CREATE TABLE ${id(e)} (${id(e)} int PRIMARY KEY, a ${id(e)} DEFAULT ${str(e)} COMMENT ${str(e)}, b ${id(`${e}b`)}, c int REFERENCES ${id(`${e}c`)} (${id(e)}), CONSTRAINT ${id(e)} UNIQUE (b)) COMMENT=${str(e)};
COMMENT ON COLUMN ${id(e)}.b IS ${str(e)};`;
    expectSafe(sqlToPrismaDsl(sql), 1, "all");
  });
});

describe("@map などの文字列は、DSL の解析器が読み直して同じ文字列に戻る形だけを出す", () => {
  it("\\ と \" は読み直して元に戻る", () => {
    const r = sqlToPrismaDsl('CREATE TABLE "a\\b""c" ("x\\y""z" int PRIMARY KEY);');
    const s = schemaOf(r);
    expect(s.models[0]!.mapName).toBe('a\\b"c');
    expect(s.models[0]!.fields[0]!.mapName).toBe('x\\y"z');
    expect(r.notes.filter((n) => n.message.includes("空白に置き換え"))).toEqual([]);
  });

  it("改行・タブ・制御文字は、解析器が読み直せる形で書けないので空白にして、notes に残す (\\n を出さない)", () => {
    const r = sqlToPrismaDsl('CREATE TABLE "a\nb\tc\u0000d" ("x\ry" int PRIMARY KEY, z text DEFAULT \'p\nq\');');
    const s = schemaOf(r);
    expect(s.models[0]!.mapName).toBe("a b c d");
    expect(s.models[0]!.fields[0]!.mapName).toBe("x y");
    expect(r.dsl).not.toMatch(/\\[nrt0]|\\u00/);
    expect(field(s.models[0]!, "z").defaultValue).toBe('"p q"');
    const msgs = r.notes.filter((n) => n.message.includes("空白に置き換え")).map((n) => n.message);
    expect(msgs.length).toBe(3);
  });

  it("enum の値の @map も同じ", () => {
    const r = sqlToPrismaDsl("CREATE TYPE e AS ENUM ('a\nb', 'c\\d');\nCREATE TABLE t (id int PRIMARY KEY, x e);");
    const s = schemaOf(r);
    expect(s.enums[0]!.values).toHaveLength(2);
    expect(r.dsl).not.toMatch(/\\n/);
    expect(r.notes.some((n) => n.message.includes("空白に置き換え"))).toBe(true);
  });
});

describe("SQLite のテーブルの作り直しで、ほかのテーブルからの外部キーが消えない", () => {
  const relOf = (s: PrismaSchema, m: string, f: string) => field(model(s, m), f).relation;

  it("再現: 参照される側の作り直し (2 つ目のファイルで new_User → DROP → RENAME)", () => {
    const r = sqlFilesToPrismaDsl([
      { path: "1.sql", text: 'CREATE TABLE "User"(id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE "Post"(id INTEGER PRIMARY KEY, "authorId" INTEGER NOT NULL, FOREIGN KEY ("authorId") REFERENCES "User"(id));' },
      { path: "2.sql", text: 'CREATE TABLE "new_User"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT); DROP TABLE "User"; ALTER TABLE "new_User" RENAME TO "User";' },
    ]);
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.table)).toEqual(["Post", "User"]);
    expect(relOf(s, "Post", "author")).toEqual({ fields: ["authorId"], references: ["id"] });
    expect(field(model(s, "User"), "post")).toMatchObject({ type: "Post", isList: true });
    expect(model(s, "User").fields.map((f) => f.name)).toEqual(["id", "name", "post"]);
    expect(relationCount(s)).toBe(1);
  });

  it("参照先が最後まで見つからなければ、関連にせず notes に残す", () => {
    const r = sqlFilesToPrismaDsl([
      { path: "1.sql", text: 'CREATE TABLE "User"(id INTEGER PRIMARY KEY); CREATE TABLE "Post"(id INTEGER PRIMARY KEY, "authorId" INTEGER, FOREIGN KEY ("authorId") REFERENCES "User"(id));' },
      { path: "2.sql", text: 'DROP TABLE "User";' },
    ]);
    const s = schemaOf(r);
    expect(relationCount(s)).toBe(0);
    expect(notesText(r)).toMatch(/参照先のテーブル User が SQL にない/);
    expect(r.dsl).toContain("// 参照先: User(id)");
    expect(model(s, "Post").fields.map((f) => f.name)).toEqual(["id", "authorId"]);
  });

  it("DROP TABLE … CASCADE は、ほかのテーブルからの外部キーも消す (名前の参照に戻さない)", () => {
    const r = sqlToPrismaDsl("CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id));\nDROP TABLE a CASCADE;\nCREATE TABLE a (id int PRIMARY KEY);");
    expect(relationCount(schemaOf(r))).toBe(0);
    const r2 = sqlToPrismaDsl("CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id));\nDROP TABLE a;\nCREATE TABLE a (id int PRIMARY KEY);");
    expect(relationCount(schemaOf(r2))).toBe(1);
  });

  it("Prisma の RedefineTables (PRAGMA foreign_keys=OFF … INSERT INTO new_X SELECT … DROP TABLE → RENAME)", () => {
    const r = sqlFilesToPrismaDsl([
      {
        path: "20240101_init/migration.sql",
        text: `-- CreateTable
CREATE TABLE "User" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "email" TEXT NOT NULL);
-- CreateTable
CREATE TABLE "Post" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "authorId" INTEGER NOT NULL, "title" TEXT NOT NULL, CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE);
-- CreateTable
CREATE TABLE "Node" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "parentId" INTEGER, CONSTRAINT "Node_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Node" ("id") ON DELETE SET NULL ON UPDATE CASCADE);
-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
`,
      },
      {
        path: "20240201_user_name/migration.sql",
        text: `-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "email" TEXT NOT NULL, "name" TEXT);
INSERT INTO "new_User" ("email", "id") SELECT "email", "id" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
`,
      },
      {
        path: "20240301_post_body/migration.sql",
        text: `-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Post" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "authorId" INTEGER NOT NULL, "title" TEXT NOT NULL, "body" TEXT, CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE);
INSERT INTO "new_Post" ("authorId", "id", "title") SELECT "authorId", "id", "title" FROM "Post";
DROP TABLE "Post";
ALTER TABLE "new_Post" RENAME TO "Post";
CREATE TABLE "new_Node" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "parentId" INTEGER, "label" TEXT, CONSTRAINT "Node_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Node" ("id") ON DELETE SET NULL ON UPDATE CASCADE);
INSERT INTO "new_Node" ("id", "parentId") SELECT "id", "parentId" FROM "Node";
DROP TABLE "Node";
ALTER TABLE "new_Node" RENAME TO "Node";
PRAGMA foreign_keys=ON;
`,
      },
    ]);
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.table).sort()).toEqual(["Node", "Post", "User"]);
    // 参照される側 (User) だけを作り直しても、参照する側 (Post) が作り直されても、自己参照 (Node) も、関連が残る
    expect(relOf(s, "Post", "author")).toEqual({ fields: ["authorId"], references: ["id"] });
    expect(field(model(s, "Node"), "parent").relation).toMatchObject({ fields: ["parentId"], references: ["id"] });
    expect(relationCount(s)).toBe(2);
    expect(model(s, "User").fields.map((f) => f.name)).toEqual(["id", "email", "name", "post"]);
    expect(field(model(s, "User"), "email")).toMatchObject({ isUnique: true });
    expect(model(s, "Node").fields.map((f) => f.name)).toEqual(["id", "parentId", "label", "parent", "node"]);
    expect(notesText(r)).not.toMatch(/参照先のテーブル/);
  });

  it("Django の SQLite の作り直し (new__app_post → DROP → RENAME。参照される側 app_user も)", () => {
    const r = sqlFilesToPrismaDsl([
      {
        path: "0001_initial.sql",
        text: `BEGIN;
CREATE TABLE "app_user" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "name" varchar(50) NOT NULL);
CREATE TABLE "app_post" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "title" varchar(50) NOT NULL, "author_id" bigint NOT NULL REFERENCES "app_user" ("id") DEFERRABLE INITIALLY DEFERRED);
CREATE INDEX "app_post_author_id_1" ON "app_post" ("author_id");
COMMIT;
`,
      },
      {
        path: "0002_alter.sql",
        text: `BEGIN;
--
-- Alter field name on user
--
CREATE TABLE "new__app_user" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "name" varchar(100) NOT NULL);
INSERT INTO "new__app_user" ("id", "name") SELECT "id", "name" FROM "app_user";
DROP TABLE "app_user";
ALTER TABLE "new__app_user" RENAME TO "app_user";
--
-- Alter field title on post
--
CREATE TABLE "new__app_post" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "title" varchar(200) NOT NULL, "author_id" bigint NOT NULL REFERENCES "app_user" ("id") DEFERRABLE INITIALLY DEFERRED);
INSERT INTO "new__app_post" ("id", "title", "author_id") SELECT "id", "title", "author_id" FROM "app_post";
DROP TABLE "app_post";
ALTER TABLE "new__app_post" RENAME TO "app_post";
CREATE INDEX "app_post_author_id_2" ON "app_post" ("author_id");
COMMIT;
`,
      },
    ]);
    const s = schemaOf(r);
    expect(relOf(s, "AppPost", "author")).toEqual({ fields: ["authorId"], references: ["id"] });
    expect(attr(field(model(s, "AppPost"), "title"), "db.VarChar")?.args).toBe("200");
    expect(attr(field(model(s, "AppUser"), "name"), "db.VarChar")?.args).toBe("100");
    expect(relationCount(s)).toBe(1);
  });

  it("Alembic の batch_alter_table (_alembic_tmp_x → DROP → RENAME)", () => {
    const r = sqlFilesToPrismaDsl([
      {
        path: "a.sql",
        text: `CREATE TABLE user (id INTEGER NOT NULL, name VARCHAR(50), PRIMARY KEY (id));
CREATE TABLE post (id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (id), FOREIGN KEY(user_id) REFERENCES user (id));
`,
      },
      {
        path: "b.sql",
        text: `CREATE TABLE _alembic_tmp_user (id INTEGER NOT NULL, name VARCHAR(50), email VARCHAR(100), PRIMARY KEY (id));
INSERT INTO _alembic_tmp_user (id, name) SELECT user.id, user.name FROM user;
DROP TABLE user;
ALTER TABLE _alembic_tmp_user RENAME TO user;
CREATE TABLE _alembic_tmp_post (id INTEGER NOT NULL, user_id INTEGER NOT NULL, body TEXT, PRIMARY KEY (id), FOREIGN KEY(user_id) REFERENCES user (id));
INSERT INTO _alembic_tmp_post (id, user_id) SELECT post.id, post.user_id FROM post;
DROP TABLE post;
ALTER TABLE _alembic_tmp_post RENAME TO post;
`,
      },
    ]);
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.table).sort()).toEqual(["post", "user"]);
    expect(relOf(s, "Post", "user")).toEqual({ fields: ["userId"], references: ["id"] });
    expect(model(s, "User").fields.map((f) => f.name)).toEqual(["id", "name", "email", "post"]);
    expect(notesText(r)).not.toMatch(/参照先のテーブル/);
  });

  it("参照する側も参照される側も、1 つのファイルの中で作り直しても (旧名にリネームしてから作り直す形も)", () => {
    const r = sqlToPrismaDsl(`CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));
ALTER TABLE a RENAME TO a_old;
CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT);
DROP TABLE a_old;
`);
    const s = schemaOf(r);
    // a の改名に付いて行っていた外部キーは、a_old が消えたら、書いてあった名前 (a) の参照に戻り、新しい a に結び直される
    expect(r.tables.map((t) => t.table)).toEqual(["b", "a"]);
    expect(field(model(s, "B"), "a").relation).toEqual({ fields: ["aId"], references: ["id"] });
  });
});

describe("列の REFERENCES … ON DELETE <動作> のあとの NOT NULL・DEFAULT・UNIQUE・PRIMARY KEY を落とさない", () => {
  const ACTIONS = [
    "ON DELETE CASCADE",
    "ON DELETE RESTRICT",
    "ON DELETE NO ACTION",
    "ON DELETE SET NULL",
    "ON DELETE SET DEFAULT",
    "ON DELETE SET NULL (a_id)",
    "ON UPDATE CASCADE",
    "ON UPDATE SET NULL",
    "ON UPDATE NO ACTION",
    "ON UPDATE CASCADE ON DELETE CASCADE",
    "ON DELETE CASCADE ON UPDATE NO ACTION",
    "ON DELETE SET DEFAULT ON UPDATE RESTRICT",
    "MATCH FULL",
    "MATCH SIMPLE ON DELETE CASCADE",
    "MATCH PARTIAL ON DELETE SET DEFAULT",
    "DEFERRABLE",
    "NOT DEFERRABLE",
    "DEFERRABLE INITIALLY DEFERRED",
    "DEFERRABLE INITIALLY IMMEDIATE",
    "INITIALLY IMMEDIATE",
    "ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED",
    "MATCH FULL ON UPDATE CASCADE ON DELETE SET NULL NOT DEFERRABLE INITIALLY IMMEDIATE",
    "NOT VALID",
    "ON DELETE CASCADE NOT VALID",
    "ENFORCED",
    "NOT ENFORCED",
    "ON DELETE CASCADE NOT ENFORCED",
  ];
  const A = "CREATE TABLE a(id int PRIMARY KEY);\n";

  it("再現の SQL: ON DELETE CASCADE NOT NULL", () => {
    const s = schemaOf(sqlToPrismaDsl(`${A}CREATE TABLE b(id int PRIMARY KEY, a_id int REFERENCES a(id) ON DELETE CASCADE NOT NULL);`));
    expect(field(model(s, "B"), "aId")).toMatchObject({ type: "Int", isOptional: false });
    expect(field(model(s, "B"), "a").relation).toEqual({ fields: ["aId"], references: ["id"] });
  });

  for (const act of ACTIONS) {
    it(`列に ${act} があっても、あとの NOT NULL・DEFAULT・UNIQUE・次の列が読める`, () => {
      const s = schemaOf(sqlToPrismaDsl(`${A}CREATE TABLE b(id int PRIMARY KEY, a_id int REFERENCES a(id) ${act} NOT NULL DEFAULT 5 UNIQUE, c int NOT NULL);`));
      const b = model(s, "B");
      expect(field(b, "aId")).toMatchObject({ type: "Int", isOptional: false, isUnique: true, defaultValue: "5" });
      expect(field(b, "a").relation).toEqual({ fields: ["aId"], references: ["id"] });
      expect(field(b, "c")).toMatchObject({ isOptional: false });
      // 順番を入れ替えた書き方 (REFERENCES が最後。CONSTRAINT 名つき)
      const s2 = schemaOf(sqlToPrismaDsl(`${A}CREATE TABLE b(id int PRIMARY KEY, a_id int NOT NULL DEFAULT 5 UNIQUE CONSTRAINT fk_a REFERENCES a(id) ${act}, c int NOT NULL);`));
      expect(field(model(s2, "B"), "aId")).toMatchObject({ isOptional: false, isUnique: true, defaultValue: "5" });
      expect(field(model(s2, "B"), "a").relation).toEqual({ fields: ["aId"], references: ["id"] });
      // 主キー
      const s3 = schemaOf(sqlToPrismaDsl(`${A}CREATE TABLE b(a_id int REFERENCES a(id) ${act} PRIMARY KEY, c int);`));
      expect(field(model(s3, "B"), "aId")).toMatchObject({ isId: true });
      expect(field(model(s3, "B"), "a").relation).toEqual({ fields: ["aId"], references: ["id"] });
    });

    it(`テーブルの制約に ${act} があっても、外部キーも次の列・制約も読める`, () => {
      const s = schemaOf(sqlToPrismaDsl(`${A}CREATE TABLE b(id int PRIMARY KEY, a_id int NOT NULL, FOREIGN KEY (a_id) REFERENCES a(id) ${act}, c int NOT NULL, UNIQUE (c));`));
      const b = model(s, "B");
      expect(field(b, "a").relation).toEqual({ fields: ["aId"], references: ["id"] });
      expect(field(b, "aId")).toMatchObject({ isOptional: false });
      expect(field(b, "c")).toMatchObject({ isOptional: false, isUnique: true });
    });
  }

  it("SQLite の ON CONFLICT (1 語) のあとの NOT NULL・UNIQUE も落とさない", () => {
    const s = schemaOf(sqlToPrismaDsl("CREATE TABLE t (id INTEGER PRIMARY KEY ON CONFLICT REPLACE AUTOINCREMENT, a TEXT UNIQUE ON CONFLICT IGNORE NOT NULL, b TEXT NOT NULL ON CONFLICT ABORT UNIQUE);"));
    expect(field(model(s, "T"), "a")).toMatchObject({ isUnique: true, isOptional: false });
    expect(field(model(s, "T"), "b")).toMatchObject({ isUnique: true, isOptional: false });
    expect(field(model(s, "T"), "id")).toMatchObject({ isId: true, defaultValue: "autoincrement()" });
  });

  it("MySQL の ON UPDATE CURRENT_TIMESTAMP は今まで通り (列の ON UPDATE と外部キーの ON UPDATE を取り違えない)", () => {
    const s = schemaOf(sqlToPrismaDsl("CREATE TABLE `t` (`id` int PRIMARY KEY, `u` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, `p` int REFERENCES `t`(`id`) ON UPDATE CASCADE NOT NULL) ENGINE=InnoDB;"));
    expect(attr(field(model(s, "T"), "u"), "updatedAt")).toBeDefined();
    expect(field(model(s, "T"), "p")).toMatchObject({ isOptional: false });
  });
});

describe("制約の語で始まる項目が、偽の列にならない", () => {
  const colsOf = (sql: string) => {
    const r = sqlToPrismaDsl(sql);
    const s = schemaOf(r);
    return { r, names: s.models[0]!.fields.map((f) => f.name), m: s.models[0]! };
  };

  it("再現: UNIQUE NULLS NOT DISTINCT (a, b) (PostgreSQL 15 以降) は列 unique にならず、複合の一意になる", () => {
    const { names, m } = colsOf("CREATE TABLE t (id int PRIMARY KEY, a int, b int, UNIQUE NULLS NOT DISTINCT (a, b));");
    expect(names).toEqual(["id", "a", "b"]);
    expect(blockAttr(m, "unique").map((a) => a.args)).toEqual(["[a, b]"]);
  });

  it("UNIQUE NULLS [NOT] DISTINCT・CONSTRAINT 名つき・名前つきの UNIQUE KEY・UNIQUE NONCLUSTERED・UNIQUE INDEX 名 USING", () => {
    for (const item of ["UNIQUE NULLS DISTINCT (a, b)", "UNIQUE NULLS NOT DISTINCT (a, b)", "CONSTRAINT u1 UNIQUE NULLS NOT DISTINCT (a, b)", "UNIQUE KEY u2 (a, b)", "UNIQUE INDEX u3 (a, b)", "UNIQUE NONCLUSTERED (a, b)", "CONSTRAINT u4 UNIQUE CLUSTERED (a ASC, b DESC)", "UNIQUE INDEX u5 USING BTREE (a, b)", "UNIQUE (a, b) ON CONFLICT REPLACE"]) {
      const { names, m } = colsOf(`CREATE TABLE t (id int PRIMARY KEY, a int, b int, ${item});`);
      expect([item, names]).toEqual([item, ["id", "a", "b"]]);
      expect([item, blockAttr(m, "unique").map((a) => a.args)]).toEqual([item, ["[a, b]"]]);
    }
  });

  it("ALTER TABLE … ADD CONSTRAINT x UNIQUE NULLS NOT DISTINCT (…) も一意が落ちない。列の UNIQUE NULLS NOT DISTINCT も", () => {
    const r = sqlToPrismaDsl("CREATE TABLE t (id int PRIMARY KEY, a int, b int, c int UNIQUE NULLS NOT DISTINCT);\nALTER TABLE ONLY t ADD CONSTRAINT x UNIQUE NULLS NOT DISTINCT (a, b);\nALTER TABLE t ADD UNIQUE NULLS DISTINCT (b);");
    const s = schemaOf(r);
    const m = model(s, "T");
    expect(m.fields.map((f) => f.name)).toEqual(["id", "a", "b", "c"]);
    expect(blockAttr(m, "unique").map((a) => a.args)).toEqual(["[a, b]"]);
    expect(field(m, "b").isUnique).toBe(true);
    expect(field(m, "c").isUnique).toBe(true);
  });

  it("制約の語で始まる項目 (解釈できたもの・できなかったもの) は列にならない", () => {
    const items = [
      "PRIMARY KEY (id)",
      "PRIMARY KEY CLUSTERED (id ASC)",
      "PRIMARY KEY NONCLUSTERED (id)",
      "PRIMARY KEY USING BTREE (id)",
      "UNIQUE (a)",
      "FOREIGN KEY (a) REFERENCES t (id)",
      "CHECK (a > 0)",
      "CONSTRAINT c CHECK (a > 0)",
      "EXCLUDE USING gist (a WITH =)",
      "EXCLUDE (a WITH =)",
      "INDEX idx (a)",
      "INDEX (a)",
      "KEY k (a)",
      "KEY (a)",
      "KEY k (a) USING BTREE",
      "KEY date (a)",
      "FULLTEXT ft (a)",
      "FULLTEXT KEY ft (a)",
      "FULLTEXT INDEX ft (a)",
      "SPATIAL INDEX sp (a)",
      "SPATIAL KEY (a)",
      "PERIOD FOR SYSTEM_TIME (a, b)",
      "LIKE other INCLUDING ALL",
      // 解釈できないもの: 列にせず読み飛ばして notes に残す
      "UNIQUE",
      "UNIQUE junk",
      "PRIMARY junk (a)",
      "PRIMARY",
      "FOREIGN junk (a)",
      "CONSTRAINT c junk",
    ];
    for (const item of items) {
      const r = sqlToPrismaDsl(`CREATE TABLE t (id int PRIMARY KEY, a int, b int, ${item});`);
      const s = schemaOf(r);
      // 外部キーの項目は、関連の field (型が model の field) を足すので、列 (型が Int の field) だけを見る
      expect([item, s.models[0]!.fields.filter((f) => f.type === "Int").map((f) => f.name)]).toEqual([item, ["id", "a", "b"]]);
    }
    // 解釈できないものは notes に残る
    expect(notesText(sqlToPrismaDsl("CREATE TABLE t (id int PRIMARY KEY, UNIQUE junk, PRIMARY junk (id));"))).toMatch(/UNIQUE で始まる項目を読めなかった/);
    // ALTER TABLE … ADD の中でも
    const r = sqlToPrismaDsl("CREATE TABLE t (id int PRIMARY KEY, a int);\nALTER TABLE t ADD UNIQUE junk;\nALTER TABLE t ADD KEY k (a);\nALTER TABLE t ADD FULLTEXT KEY f (a);");
    expect(schemaOf(r).models[0]!.fields.map((f) => f.name)).toEqual(["id", "a"]);
  });

  it("本当にその名前の列 (引用符付き・バッククォート・[ ]・引用符なし) は列として読む", () => {
    const { names, m } = colsOf(`CREATE TABLE \`t\` (
  \`id\` int PRIMARY KEY,
  \`index\` int,
  \`key\` int,
  "unique" int,
  [primary] int,
  key2 int,
  period int,
  \`period2\` int,
  \`like\` int,
  \`check\` int
) ENGINE=InnoDB;`);
    expect(names).toEqual(["id", "index", "key", "unique", "primary", "key2", "period", "period2", "like", "check"]);
    expect(field(m, "key")).toMatchObject({ type: "Int" });
    // 引用符なしの key・index・fulltext・spatial・exclude・check・period (型が続く) も列
    const un = colsOf("CREATE TABLE t (id int PRIMARY KEY, key int, index int, fulltext text, spatial text, exclude text, check int, period int, key varchar(10) NOT NULL);");
    expect(un.names).toEqual(["id", "key", "index", "fulltext", "spatial", "exclude", "check", "period"]);
  });

  it("ALTER TABLE ADD COLUMN key int も列 (COLUMN があれば制約の語でも列)", () => {
    const r = sqlToPrismaDsl("CREATE TABLE t (id int PRIMARY KEY);\nALTER TABLE t ADD COLUMN key int;\nALTER TABLE t ADD COLUMN index int;\nALTER TABLE t ADD COLUMN unique int;");
    expect(schemaOf(r).models[0]!.fields.map((f) => f.name)).toEqual(["id", "key", "index", "unique"]);
  });
});

describe("# を行コメントにするのは MySQL だけ", () => {
  it("再現 (pg_dump の形): #>> のある生成列のあとの列が消えない", () => {
    const r = sqlToPrismaDsl("CREATE TABLE public.docs (\n id bigint NOT NULL,\n title text GENERATED ALWAYS AS ((data #>> '{a}'::text[])) STORED,\n owner_id bigint NOT NULL\n);");
    const s = schemaOf(r);
    expect(s.models[0]!.fields.map((f) => f.name)).toEqual(["id", "title", "ownerId"]);
    // 生成列であることを行末のコメントに残す
    expect(r.dsl).toMatch(/title\s+String\?\s+\/\/ 生成列/);
    expect(field(s.models[0]!, "ownerId")).toMatchObject({ isOptional: false });
  });

  it("PostgreSQL の #>・#-・# (XOR) でも行の残りが消えない", () => {
    for (const op of ["#>", "#>>", "#-", "#", "##", "#<=>"]) {
      const sql = `CREATE TABLE a (id int, c int GENERATED ALWAYS AS (x ${op} y) STORED, d int NOT NULL);\nCREATE TABLE b (id int);`;
      const r = sqlToPrismaDsl(`${sql}\nSELECT 1::int;`);
      expect([op, r.tables.map((t) => t.table)]).toEqual([op, ["a", "b"]]);
      expect([op, schemaOf(r).models[0]!.fields.map((f) => f.name)]).toEqual([op, ["id", "c", "d"]]);
    }
  });

  it("SQL Server の #tmp のあとのテーブルが消えない", () => {
    const r = sqlToPrismaDsl("CREATE TABLE #tmp (id int);\nCREATE TABLE ##g (id int);\nSELECT * INTO #x FROM a;\nCREATE TABLE [dbo].[a] (id int PRIMARY KEY);\nGO\nCREATE TABLE [dbo].[b] (id int PRIMARY KEY);\nGO\n");
    expect(r.tables.map((t) => t.table)).toEqual(["a", "b"]);
    expect(notesText(r)).toContain("SQL Server の一時テーブル (#名前) 2 件");
    // 方言を決められないときも
    expect(sqlToPrismaDsl("CREATE TABLE #tmp (id int); CREATE TABLE a (id int);").tables.map((t) => t.table)).toEqual(["a"]);
  });

  it("MySQL では今まで通り # は行コメント", () => {
    const r = sqlToPrismaDsl("CREATE TABLE `a` (\n  `id` int, # CREATE TABLE ghost (id int);\n  `n` int # 後ろのコメント\n) ENGINE=InnoDB;\nCREATE TABLE `b` (`id` int);");
    expect(r.tables.map((t) => t.table)).toEqual(["a", "b"]);
    expect(schemaOf(r).models[0]!.fields.map((f) => f.name)).toEqual(["id", "n"]);
  });
});

describe("入れ子のコメントを当てるのは PostgreSQL と判定したときだけ", () => {
  it("再現: SQLite の PRAGMA のあとの /* tables for src/*.ts */ で、残りが全部コメントにならない", () => {
    const r = sqlToPrismaDsl("PRAGMA foreign_keys=ON;\n/* tables for src/*.ts */\nCREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT);");
    expect(r.tables.map((t) => t.table)).toEqual(["a"]);
    schemaOf(r);
  });

  it("MySQL・SQL Server・方言が決められないときも入れ子にしない", () => {
    expect(sqlToPrismaDsl("/* src/*.ts */\nCREATE TABLE `a` (`id` int) ENGINE=InnoDB;").tables).toHaveLength(1);
    expect(sqlToPrismaDsl("/* src/*.ts */\nCREATE TABLE [dbo].[a] ([id] int)\nGO\n").tables).toHaveLength(1);
    expect(sqlToPrismaDsl("/* tables for src/*.ts */\nCREATE TABLE a (id int);").tables).toHaveLength(1);
    // 入れ子にしないので、最初の */ で閉じる
    expect(sqlToPrismaDsl("/* a /* b */ CREATE TABLE a (id int); /* c */").tables.map((t) => t.table)).toEqual(["a"]);
  });

  it("PostgreSQL では入れ子にする。ただし閉じないまま終わりまで行くなら、入れ子なしで読み直す", () => {
    const pg = "-- PostgreSQL database dump\n";
    expect(sqlToPrismaDsl(`${pg}/* a /* b */ CREATE TABLE ghost (id int); */ CREATE TABLE a (id int);`).tables.map((t) => t.table)).toEqual(["a"]);
    // 目印の無い手書きのファイルで PostgreSQL と推定されて (SERIAL)、/* src/*.ts */ がある
    const hand = sqlToPrismaDsl("/* tables for src/*.ts */\nCREATE TABLE a (id SERIAL PRIMARY KEY);\nCREATE TABLE b (id SERIAL PRIMARY KEY);");
    expect(hand.tables.map((t) => t.table)).toEqual(["a", "b"]);
    // 開きが 3 つ・閉じが 1 つ (入れ子では閉じない) でも、残りが全部消えない
    const odd = sqlToPrismaDsl(`${pg}/* x /* y /* z */ CREATE TABLE a (id int);\n/* p /* q /* r */ CREATE TABLE b (id int);`);
    expect(odd.tables.map((t) => t.table)).toEqual(["a", "b"]);
  });
});

describe("DROP INDEX は、指したテーブルの一意制約だけを消す", () => {
  const U = "CREATE TABLE `users` (`id` int PRIMARY KEY, `email` varchar(9), UNIQUE KEY `email` (`email`));\nCREATE TABLE `admins` (`id` int PRIMARY KEY, `email` varchar(9), UNIQUE KEY `email` (`email`));\n";
  const uniq = (r: SqlImportResult, m: string) => field(model(schemaOf(r), m), "email").isUnique;

  it("再現: MySQL の DROP INDEX x ON t は t だけ (users の @unique が消えない)", () => {
    const r = sqlToPrismaDsl(`${U}DROP INDEX \`email\` ON \`admins\`;`);
    expect(uniq(r, "Users")).toBe(true);
    expect(uniq(r, "Admins")).toBe(false);
    expect(sqlToPrismaDsl(`${U}DROP INDEX email ON users ALGORITHM=INPLACE;`).dsl).toMatch(/Admins[\s\S]*@unique/);
  });

  it("ON のテーブルが無い・別名のとき、何も消さない", () => {
    expect(uniq(sqlToPrismaDsl(`${U}DROP INDEX \`email\` ON \`nothere\`;`), "Users")).toBe(true);
    expect(uniq(sqlToPrismaDsl(`${U}DROP INDEX \`email\` ON \`nothere\`;`), "Admins")).toBe(true);
    expect(uniq(sqlToPrismaDsl(`${U}DROP INDEX \`other\` ON \`admins\`;`), "Admins")).toBe(true);
  });

  it("ALTER TABLE t DROP INDEX / DROP KEY / DROP CONSTRAINT も、そのテーブルの中だけ", () => {
    for (const drop of ["DROP INDEX `email`", "DROP KEY `email`", "DROP CONSTRAINT `email`"]) {
      const r = sqlToPrismaDsl(`${U}ALTER TABLE \`admins\` ${drop};`);
      expect([drop, uniq(r, "Users")]).toEqual([drop, true]);
      expect([drop, uniq(r, "Admins")]).toEqual([drop, false]);
    }
  });

  it("外部キーの DROP FOREIGN KEY / DROP CONSTRAINT も、そのテーブルの中だけ (同じ名前の外部キーがほかにあっても)", () => {
    const sql = "CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE a (id int PRIMARY KEY, p_id int, CONSTRAINT fk FOREIGN KEY (p_id) REFERENCES p(id));\nCREATE TABLE b (id int PRIMARY KEY, p_id int, CONSTRAINT fk FOREIGN KEY (p_id) REFERENCES p(id));\n";
    const s1 = schemaOf(sqlToPrismaDsl(`${sql}ALTER TABLE b DROP FOREIGN KEY fk;`));
    expect(field(model(s1, "A"), "p").relation).toBeDefined();
    expect(model(s1, "B").fields.some((f) => f.relation)).toBe(false);
    const s2 = schemaOf(sqlToPrismaDsl(`${sql}ALTER TABLE a DROP CONSTRAINT fk;`));
    expect(model(s2, "A").fields.some((f) => f.relation)).toBe(false);
    expect(field(model(s2, "B"), "p").relation).toBeDefined();
  });

  it("PostgreSQL の DROP INDEX 名前 (インデックスの名前はスキーマで一意): 名前の一意制約を消す。スキーマ名つきならそのスキーマだけ", () => {
    const pg = "-- PostgreSQL database dump\nCREATE TABLE public.users (id int PRIMARY KEY, email text);\nCREATE TABLE audit.users (id int PRIMARY KEY, email text);\nCREATE UNIQUE INDEX users_email ON public.users (email);\nCREATE UNIQUE INDEX users_email ON audit.users (email);\n";
    const dropped = (sql: string) => {
      const r = sqlToPrismaDsl(sql);
      const s = schemaOf(r);
      return s.models.map((m) => [m.name, field(m, "email").isUnique] as const);
    };
    expect(dropped(`${pg}DROP INDEX audit.users_email;`)).toEqual([["Users", true], ["Users2", false]]);
    expect(dropped(`${pg}DROP INDEX public.users_email;`)).toEqual([["Users", false], ["Users2", true]]);
    // スキーマ名なしは、標準のスキーマ (public) を先に
    expect(dropped(`${pg}DROP INDEX users_email;`)).toEqual([["Users", false], ["Users2", true]]);
    // 標準のスキーマに無ければ、どのスキーマのものも
    expect(dropped("-- PostgreSQL database dump\nCREATE TABLE audit.users (id int PRIMARY KEY, email text);\nCREATE UNIQUE INDEX ux ON audit.users (email);\nDROP INDEX ux;")).toEqual([["Users", false]]);
    // 複数を 1 文で、IF EXISTS・CONCURRENTLY
    expect(dropped(`${pg}DROP INDEX CONCURRENTLY IF EXISTS public.users_email, audit.users_email;`)).toEqual([["Users", false], ["Users2", false]]);
  });
});

describe("方言の推定は、コメントと文字列を除いた部分で、複数の目印に重みを付けて行う", () => {
  it("再現: 文字列やコメントの中のバッククォートで MySQL と判定されて、バックスラッシュを飲み込まない (ヘッダーの無い PostgreSQL)", () => {
    const r = sqlToPrismaDsl("CREATE TABLE files(id serial PRIMARY KEY, path text DEFAULT 'C:\\'); COMMENT ON TABLE files IS 'see `docs`'; CREATE TABLE users(id serial PRIMARY KEY); CREATE TABLE posts(id serial PRIMARY KEY);");
    expect(r.tables.map((t) => t.table)).toEqual(["files", "users", "posts"]);
    expect(field(model(schemaOf(r), "Files"), "path").defaultValue).toBe('"C:\\\\"');
    expect(notesText(r)).not.toContain("読み直し");
  });

  it("コメントの中の UNSIGNED・AUTO_INCREMENT・ENGINE= や、文字列の中の ` では MySQL にならない", () => {
    const sql = "-- ENGINE=InnoDB AUTO_INCREMENT UNSIGNED `x`\n/* LOCK TABLES `x` */\nCREATE TABLE a (id serial PRIMARY KEY, p text DEFAULT 'a\\', q text DEFAULT 'UNSIGNED `b` ENGINE=');\nCREATE TABLE b (id serial PRIMARY KEY);\nCREATE TABLE c (id serial PRIMARY KEY);";
    expect(sqlToPrismaDsl(sql).tables.map((t) => t.table)).toEqual(["a", "b", "c"]);
  });

  it("逆向き: 目印の無い MySQL (DEFAULT 'it\\'s') も、残りを飲み込まない (閉じない文字列はエスケープを変えて読み直し、notes に残す)", () => {
    const r = sqlToPrismaDsl("CREATE TABLE a (id int PRIMARY KEY, n varchar(9) DEFAULT 'it\\'s');\nCREATE TABLE b (id int PRIMARY KEY);\nCREATE TABLE c (id int PRIMARY KEY);");
    expect(r.tables.map((t) => t.table)).toEqual(["a", "b", "c"]);
    expect(field(model(schemaOf(r), "A"), "n").defaultValue).toBe(`"it's"`);
    const note = r.notes.find((n) => n.message.includes("読み直しました"));
    expect(note).toMatchObject({ line: 1 });
  });

  it("どの方言でも、閉じない文字列で終わりまで飲まれる前に、変えて読み直す。読み直しても閉じなければ元のまま", () => {
    // PostgreSQL と推定されたが、バックスラッシュのエスケープを使う書き方 (E なし)
    const pgish = "CREATE TABLE a (id serial PRIMARY KEY, n text DEFAULT 'it\\'s');\nCREATE TABLE b (id serial PRIMARY KEY);";
    expect(sqlToPrismaDsl(pgish).tables.map((t) => t.table)).toEqual(["a", "b"]);
    // どちらの読み方でも閉じない: 今まで通り終わりまで (1 文だけ) が文字列
    const r = sqlToPrismaDsl("CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int, x text DEFAULT 'abc);\nCREATE TABLE c (id int);");
    expect(r.tables.map((t) => t.table)).toEqual(["a", "b"]);
    expect(notesText(r)).not.toContain("読み直しました");
    // MySQL と推定されて (ENGINE=) 閉じない: 標準の読み方で閉じるなら読み直す
    const my = sqlToPrismaDsl("CREATE TABLE `a` (`id` int, `p` varchar(9) DEFAULT 'C:\\') ENGINE=InnoDB;\nCREATE TABLE `b` (`id` int) ENGINE=InnoDB;");
    expect(my.tables.map((t) => t.table)).toEqual(["a", "b"]);
    expect(notesText(my)).toContain("読み直しました");
  });

  it("極端に長く続く文字列 (閉じるが 100 万文字を超える) も、短く閉じる読み方があるなら読み直す。データの文では読み直さない", () => {
    const filler = "x".repeat(1_100_000);
    const r = sqlToPrismaDsl(`CREATE TABLE a (id serial PRIMARY KEY, n text DEFAULT 'it\\'s');\nCREATE TABLE b (id serial PRIMARY KEY);\n-- ${filler}\nCREATE TABLE c (id serial PRIMARY KEY, n text DEFAULT 'q');`);
    expect(r.tables.map((t) => t.table)).toEqual(["a", "b", "c"]);
    // MySQL のデータの INSERT (長い文字列 + \') は、読み直さない
    const my = sqlToPrismaDsl(`CREATE TABLE \`a\` (\`id\` int) ENGINE=InnoDB;\nINSERT INTO a VALUES ('${filler}\\'z');\nCREATE TABLE \`b\` (\`id\` int) ENGINE=InnoDB;`);
    expect(my.tables.map((t) => t.table)).toEqual(["a", "b"]);
    expect(notesText(my)).not.toContain("読み直しました");
  });

  it("ヘッダーと目印: pg_dump・mysqldump・SQLite・SQL Server の方言を取り違えない", () => {
    // 引用符なしの名前の小文字化は PostgreSQL のときだけ見える
    const pgLower = (sql: string) => sqlToPrismaDsl(sql).tables[0]!.model;
    expect(sqlToPrismaDsl("-- PostgreSQL database dump\nCREATE TABLE Users (Id int PRIMARY KEY);").dsl).toContain('@@map("users")');
    expect(sqlToPrismaDsl("-- PostgreSQL database dump\nCREATE TABLE Users (Id int PRIMARY KEY);").dsl).not.toContain('@map("Id")');
    expect(sqlToPrismaDsl("-- MySQL dump 10.13\nCREATE TABLE Users (Id int PRIMARY KEY);").dsl).toContain('@map("Id")');
    expect(sqlToPrismaDsl("PRAGMA foreign_keys=ON;\nCREATE TABLE Users (Id int PRIMARY KEY);").dsl).toContain('@map("Id")');
    expect(sqlToPrismaDsl("SET ANSI_NULLS ON\nGO\nCREATE TABLE [dbo].[Users] ([Id] int PRIMARY KEY)\nGO\n").dsl).toContain('@map("Id")');
    expect(pgLower("CREATE TABLE Users (Id int PRIMARY KEY);")).toBe("Users");
    expect(sqlToPrismaDsl("CREATE TABLE Users (Id int PRIMARY KEY);").dsl).toContain('@map("Id")');
    // 重みの大きい目印が勝つ (SQLite の AUTOINCREMENT があれば、バッククォートがあっても SQLite)
    expect(sqlToPrismaDsl("CREATE TABLE `Users` (`Id` integer PRIMARY KEY AUTOINCREMENT);").dsl).toContain("autoincrement()");
  });
});

describe("PostgreSQL の引用符なしの名前は小文字にする", () => {
  it("再現: CREATE TABLE Users (Id serial PRIMARY KEY) は、実際の名前 users・id になる", () => {
    const r = sqlToPrismaDsl("CREATE TABLE Users (Id serial PRIMARY KEY, Name text, CreatedAt timestamptz);");
    const s = schemaOf(r);
    expect(s.models[0]!.mapName).toBe("users");
    expect(r.tables[0]).toMatchObject({ table: "users", model: "Users" });
    expect(s.models[0]!.fields.map((f) => [f.name, f.mapName])).toEqual([["id", undefined], ["name", undefined], ["createdAt", "createdat"]]);
  });

  it("引用符つきの名前はそのまま。参照・ALTER・COMMENT も大文字小文字を区別せずに結ぶ", () => {
    const r = sqlToPrismaDsl('CREATE TABLE "Users" ("Id" serial PRIMARY KEY, Email text);\nCREATE TABLE Posts (Id serial PRIMARY KEY, UserId int REFERENCES USERS("Id"));\nALTER TABLE ONLY "Users" ADD COLUMN Age int;\nCOMMENT ON COLUMN Users.Email IS \'メール\';');
    const s = schemaOf(r);
    expect(r.tables.map((t) => t.table)).toEqual(["Users", "posts"]);
    expect(model(s, "Users").mapName).toBeUndefined();
    expect(field(model(s, "Users"), "id")).toMatchObject({ mapName: "Id" });
    expect(model(s, "Users").fields.map((f) => f.name)).toEqual(expect.arrayContaining(["email", "age", "posts"]));
    // field の名前はもとの綴り (UserId) から作り、実際の名前 (小文字の userid) は @map に出す
    expect(field(model(s, "Posts"), "userId")).toMatchObject({ mapName: "userid" });
    expect(field(model(s, "Posts"), "user").relation).toEqual({ fields: ["userId"], references: ["id"] });
    expect(r.dsl).toMatch(/email\s+String\?\s+\/\/ メール/);
  });

  it("MySQL・SQLite・SQL Server・方言が決められないときはそのまま", () => {
    const names = (sql: string) => sqlToPrismaDsl(sql).tables.map((t) => t.table);
    expect(names("CREATE TABLE Users (Id int PRIMARY KEY) ENGINE=InnoDB;")).toEqual(["Users"]);
    expect(names("CREATE TABLE Users (Id integer PRIMARY KEY AUTOINCREMENT);")).toEqual(["Users"]);
    expect(names("CREATE TABLE dbo.Users (Id int IDENTITY(1,1) PRIMARY KEY)\nGO\n")).toEqual(["Users"]);
    expect(names("CREATE TABLE Users (Id int PRIMARY KEY);")).toEqual(["Users"]);
  });
});

describe("SQL Server (SSMS) のスクリプト", () => {
  const r = sqlToPrismaDsl(SQLSERVER_SCRIPT);
  const s = schemaOf(r);

  it("WITH CHECK ADD CONSTRAINT … FOREIGN KEY が読み飛ばされず、関連になる。WITH NOCHECK も", () => {
    expect(r.tables.map((t) => t.table)).toEqual(["Customers", "Orders"]);
    expect(field(model(s, "Orders"), "customer").relation).toEqual({ fields: ["customerID"], references: ["customerID"] });
    const nocheck = sqlToPrismaDsl("CREATE TABLE [dbo].[A] ([Id] int PRIMARY KEY)\nGO\nCREATE TABLE [dbo].[B] ([Id] int PRIMARY KEY, [AId] int NOT NULL)\nGO\nALTER TABLE [dbo].[B] WITH NOCHECK ADD CONSTRAINT [FK_B_A] FOREIGN KEY ([AId]) REFERENCES [dbo].[A] ([Id])\nGO\n");
    expect(relationCount(schemaOf(nocheck))).toBe(1);
  });

  it("PRIMARY KEY CLUSTERED / NONCLUSTERED・UNIQUE NONCLUSTERED・WITH (PAD_INDEX = OFF, …) ON [PRIMARY]・列の ASC / DESC で、主キー・一意が落ちない", () => {
    expect(field(model(s, "Customers"), "customerID")).toMatchObject({ isId: true, defaultValue: "autoincrement()" });
    expect(field(model(s, "Customers"), "email")).toMatchObject({ isUnique: true, isOptional: true });
    expect(field(model(s, "Orders"), "orderID")).toMatchObject({ isId: true });
    expect(r.notes.some((n) => n.message.includes("主キーがありません"))).toBe(false);
  });

  it("CHECK CONSTRAINT [FK_…] (制約を有効にする文) は読み飛ばす。DEFAULT … FOR は列の DEFAULT になる", () => {
    expect(notesText(r)).toContain("制約の有効・無効 (CHECK / NOCHECK CONSTRAINT) 1 件");
    expect(field(model(s, "Orders"), "created")).toMatchObject({ type: "DateTime", defaultValue: "now()" });
    expect(relationCount(s)).toBe(1);
  });

  it("nvarchar は @db.NVarChar、nchar は @db.NChar", () => {
    expect(attr(field(model(s, "Customers"), "name"), "db.NVarChar")?.args).toBe("100");
    expect(attr(field(model(s, "Customers"), "code"), "db.NChar")?.args).toBe("5");
    expect(attr(field(model(s, "Orders"), "note"), "db.NVarChar")).toBeDefined();
    expect(attr(field(model(s, "Customers"), "name"), "db.VarChar")).toBeUndefined();
  });

  it("文の外の GO・かっこの中の列名 go (go だけの行) は区切りにしない", () => {
    expect(sqlToPrismaDsl("CREATE TABLE a (id int);\nGO\nCREATE TABLE b (id int);\nGO\n").tables.map((t) => t.table)).toEqual(["a", "b"]);
    const r2 = sqlToPrismaDsl("CREATE TABLE a (\n  id int,\n  go\n);\nCREATE TABLE b (\n  id int,\n  GO\n  ,\n  x int\n);");
    expect(r2.tables.map((t) => t.table)).toEqual(["a", "b"]);
    expect(schemaOf(r2).models[0]!.fields.map((f) => f.name)).toEqual(["id", "go"]);
    expect(schemaOf(r2).models[1]!.fields.map((f) => f.name)).toEqual(["id", "go", "x"]);
  });
});

describe("INHERITS とパーティション", () => {
  const pg = "-- PostgreSQL database dump\n";

  it("INHERITS (親) の子は、親の列を先頭に写して notes に残す。親が先に無ければ、写せないことを notes に残す", () => {
    const r = sqlToPrismaDsl(`${pg}CREATE TABLE public.parent (id integer NOT NULL, name text);\nCREATE TABLE public.child (extra integer) INHERITS (public.parent);\nCREATE TABLE public.orphan (x int) INHERITS (public.missing);\nCREATE TABLE public.dup (id bigint, y int) INHERITS (parent, other);`);
    const s = schemaOf(r);
    expect(model(s, "Child").fields.map((f) => f.name)).toEqual(["id", "name", "extra"]);
    expect(model(s, "Dup").fields.map((f) => f.name)).toEqual(["name", "id", "y"]);
    expect(model(s, "Orphan").fields.map((f) => f.name)).toEqual(["x"]);
    const msgs = messages(r);
    expect(msgs.some((m) => m.includes("child は INHERITS (parent) です。親の列を先頭に写しました"))).toBe(true);
    expect(msgs.some((m) => m.includes("orphan は INHERITS (missing) ですが、親のテーブルが先に定義されていない"))).toBe(true);
    expect(r.notes.find((n) => n.message.includes("child は INHERITS"))).toMatchObject({ line: 3 });
  });

  it("パーティションの子 (PARTITION OF・ATTACH PARTITION) は model にせず、読み飛ばして notes に 1 件にまとめる", () => {
    const sql = `${pg}CREATE TABLE public.measurement (id int NOT NULL, logdate date NOT NULL) PARTITION BY RANGE (logdate);
CREATE TABLE public.measurement_y2024 (id int NOT NULL, logdate date NOT NULL);
CREATE TABLE public.measurement_y2025 (id int NOT NULL, logdate date NOT NULL);
ALTER TABLE ONLY public.measurement ATTACH PARTITION public.measurement_y2024 FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
ALTER TABLE ONLY public.measurement ATTACH PARTITION public.measurement_y2025 FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE public.measurement_y2026 PARTITION OF public.measurement FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE public.other (id int PRIMARY KEY);
`;
    const r = sqlToPrismaDsl(sql);
    schemaOf(r);
    expect(r.tables.map((t) => t.table)).toEqual(["measurement", "other"]);
    const notes = r.notes.filter((n) => n.message.includes("パーティションの子"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("3 個");
    expect(notes[0]!.message).toContain("measurement_y2024");
  });

  it("パーティションが多くても notes は 1 件", () => {
    let sql = `${pg}CREATE TABLE public.m (id int, d date) PARTITION BY RANGE (d);\n`;
    for (let i = 0; i < 500; i++) sql += `CREATE TABLE public.m_${i} (id int, d date);\nALTER TABLE ONLY public.m ATTACH PARTITION public.m_${i} FOR VALUES FROM (${i}) TO (${i + 1});\n`;
    for (let i = 0; i < 500; i++) sql += `CREATE TABLE public.p_${i} PARTITION OF public.m FOR VALUES FROM (${1000 + i}) TO (${1001 + i});\n`;
    const r = sqlToPrismaDsl(sql);
    expect(r.tables.map((t) => t.table)).toEqual(["m"]);
    expect(r.notes.filter((n) => n.message.includes("パーティションの子"))).toHaveLength(1);
    expect(r.notes.filter((n) => n.message.includes("パーティションの子"))[0]!.message).toContain("1000 個");
  });
});

describe("テーブル数・enum 数の上限は、生きているものの数で見る", () => {
  it("再現: 2600 テーブルをそれぞれ作り直しても (new_x → DROP → RENAME)、2600 出る", () => {
    const parts: string[] = [];
    for (let i = 0; i < 2600; i++) parts.push(`CREATE TABLE "t${i}" (id INTEGER PRIMARY KEY);`);
    for (let i = 0; i < 2600; i++) parts.push(`CREATE TABLE "new_t${i}" (id INTEGER PRIMARY KEY, n TEXT);\nDROP TABLE "t${i}";\nALTER TABLE "new_t${i}" RENAME TO "t${i}";`);
    const r = sqlToPrismaDsl(parts.join("\n"));
    expect(r.tables).toHaveLength(2600);
    expect(r.dslErrors).toEqual([]);
    expect(notesText(r)).not.toContain("上限");
    expect(parsePrismaDsl(r.dsl).models[0]!.fields.map((f) => f.name)).toContain("n");
  });

  it("再現: 5000 テーブルのあとに CREATE TABLE t0 を書き直しても、t0 が消えない (新しい定義になる)。5001 個目は読まない", () => {
    let sql = "";
    for (let i = 0; i < SQL_IMPORT_LIMITS.maxTables; i++) sql += `CREATE TABLE t${i} (id int);\n`;
    sql += "CREATE TABLE t0 (id int PRIMARY KEY, replaced text);\nCREATE TABLE extra (id int);\n";
    const r = sqlToPrismaDsl(sql);
    const n = SQL_IMPORT_LIMITS.maxTables;
    // t0 の書き直しは置き換えとして読まれ (上限の注記は出ない)、上限の注記は 5001 個目 (extra) の行に出る
    expect(r.notes.find((x) => x.message.includes("テーブル t0 をもう一度作っています"))).toMatchObject({ line: n + 1 });
    expect(r.notes.filter((x) => x.message.includes("テーブルの数が上限"))).toEqual([expect.objectContaining({ line: n + 2 })]);
    // 出力の DSL は上限で切られるので、全部は出ない
    expect(r.dslErrors).toEqual([]);
    // 5000 個に収まる (大きさの上限に掛からない) 小さい入力で、置き換えた t0 の定義が使われることも確かめる
    const small = sqlToPrismaDsl("CREATE TABLE t0 (id int);\nCREATE TABLE t1 (id int);\nCREATE TABLE t0 (id int PRIMARY KEY, replaced text);");
    expect(small.tables.map((t) => t.table)).toEqual(["t1", "t0"]);
  });

  it("DROP したテーブルは数えない: 作って消してを上限より多く繰り返しても、読み続ける", () => {
    let sql = "";
    for (let i = 0; i < SQL_IMPORT_LIMITS.maxTables + 500; i++) sql += `CREATE TABLE tmp (id int);\nDROP TABLE tmp;\n`;
    sql += "CREATE TABLE last_one (id int);";
    const r = sqlToPrismaDsl(sql);
    expect(r.tables.map((t) => t.table)).toEqual(["last_one"]);
    expect(notesText(r)).not.toContain("上限");
  });

  it("enum の数の上限を超えたときの注記は 1 回だけ。消した enum は数えない", () => {
    let sql = "";
    for (let i = 0; i < SQL_IMPORT_LIMITS.maxEnums + 300; i++) sql += `CREATE TYPE e${i} AS ENUM ('a');\n`;
    const r = sqlToPrismaDsl(sql + "CREATE TABLE t (id int);");
    expect(r.notes.filter((n) => n.message.includes("enum の数が上限"))).toHaveLength(1);
    let sql2 = "";
    for (let i = 0; i < SQL_IMPORT_LIMITS.maxEnums + 300; i++) sql2 += `CREATE TYPE e AS ENUM ('a');\nDROP TYPE e;\n`;
    const r2 = sqlToPrismaDsl(`${sql2}CREATE TYPE keep AS ENUM ('a');\nCREATE TABLE t (id int, k keep);`);
    expect(notesText(r2)).not.toContain("enum の数が上限");
    expect(r2.enums).toEqual(["Keep"]);
  });
});

describe("そのほか", () => {
  it("生成列 (GENERATED ALWAYS AS (…) / AS (…) / MySQL の VIRTUAL・STORED) は、生成列であることを行末のコメントに残す", () => {
    const r = sqlToPrismaDsl("CREATE TABLE `t` (`id` int PRIMARY KEY, `a` int, `b` int GENERATED ALWAYS AS (`a` * 2) STORED, `c` int AS (`a` + 1) VIRTUAL, `d` int COMMENT 'メモ') ENGINE=InnoDB;");
    const s = schemaOf(r);
    expect(r.dsl).toMatch(/b\s+Int\?\s+\/\/ 生成列/);
    expect(r.dsl).toMatch(/c\s+Int\?\s+\/\/ 生成列/);
    expect(r.dsl).not.toMatch(/d\s+Int\?\s+\/\/ 生成列/);
    expect(s.models[0]!.fields.map((f) => f.name)).toEqual(["id", "a", "b", "c", "d"]);
  });

  it("MySQL の MODIFY・CHANGE で COMMENT・DEFAULT を省いたら、古い COMMENT・DEFAULT は消える", () => {
    const sql = "CREATE TABLE `t` (`id` int PRIMARY KEY, `a` varchar(10) NOT NULL DEFAULT 'x' COMMENT '古い', `b` int COMMENT '古い b', `c` int COMMENT '残す') ENGINE=InnoDB;\nALTER TABLE `t` MODIFY `a` varchar(20) NOT NULL;\nALTER TABLE `t` CHANGE `b` `b2` bigint NULL;\nALTER TABLE `t` MODIFY `c` int COMMENT '新しい';";
    const r = sqlToPrismaDsl(sql);
    const s = schemaOf(r);
    expect(r.dsl).not.toContain("古い");
    expect(field(model(s, "T"), "a").defaultValue).toBeUndefined();
    expect(field(model(s, "T"), "a")).toMatchObject({ isOptional: false });
    expect(r.dsl).toMatch(/c\s+Int\?\s+\/\/ 新しい/);
    expect(model(s, "T").fields.map((f) => f.name)).toEqual(["id", "a", "b2", "c"]);
  });
});

describe("閉じない・繰り返しの入力が 2 乗にならない (レビューで見つかった形そのもの)", () => {
  const timeOf = (sql: string): number => {
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      sqlToPrismaDsl(sql);
      best = Math.min(best, Date.now() - t0);
    }
    return best;
  };
  /**
   * 大きさ n と 4n の同じ形の入力で、4n の時間が (n の時間の 4 倍の、2.5 倍まで余裕を見た) 10 倍に収まり、
   * かつ 4n が abs ミリ秒以内であること。2 乗なら 16 倍になり、直す前は 4n が数秒〜数十秒かかる
   */
  function expectLinear(label: string, make: (n: number) => string, n: number, abs: number) {
    sqlToPrismaDsl(make(Math.ceil(n / 8)));
    const small = make(n);
    const big = make(4 * n);
    const a = timeOf(small);
    const t0 = Date.now();
    sqlToPrismaDsl(big);
    const b = Date.now() - t0;
    expect([label, b < abs]).toEqual([label, true]);
    expect([label, b < Math.max(a, 25) * 10]).toEqual([label, true]);
  }

  it("閉じていない /* がたくさん ('/* '.repeat(n))。直す前は 120KB で 7 秒・240KB で 29 秒", () => {
    expectLinear("/* ", (n) => "/* ".repeat(n), 20_000, 1500);
    expectLinear("pg /* ", (n) => `-- PostgreSQL database dump\n${"/* ".repeat(n)}`, 20_000, 1500);
    // 開きが閉じより多い形を何度も (入れ子では閉じない)
    expectLinear("/* /* */", (n) => `-- PostgreSQL database dump\n${"/* /* */ CREATE TABLE a (id int);\n".repeat(n)}`, 3_000, 3000);
    // 結果も正しい: 閉じていなければ残りはコメント
    expect(sqlToPrismaDsl("CREATE TABLE a (id int);\n/* ".repeat(1).concat("/* ".repeat(1000))).tables.map((t) => t.table)).toEqual(["a"]);
  });

  it("閉じていない [ がたくさん。直す前は 2MB で 15 秒・16MB で 24 秒", () => {
    expectLinear("[ ", (n) => `CREATE TABLE t (a int ${" [".repeat(n)}`, 250_000, 2000);
    expectLinear("SELECT [aaa…\\n", (n) => ("SELECT [" + "a".repeat(150) + "\n").repeat(n), 25_000, 3000);
    // 閉じる ] が 200 文字より先にあるものは名前にしない・近ければ名前
    const r = sqlToPrismaDsl(`CREATE TABLE [a] ([${"x".repeat(150)}] int, [${"y".repeat(300)}] int);`);
    expect(r.tables[0]!.table).toBe("a");
  });

  it("同じテーブルへの ADD CONSTRAINT … FOREIGN KEY と DROP CONSTRAINT の繰り返し。直す前は 10 万回 + 5 万回で 161 秒", () => {
    const make = (n: number) => {
      const out = ["CREATE TABLE p (id int PRIMARY KEY);", "CREATE TABLE t (id int PRIMARY KEY, a int);"];
      for (let i = 0; i < 2 * n; i++) out.push(`ALTER TABLE t ADD CONSTRAINT f${i} FOREIGN KEY (a) REFERENCES p (id);`);
      for (let i = 0; i < n; i++) out.push(`ALTER TABLE t DROP CONSTRAINT f${i};`);
      return out.join("\n");
    };
    expectLinear("FK 付け外し", make, 12_500, 3000);
    // 付けて外した外部キーは残らない。DROP FOREIGN KEY (MySQL) も
    const r = sqlToPrismaDsl("CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE t (id int PRIMARY KEY, a int);\nALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES p (id);\nALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD CONSTRAINT g FOREIGN KEY (a) REFERENCES p (id);");
    expect(relationCount(schemaOf(r))).toBe(1);
    // 同じ名前の外部キーを足し直したら置き換える
    const dup = sqlToPrismaDsl("CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE t (id int PRIMARY KEY, a int, b int);\nALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES p (id);\nALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (b) REFERENCES p (id);");
    expect(field(model(schemaOf(dup), "T"), "p").relation).toEqual({ fields: ["b"], references: ["id"] });
  });

  it("RENAME CONSTRAINT x TO x の繰り返し。直す前は 3 万回でヒープが足りずに落ちた", () => {
    const make = (n: number) => "CREATE TABLE t (a int);\n" + "ALTER TABLE t ADD CONSTRAINT ux UNIQUE (a);\nALTER TABLE t RENAME CONSTRAINT ux TO ux;\n".repeat(n);
    expectLinear("RENAME CONSTRAINT 同名", make, 7_500, 3000);
    // 30000 回 (再現そのもの) が落ちずに、一意制約は 1 つ
    const r = sqlToPrismaDsl(make(30_000));
    expect(blockAttr(model(schemaOf(r), "T"), "unique")).toEqual([]);
    expect(field(model(schemaOf(r), "T"), "a").isUnique).toBe(true);
    // 改名で古い名前は消える: 改名のあとの DROP CONSTRAINT 新しい名前で外れる・古い名前では外れない
    const ren = sqlToPrismaDsl("CREATE TABLE t (a int);\nALTER TABLE t ADD CONSTRAINT u1 UNIQUE (a);\nALTER TABLE t RENAME CONSTRAINT u1 TO u2;\nALTER TABLE t DROP CONSTRAINT u1;");
    expect(field(model(schemaOf(ren), "T"), "a").isUnique).toBe(true);
    const ren2 = sqlToPrismaDsl("CREATE TABLE t (a int);\nALTER TABLE t ADD CONSTRAINT u1 UNIQUE (a);\nALTER TABLE t RENAME CONSTRAINT u1 TO u2;\nALTER TABLE t DROP CONSTRAINT u2;");
    expect(field(model(schemaOf(ren2), "T"), "a").isUnique).toBe(false);
    // 別の名前に改名を繰り返しても (a → b → a …) 増えない
    const pingpong = "CREATE TABLE t (a int);\nALTER TABLE t ADD CONSTRAINT ua UNIQUE (a);\n" + "ALTER TABLE t RENAME CONSTRAINT ua TO ub;\nALTER TABLE t RENAME CONSTRAINT ub TO ua;\n".repeat(20_000);
    expect(timeOf(pingpong)).toBeLessThan(2000);
    // 同じ名前の一意制約を足し直したら置き換える (増えない)
    const again = "CREATE TABLE t (a int, b int);\n" + "ALTER TABLE t ADD CONSTRAINT ux UNIQUE (a);\nALTER TABLE t ADD CONSTRAINT ux UNIQUE (b);\n".repeat(5_000);
    const rr = schemaOf(sqlToPrismaDsl(again));
    expect(field(model(rr, "T"), "b").isUnique).toBe(true);
    expect(field(model(rr, "T"), "a").isUnique).toBe(false);
  }, 30_000);

  it("同じテーブル・列・enum への繰り返しの文 (ADD / DROP / RENAME / ALTER COLUMN・ADD VALUE・COMMENT ON・CREATE UNIQUE INDEX・DROP INDEX)", () => {
    const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n");
    expectLinear("ADD COLUMN / DROP COLUMN", (n) => `CREATE TABLE t (id int PRIMARY KEY);\n${rep(n, () => "ALTER TABLE t ADD COLUMN c int UNIQUE REFERENCES t (id);\nALTER TABLE t DROP COLUMN c;")}`, 3_000, 3000);
    expectLinear("RENAME COLUMN", (n) => `CREATE TABLE t (a int, b int);\n${rep(n, () => "ALTER TABLE t RENAME COLUMN a TO c;\nALTER TABLE t RENAME COLUMN c TO a;")}`, 6_000, 3000);
    expectLinear("ALTER COLUMN", (n) => `CREATE TABLE t (a int);\n${rep(n, (i) => `ALTER TABLE t ALTER COLUMN a TYPE varchar(${(i % 50) + 1});\nALTER TABLE t ALTER COLUMN a SET DEFAULT 'x${i}';\nALTER TABLE t ALTER COLUMN a SET NOT NULL;\nALTER TABLE t ALTER COLUMN a DROP NOT NULL;`)}`, 4_000, 3000);
    expectLinear("ALTER TYPE ADD VALUE", (n) => `CREATE TYPE e AS ENUM ('a');\n${rep(n, (i) => `ALTER TYPE e ADD VALUE IF NOT EXISTS 'v${i % 900}';\nALTER TYPE e RENAME VALUE 'a' TO 'a';`)}\nCREATE TABLE t (c e);`, 6_000, 3000);
    expectLinear("COMMENT ON", (n) => `CREATE TABLE t (a int);\n${rep(n, (i) => `COMMENT ON TABLE t IS 'c${i}';\nCOMMENT ON COLUMN t.a IS 'd${i}';`)}`, 7_500, 3000);
    expectLinear("CREATE UNIQUE INDEX / DROP INDEX", (n) => `CREATE TABLE t (a int, b int);\n${rep(n, () => "CREATE UNIQUE INDEX ix ON t (a);\nDROP INDEX ix;\nCREATE UNIQUE INDEX ix ON t (b);")}`, 5_000, 3000);
    expectLinear("CREATE UNIQUE INDEX 同じ名前 (置き換え)", (n) => `CREATE TABLE t (a int, b int);\n${rep(n, () => "CREATE UNIQUE INDEX ix ON t (a);\nCREATE UNIQUE INDEX ix ON t (b);")}`, 5_000, 3000);
    expectLinear("DROP INDEX x ON t (MySQL)", (n) => `CREATE TABLE \`t\` (a int, b int) ENGINE=InnoDB;\n${rep(n, () => "ALTER TABLE `t` ADD UNIQUE KEY `k` (`a`);\nDROP INDEX `k` ON `t`;")}`, 5_000, 3000);
    expectLinear("DROP TABLE / CREATE TABLE (外部キーつき)", (n) => `CREATE TABLE p (id int PRIMARY KEY);\n${rep(n, () => "CREATE TABLE c (id int PRIMARY KEY, p_id int REFERENCES p (id));\nDROP TABLE c;")}\nCREATE TABLE c (id int)`, 5_000, 3000);
    expectLinear("参照される側の作り直し", (n) => `CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE c (id int PRIMARY KEY, p_id int REFERENCES p (id));\n${rep(n, () => "CREATE TABLE new_p (id int PRIMARY KEY);\nDROP TABLE p;\nALTER TABLE new_p RENAME TO p;")}`, 4_000, 3000);
    expectLinear("1 つの ALTER TABLE に ADD (…) がたくさん", (n) => `CREATE TABLE t (id int PRIMARY KEY);\nALTER TABLE t ${Array.from({ length: n }, (_, i) => `ADD (c${i} int)`).join(", ")};`, 12_500, 3000);
    expectLinear("1 つの ALTER TABLE に ADD COLUMN がたくさん", (n) => `CREATE TABLE t (id int PRIMARY KEY);\nALTER TABLE t ${Array.from({ length: n }, (_, i) => `ADD COLUMN c${i % 900} int UNIQUE`).join(", ")};`, 12_500, 3000);
  }, 40_000);

  it("1 つのテーブルの外部キー・一意制約が数万。上限 (定数) を超えた分は読まずに notes に残す", () => {
    const n = SQL_IMPORT_LIMITS.maxForeignKeysPerTable + 3_000;
    const fks = ["CREATE TABLE p (id int PRIMARY KEY);", "CREATE TABLE t (id int PRIMARY KEY, a int, b int);"];
    for (let i = 0; i < n; i++) fks.push(`ALTER TABLE t ADD CONSTRAINT f${i} FOREIGN KEY (a) REFERENCES p (id);`);
    const t0 = Date.now();
    const r = sqlToPrismaDsl(fks.join("\n"));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.dslErrors).toEqual([]);
    expect(r.notes.filter((x) => x.message.includes("外部キーが上限"))).toHaveLength(1);
    expect(notesText(r)).toContain(`上限 (${SQL_IMPORT_LIMITS.maxForeignKeysPerTable})`);
    // 外した分は空く: 上限まで足して 1 つ外して足すと入る
    const free = sqlToPrismaDsl([...fks.slice(0, 2 + SQL_IMPORT_LIMITS.maxForeignKeysPerTable), "ALTER TABLE t DROP CONSTRAINT f0;", "ALTER TABLE t ADD CONSTRAINT fz FOREIGN KEY (b) REFERENCES p (id);"].join("\n"));
    expect(free.notes.some((x) => x.message.includes("外部キーが上限"))).toBe(false);
    expect(schemaOf(free).models.length).toBe(2);
    // 一意制約
    const m = SQL_IMPORT_LIMITS.maxKeysPerTable + 3_000;
    const us = ["CREATE TABLE t (id int PRIMARY KEY, a int, b int);"];
    for (let i = 0; i < m; i++) us.push(`ALTER TABLE t ADD CONSTRAINT u${i} UNIQUE (${i % 2 === 0 ? "a" : "b"}, id);`);
    const t1 = Date.now();
    const ru = sqlToPrismaDsl(us.join("\n"));
    expect(Date.now() - t1).toBeLessThan(3000);
    expect(ru.dslErrors).toEqual([]);
    expect(ru.notes.filter((x) => x.message.includes("一意制約が上限"))).toHaveLength(1);
    // CREATE TABLE の中に外部キー・一意制約が数万あっても
    const inline = `CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE t (id int PRIMARY KEY, a int, ${Array.from({ length: 20_000 }, (_, i) => (i % 2 ? `CONSTRAINT k${i} UNIQUE (a, id)` : `CONSTRAINT k${i} FOREIGN KEY (a) REFERENCES p (id)`)).join(", ")});`;
    const t2 = Date.now();
    const ri = sqlToPrismaDsl(inline);
    expect(Date.now() - t2).toBeLessThan(3000);
    expect(ri.dslErrors).toEqual([]);
  });

  it("列を消したら、その列の一意制約・外部キーの数も空く (足して消してを上限より多く繰り返しても読み続ける)", () => {
    const n = SQL_IMPORT_LIMITS.maxKeysPerTable + 2_000;
    const parts = ["CREATE TABLE p (id int PRIMARY KEY);", "CREATE TABLE t (id int PRIMARY KEY);"];
    for (let i = 0; i < n; i++) parts.push(`ALTER TABLE t ADD COLUMN c int UNIQUE REFERENCES p (id);\nALTER TABLE t DROP COLUMN c;`);
    parts.push("ALTER TABLE t ADD COLUMN last int UNIQUE;");
    const r = sqlToPrismaDsl(parts.join("\n"));
    expect(notesText(r)).not.toContain("上限");
    expect(field(model(schemaOf(r), "T"), "last").isUnique).toBe(true);
  });

  it("1 つの model に関連が 12 万を超えても、Math.max のスプレッドでスタックがあふれず、出力が空にならない", () => {
    // 130 個の子テーブルが、それぞれ 1000 列近くから parent を参照する (関連が約 13 万)
    const parts = ["CREATE TABLE parent (id int PRIMARY KEY);"];
    for (let t = 0; t < 130; t++) {
      const cols = Array.from({ length: 999 }, (_, c) => `c${c} int REFERENCES parent (id)`);
      parts.push(`CREATE TABLE child${t} (id int PRIMARY KEY, ${cols.join(", ")});`);
    }
    const t0 = Date.now();
    const r = sqlToPrismaDsl(parts.join("\n"));
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.dslErrors).toEqual([]);
    expect(r.dsl).not.toBe("");
    expect(r.tables[0]!.table).toBe("parent");
    expect(notesText(r)).not.toContain("DSL を組み立てられませんでした");
    expect(notesText(r)).toContain("上限 (200000 文字) を超えるため");
  });

  it("同じ形 (大きな配列を引数に展開する push(...)) が、ほかにも無い: MySQL の enum の列が 12 万を超えても、出力が空にならない", () => {
    const parts: string[] = [];
    for (let t = 0; t < 150; t++) {
      const cols = Array.from({ length: 900 }, (_, c) => `\`c${c}\` enum('a','b')`);
      parts.push(`CREATE TABLE \`t${t}\` (\`id\` int PRIMARY KEY, ${cols.join(", ")}) ENGINE=InnoDB;`);
    }
    const t0 = Date.now();
    const r = sqlToPrismaDsl(parts.join("\n"));
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.dslErrors).toEqual([]);
    expect(r.tables.length).toBeGreaterThan(0);
    expect(notesText(r)).not.toContain("DSL を組み立てられませんでした");
  }, 30_000);

  it("反復の再読み込み (文字列のエスケープの読み直し) も線形", () => {
    // 目印の無い MySQL の \' が文ごとに出る: 最初の 1 文で読み方が変わって、あとは読み直さない
    expectLinear("it\\'s の繰り返し", (n) => "CREATE TABLE t (a text DEFAULT 'it\\'s');\n".repeat(n), 8_000, 3000);
    // 読み直しがきかない閉じない文字列が文ごとに続いても (1 文が飲み込む)
    expectLinear("閉じない文字列", (n) => "CREATE TABLE t (a text DEFAULT 'it);\n".repeat(n), 10_000, 3000);
    // 交互に出ても、読み直しは入力全体で 50 回まで
    const alt = Array.from({ length: 400 }, (_, i) => (i % 2 ? "CREATE TABLE a (x text DEFAULT 'a\\');" : "CREATE TABLE b (x text DEFAULT 'it\\'s');")).join("\n");
    expect(timeOf(alt)).toBeLessThan(2000);
  });
});

describe("最終レビューの指摘 (# の行コメント・外部キーの結び直し・型の違い・列の数の上限・名前の綴り・LIKE)", () => {
  const rel = (s: PrismaSchema, m: string, f: string) => field(model(s, m), f).relation;
  const fieldNames = (s: PrismaSchema, m: string) => model(s, m).fields.map((f) => f.name);

  describe("1. 行頭の # は、方言が何でも行コメント", () => {
    const HAND = "# users table - don't touch\nCREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(10) NOT NULL);\n# orders: it's the main one\nCREATE TABLE orders (id INT PRIMARY KEY, user_id INT);\nCREATE TABLE logs (id INT PRIMARY KEY);\n";

    it("再現: 目印の少ない手書きの MySQL (SERIAL があっても) の 3 テーブルが消えない", () => {
      expect(sqlToPrismaDsl(HAND).tables.map((t) => t.table)).toEqual(["users", "orders", "logs"]);
      // SERIAL を抜いて、方言が決まらなくても
      expect(sqlToPrismaDsl(HAND.replace("id SERIAL PRIMARY KEY", "id INT PRIMARY KEY")).tables.map((t) => t.table)).toEqual(["users", "orders", "logs"]);
    });

    it("PostgreSQL と分かっていても、文の外・かっこの外の行頭の # は行コメント", () => {
      const r = sqlToPrismaDsl("-- PostgreSQL database dump\n# note: don't read this\nCREATE TABLE a (id int PRIMARY KEY);\n  # it's another\nCREATE TABLE b (id int PRIMARY KEY);\n");
      expect(r.tables.map((t) => t.table)).toEqual(["a", "b"]);
    });

    it("PostgreSQL では、かっこの中の行頭の # は演算子のまま (#>> が行頭に来ても列が消えない)", () => {
      const r = sqlToPrismaDsl("-- PostgreSQL database dump\nCREATE TABLE docs (\n id bigint NOT NULL,\n title text GENERATED ALWAYS AS ((data\n #>> '{a}'::text[])) STORED,\n owner_id bigint NOT NULL\n);\nCREATE TABLE b (id int);");
      expect(r.tables.map((t) => t.table)).toEqual(["docs", "b"]);
      expect(fieldNames(schemaOf(r), "Docs")).toEqual(["id", "title", "ownerId"]);
    });

    it("方言が決まらないときは、かっこの中の行頭の # もコメント", () => {
      const r = sqlToPrismaDsl("CREATE TABLE a (\n  # it's the id\n  id int PRIMARY KEY,\n  n int\n);\nCREATE TABLE b (id int);");
      expect(r.tables.map((t) => t.table)).toEqual(["a", "b"]);
      expect(fieldNames(schemaOf(r), "A")).toEqual(["id", "n"]);
    });

    it("行の途中の #>>・#tmp は、これまでどおり記号 (前回の再現)", () => {
      const pg = "-- PostgreSQL database dump\nCREATE TABLE public.docs (\n id bigint NOT NULL,\n title text GENERATED ALWAYS AS ((data #>> '{a}'::text[])) STORED,\n owner_id bigint NOT NULL\n);\nCREATE TABLE b (id int);";
      expect(fieldNames(schemaOf(sqlToPrismaDsl(pg)), "Docs")).toEqual(["id", "title", "ownerId"]);
      expect(sqlToPrismaDsl("CREATE TABLE #tmp (id int);\nCREATE TABLE a (id int PRIMARY KEY);\nGO\n").tables.map((t) => t.table)).toEqual(["a"]);
    });
  });

  describe("2. 消したテーブルを参照する外部キーは、あとから作った無関係の同名のテーブルに結ばない", () => {
    it("再現 1 (SQLite): 改名して消したあとに作った users に結ばれない", () => {
      const r = sqlToPrismaDsl("CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE orders(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id)); ALTER TABLE users RENAME TO accounts; DROP TABLE accounts; CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);");
      const s = schemaOf(r);
      expect(relationCount(s)).toBe(0);
      expect(r.tables.map((t) => t.table)).toEqual(["orders", "users"]);
      expect(notesText(r)).toContain("参照先のテーブル accounts が SQL にない");
    });

    it("再現 2: 別のスキーマの同名のテーブル (a.items) に結ばれない", () => {
      const r = sqlToPrismaDsl("CREATE TABLE a.items (id int PRIMARY KEY); CREATE TABLE b.items (id int PRIMARY KEY); CREATE TABLE b.x (id int PRIMARY KEY, item_id int REFERENCES items(id)); DROP TABLE b.items;");
      const s = schemaOf(r);
      expect(relationCount(s)).toBe(0);
      expect(r.tables.map((t) => t.table)).toEqual(["items", "x"]);
      expect(notesText(r)).toContain("参照先のテーブル items が SQL にない");
    });

    it("スキーマ名なしの参照は、書いたテーブルのスキーマ → 既定のスキーマの順で結ぶ (別のスキーマの同名には結ばない)", () => {
      // 後から参照先ができる形 (CREATE の時点では参照先がない)
      const r = sqlToPrismaDsl("CREATE TABLE b.x (id int PRIMARY KEY, item_id int REFERENCES items(id));\nCREATE TABLE a.items (id int PRIMARY KEY);\nCREATE TABLE b.items (id int PRIMARY KEY);");
      const s = schemaOf(r);
      expect(relationCount(s)).toBe(1);
      expect(rel(s, "X", "item")).toEqual({ fields: ["itemId"], references: ["id"] });
      expect(model(s, "Items2").fields.map((f) => f.type)).toContain("X");
      expect(model(s, "Items").fields.map((f) => f.type)).not.toContain("X");
    });

    it("作り直し (新しい表 → 古い表を DROP → 改名) では、外部キーが残る (前回の修正)", () => {
      const r = sqlToPrismaDsl("CREATE TABLE users (id INTEGER PRIMARY KEY);\nCREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));\nCREATE TABLE new_users (id INTEGER PRIMARY KEY, email TEXT);\nDROP TABLE users;\nALTER TABLE new_users RENAME TO users;\n");
      expect(rel(schemaOf(r), "Orders", "user")).toEqual({ fields: ["userId"], references: ["id"] });
    });
  });

  describe("3. 関連にするときの型・一意の確認", () => {
    it("再現 1: users を uid uuid PRIMARY KEY, id text で作り直すと、一意でない id は関連にしない (列だけ残して notes と行末のコメント)", () => {
      const r = sqlToPrismaDsl("CREATE TABLE users (id INTEGER PRIMARY KEY);\nCREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));\nDROP TABLE users;\nCREATE TABLE users (uid uuid PRIMARY KEY, id text);\n");
      const s = schemaOf(r);
      expect(relationCount(s)).toBe(0);
      expect(fieldNames(s, "Orders")).toEqual(["id", "userId"]);
      expect(notesText(r)).toMatch(/orders の外部キー.*users\(id\) は、主キーでも一意でもない/);
      expect(r.notes.find((n) => n.message.includes("主キーでも一意でもない"))?.line).toBe(2);
      expect(r.dsl).toMatch(/userId\s+Int\?\s+@map\("user_id"\) \/\/ 参照先: users\(id\) \(主キーでも一意でもない\)/);
    });

    it("結び直した参照先の列の型が違えば、関連にはするが notes に行つきで残す", () => {
      const r = sqlToPrismaDsl("CREATE TABLE users (id INTEGER PRIMARY KEY);\nCREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));\nDROP TABLE users;\nCREATE TABLE users (uid uuid, id text PRIMARY KEY);\n");
      const s = schemaOf(r);
      expect(rel(s, "Orders", "user")).toEqual({ fields: ["userId"], references: ["id"] });
      const n = r.notes.find((x) => x.message.includes("型が違います"));
      expect(n?.message).toContain("user_id (Int) → id (String)");
      expect(n?.line).toBe(2);
    });

    it("再現 2: REFERENCES users (列の省略) のあとで作り直すと、新しい主キー code TEXT に結ばれるので、型の違いを notes に残す", () => {
      const r = sqlToPrismaDsl("CREATE TABLE users (id INTEGER PRIMARY KEY);\nCREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users);\nDROP TABLE users;\nCREATE TABLE users (code TEXT PRIMARY KEY);\n");
      const s = schemaOf(r);
      expect(rel(s, "Orders", "user")).toEqual({ fields: ["userId"], references: ["code"] });
      expect(notesText(r)).toContain("user_id (Int) → code (String)");
    });

    it("型が同じなら notes は出ない。一意の列・複合の主キーへの外部キーは関連にする", () => {
      const r = sqlToPrismaDsl("CREATE TABLE a (id int PRIMARY KEY, code varchar(10) UNIQUE);\nCREATE TABLE c (x int, y int, PRIMARY KEY (x, y));\nCREATE TABLE b (id int PRIMARY KEY, a_code varchar(20) REFERENCES a(code), cx int, cy int, FOREIGN KEY (cx, cy) REFERENCES c(x, y));");
      const s = schemaOf(r);
      expect(relationCount(s)).toBe(2);
      expect(notesText(r)).not.toContain("型が違います");
      expect(notesText(r)).not.toContain("主キーでも一意でもない");
    });

    it("MySQL が許す一意でない列への外部キーも、関連にせず notes に残す (Prisma の references は一意の列でなければならないため)", () => {
      const r = sqlToPrismaDsl("CREATE TABLE a (id int PRIMARY KEY, code varchar(10), KEY (code)) ENGINE=InnoDB;\nCREATE TABLE b (id int PRIMARY KEY, a_code varchar(10), CONSTRAINT fk_b FOREIGN KEY (a_code) REFERENCES a(code)) ENGINE=InnoDB;");
      const s = schemaOf(r);
      expect(relationCount(s)).toBe(0);
      expect(notesText(r)).toContain("b の外部キー fk_bの参照先の列 a(code) は、主キーでも一意でもない");
      expect(r.dsl).toMatch(/aCode\s+String\?[^\n]*\/\/ 参照先: a\(code\)/);
    });
  });

  describe("4. INHERITS・LIKE の列は、カタログ全体の上限で止まる", () => {
    const parent = () => `CREATE TABLE t0 (${Array.from({ length: 1000 }, (_, i) => `c${i} int`).join(", ")});\n`;
    const many = (make: (i: number) => string) => parent() + Array.from({ length: 5000 }, (_, i) => make(i + 1)).join("\n");

    for (const [label, make] of [
      ["INHERITS", (i: number) => `CREATE TABLE t${i} () INHERITS (t0);`],
      ["LIKE (かっこの中)", (i: number) => `CREATE TABLE t${i} (LIKE t0);`],
      ["LIKE (MySQL のかっこなし)", (i: number) => `CREATE TABLE t${i} LIKE t0;`],
    ] as const) {
      it(`${label}: 1000 列の親から 5000 テーブル (19 万文字) が数秒以内に終わり、上限を超えたテーブルは読み飛ばして notes に 1 件`, () => {
        const sql = many(make);
        expect(sql.length).toBeLessThan(200_000);
        const t0 = Date.now();
        const r = sqlToPrismaDsl(sql);
        expect(Date.now() - t0).toBeLessThan(4000);
        expect(r.dslErrors).toEqual([]);
        const capped = r.notes.filter((n) => n.message.includes("全体の上限"));
        expect(capped).toHaveLength(1);
        expect(capped[0]!.message).toMatch(/テーブル 48\d\d 個/);
        // 列なしのテーブルにはしない。上限まで (親 + 子 199 個 = 20 万列) のテーブルが先に決まる
        expect(r.tables.every((t) => t.columns > 0)).toBe(true);
        expect(r.tables[0]!.table).toBe("t0");
        expect(SQL_IMPORT_LIMITS.maxTotalColumns).toBe(200_000);
      });
    }

    it("上限に収まる小さな LIKE・INHERITS は、これまでどおり写す", () => {
      const r = sqlToPrismaDsl("CREATE TABLE p (id int PRIMARY KEY, a text);\nCREATE TABLE c1 (b int) INHERITS (p);\nCREATE TABLE c2 (LIKE p);");
      const s = schemaOf(r);
      expect(fieldNames(s, "C1")).toEqual(["id", "a", "b"]);
      expect(fieldNames(s, "C2")).toEqual(["id", "a"]);
      expect(notesText(r)).not.toContain("全体の上限");
    });
  });

  describe("5. 名前はもとの綴りから作り、小文字にした名前は @map だけに出す", () => {
    it("(a) PostgreSQL と強く言えるときは、小文字の @map / @@map。名前は OrderItems・orderItemId", () => {
      const r = sqlToPrismaDsl("-- PostgreSQL database dump\nCREATE TABLE OrderItems (OrderItemId serial PRIMARY KEY, OrderId int NOT NULL);\n");
      const s = schemaOf(r);
      expect(r.tables[0]).toMatchObject({ table: "orderitems", model: "OrderItems" });
      expect(model(s, "OrderItems").mapName).toBe("orderitems");
      expect(fieldNames(s, "OrderItems")).toEqual(["orderItemId", "orderId"]);
      expect(field(model(s, "OrderItems"), "orderItemId")).toMatchObject({ mapName: "orderitemid" });
      expect(field(model(s, "OrderItems"), "orderId")).toMatchObject({ mapName: "orderid" });
    });

    it("(a) 目印が複数ある (ヘッダーなし) ときも強い", () => {
      const r = sqlToPrismaDsl("CREATE TABLE OrderItems (OrderItemId serial PRIMARY KEY, At timestamptz);\n");
      expect(r.tables[0]).toMatchObject({ table: "orderitems", model: "OrderItems" });
    });

    it("(b) 方言の判定が外れた手書きの MySQL (SERIAL が 1 つだけ) は、もとの綴りのまま (@@map に小文字を付けない)", () => {
      const r = sqlToPrismaDsl("CREATE TABLE OrderItems (OrderId INT, Id SERIAL PRIMARY KEY);\nCREATE TABLE Users (Id INT PRIMARY KEY);");
      const s = schemaOf(r);
      expect(r.tables.map((t) => [t.table, t.model])).toEqual([["OrderItems", "OrderItems"], ["Users", "Users"]]);
      expect(model(s, "OrderItems").mapName).toBeUndefined();
      expect(field(model(s, "OrderItems"), "orderId")).toMatchObject({ mapName: "OrderId" });
      expect(field(model(s, "OrderItems"), "id")).toMatchObject({ mapName: "Id" });
    });

    it("(c) マイグレーションの組は、ファイル全体で方言を 1 つに決めて揃える (001 だけが pg と判定されて 002 がそのままにならない)", () => {
      const f1 = { path: "001.sql", text: "CREATE TABLE Users (Id SERIAL PRIMARY KEY);" };
      const f2 = { path: "002.sql", text: "ALTER TABLE Users ADD COLUMN DisplayName text;" };
      // 目印が弱い (SERIAL だけ): どちらももとの綴りのまま
      const weak = sqlFilesToPrismaDsl([f1, f2]);
      expect(weak.tables[0]).toMatchObject({ table: "Users" });
      expect(field(model(schemaOf(weak), "Users"), "displayName")).toMatchObject({ mapName: "DisplayName" });
      // 1 つのファイルにヘッダーがあれば、全部のファイルが PostgreSQL (小文字)
      const strong = sqlFilesToPrismaDsl([{ path: "000.sql", text: "-- PostgreSQL database dump\n" }, f1, f2]);
      expect(strong.tables[0]).toMatchObject({ table: "users", model: "Users" });
      expect(field(model(schemaOf(strong), "Users"), "displayName")).toMatchObject({ mapName: "displayname" });
      // 目印の点数はファイルの合計で見る (001 に SERIAL、002 に :: と timestamptz)
      const sum = sqlFilesToPrismaDsl([f1, { path: "002.sql", text: "ALTER TABLE Users ADD COLUMN DisplayName timestamptz DEFAULT now()::timestamptz;" }]);
      expect(sum.tables[0]).toMatchObject({ table: "users" });
      expect(field(model(schemaOf(sum), "Users"), "displayName")).toMatchObject({ mapName: "displayname" });
    });

    it("違う方言のヘッダーが混ざるときだけ、ファイルごとに決める", () => {
      const r = sqlFilesToPrismaDsl([
        { path: "pg.sql", text: "-- PostgreSQL database dump\nCREATE TABLE PgTable (Id serial PRIMARY KEY);" },
        { path: "my.sql", text: "-- MySQL dump 10.13\nCREATE TABLE `MyTable` (`Id` int PRIMARY KEY);\nCREATE TABLE MyOther (Id int PRIMARY KEY);" },
      ]);
      expect(r.tables.map((t) => t.table)).toEqual(["pgtable", "MyTable", "MyOther"]);
      expect(r.tables.map((t) => t.model)).toEqual(["PgTable", "MyTable", "MyOther"]);
    });
  });

  describe("6. LIKE", () => {
    const S = "CREATE TABLE s (id int PRIMARY KEY, name text, code varchar(5) UNIQUE);\n";

    it("再現: LIKE s INCLUDING ALL の後ろの項目も読み、主キー・一意も写す", () => {
      const r = sqlToPrismaDsl(`${S}CREATE TABLE t (LIKE s INCLUDING ALL, extra int);`);
      const s = schemaOf(r);
      expect(fieldNames(s, "T")).toEqual(["id", "name", "code", "extra"]);
      expect(field(model(s, "T"), "id").attributes.some((a) => a.name === "id")).toBe(true);
      expect(attr(field(model(s, "T"), "code"), "unique")).toBeDefined();
    });

    it("再現: 項目の前にある LIKE (extra int, LIKE s) も、s の列を写す。INCLUDING なしは主キー・一意を写さない", () => {
      const r = sqlToPrismaDsl(`${S}CREATE TABLE t (extra int, LIKE s);`);
      const s = schemaOf(r);
      expect(fieldNames(s, "T")).toEqual(["extra", "id", "name", "code"]);
      expect(attr(field(model(s, "T"), "id"), "id")).toBeUndefined();
      expect(notesText(r)).toContain("t に主キーがありません");
    });

    it("INCLUDING INDEXES / CONSTRAINTS で主キー・一意を写し、EXCLUDING で外せる。真ん中の LIKE の前後の列も残る", () => {
      const inc = schemaOf(sqlToPrismaDsl(`${S}CREATE TABLE t (a int, LIKE s INCLUDING INDEXES, z int);`));
      expect(fieldNames(inc, "T")).toEqual(["a", "id", "name", "code", "z"]);
      expect(attr(field(model(inc, "T"), "id"), "id")).toBeDefined();
      const ex = schemaOf(sqlToPrismaDsl(`${S}CREATE TABLE t (LIKE s INCLUDING ALL EXCLUDING INDEXES EXCLUDING CONSTRAINTS, z int);`));
      expect(attr(field(model(ex, "T"), "id"), "id")).toBeUndefined();
    });

    it("元が見つからないときは notes に残し、残りの項目は読む", () => {
      const r = sqlToPrismaDsl("CREATE TABLE t (LIKE missing INCLUDING ALL, extra int);");
      expect(fieldNames(schemaOf(r), "T")).toEqual(["extra"]);
      expect(notesText(r)).toContain("LIKE の元 missing が見つからない");
    });

    it("SQLite の like という名前の列は、列として読む", () => {
      const r = sqlToPrismaDsl("CREATE TABLE t (id INTEGER PRIMARY KEY, like TEXT NOT NULL);\nCREATE TABLE u (like TEXT, id INTEGER PRIMARY KEY);\nCREATE TABLE v (id INTEGER PRIMARY KEY, like);");
      const s = schemaOf(r);
      expect(fieldNames(s, "T")).toEqual(["id", "like"]);
      expect(field(model(s, "T"), "like")).toMatchObject({ isOptional: false });
      expect(fieldNames(s, "U")).toEqual(["like", "id"]);
      expect(fieldNames(s, "V")).toEqual(["id", "like"]);
    });

    it("MySQL の CREATE TABLE t LIKE s; (かっこなし) は、元の列・主キー・一意を写す", () => {
      const r = sqlToPrismaDsl("CREATE TABLE `s` (`id` int NOT NULL AUTO_INCREMENT, `name` text, PRIMARY KEY (`id`)) ENGINE=InnoDB;\nCREATE TABLE `t` LIKE `s`;\n");
      const s = schemaOf(r);
      expect(r.tables.map((t) => t.table)).toEqual(["s", "t"]);
      expect(fieldNames(s, "T")).toEqual(["id", "name"]);
      expect(attr(field(model(s, "T"), "id"), "id")).toBeDefined();
    });
  });

  describe("7. そのほか", () => {
    it("SQL Server の timestamp・rowversion は DateTime ではなく Bytes", () => {
      const r = sqlToPrismaDsl("CREATE TABLE [dbo].[t] (\n [id] int IDENTITY(1,1) NOT NULL PRIMARY KEY,\n [ver] timestamp NOT NULL,\n [rv] rowversion,\n [at] datetime2\n)\nGO\n");
      const s = schemaOf(r);
      expect(field(model(s, "T"), "ver").type).toBe("Bytes");
      expect(field(model(s, "T"), "rv").type).toBe("Bytes");
      expect(field(model(s, "T"), "at").type).toBe("DateTime");
      // PostgreSQL・MySQL の timestamp は日時のまま
      expect(typeOf("CREATE TABLE t (c timestamp);", "c").f.type).toBe("DateTime");
    });

    it("SQLite の WITHOUT ROWID の表の INTEGER PRIMARY KEY には autoincrement を付けない", () => {
      const r = sqlToPrismaDsl("CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);\nCREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT) WITHOUT ROWID;\nCREATE TABLE c (k INTEGER, v TEXT, PRIMARY KEY (k)) WITHOUT ROWID;");
      const s = schemaOf(r);
      expect(attr(field(model(s, "A"), "id"), "default")?.args).toBe("autoincrement()");
      expect(attr(field(model(s, "B"), "id"), "default")).toBeUndefined();
      expect(attr(field(model(s, "B"), "id"), "id")).toBeDefined();
      expect(attr(field(model(s, "C"), "k"), "default")).toBeUndefined();
    });
  });
});
