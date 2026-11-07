import { describe, expect, it } from "vitest";
import { describePrismaField, parsePrismaDsl } from "../prisma";
import { parsePrismaDslCached } from "../prismaCache";

describe("parsePrismaDsl", () => {
  it("空の DSL は何も返さない", () => {
    expect(parsePrismaDsl("")).toEqual({ models: [], enums: [], errors: [] });
    expect(parsePrismaDsl("  \n// コメントだけ\n")).toEqual({ models: [], enums: [], errors: [] });
  });

  it("model のフィールド・型・? と []・属性を読む", () => {
    const s = parsePrismaDsl(`model User {
  id    Int     @id @default(autoincrement())
  email String  @unique @map("mail_address")
  name  String?
  posts Post[]
  role  Role    @default(USER)
}

model Post {
  id       Int  @id
  author   User @relation(fields: [authorId], references: [id])
  authorId Int
}

enum Role {
  USER
  ADMIN
}
`);
    expect(s.errors).toEqual([]);
    const user = s.models[0]!;
    expect(user.name).toBe("User");
    expect(user.fields.map((f) => f.name)).toEqual(["id", "email", "name", "posts", "role"]);
    expect(user.fields[0]).toMatchObject({ type: "Int", isId: true, isUnique: false, isList: false, isOptional: false, defaultValue: "autoincrement()" });
    expect(user.fields[1]).toMatchObject({ isUnique: true, mapName: "mail_address" });
    expect(user.fields[2]).toMatchObject({ type: "String", isOptional: true });
    expect(user.fields[3]).toMatchObject({ type: "Post", isList: true });
    expect(user.fields[4]).toMatchObject({ type: "Role", defaultValue: "USER" });
    expect(s.models[1]!.fields[1]!.relation).toEqual({ fields: ["authorId"], references: ["id"] });
    expect(s.enums).toEqual([{ name: "Role", values: ["USER", "ADMIN"] }]);
  });

  it("ブロック属性 (@@id / @@unique / @@map) と enum の @map を読む", () => {
    const s = parsePrismaDsl(`model Link {
  a Int
  b Int
  @@id([a, b])
  @@unique([a, b])
  @@map("links")
}
enum Kind {
  A @map("a")
  B
  @@map("kinds")
}`);
    expect(s.errors).toEqual([]);
    const m = s.models[0]!;
    expect(m.mapName).toBe("links");
    expect(m.blockAttributes).toEqual([
      { name: "id", args: "[a, b]" },
      { name: "unique", args: "[a, b]" },
      { name: "map", args: '"links"' },
    ]);
    expect(s.enums[0]).toEqual({ name: "Kind", values: ["A", "B"], mapName: "kinds" });
  });

  it("コメントを読み飛ばす (文字列の中の // は残す)", () => {
    const s = parsePrismaDsl(`// 先頭
model A { // ここも
  id String @id // 末尾
  url String @default("http://x") // 文字列の中は // でも残る
}`);
    expect(s.errors).toEqual([]);
    expect(s.models[0]!.fields[1]!.defaultValue).toBe('"http://x"');
  });

  it("datasource / generator は読み飛ばし、未知の属性は生で持ってエラーにしない", () => {
    const s = parsePrismaDsl(`datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
generator client {
  provider = "prisma-client-js"
}
model A {
  id   String @id @db.VarChar(36)
  name String @db.Text @custom(1, "x")
  @@index([name])
}`);
    expect(s.errors).toEqual([]);
    expect(s.models).toHaveLength(1);
    expect(s.models[0]!.fields[0]!.attributes).toEqual([
      { name: "id", args: "" },
      { name: "db.VarChar", args: "36" },
    ]);
    expect(s.models[0]!.fields[1]!.attributes.map((a) => a.name)).toEqual(["db.Text", "custom"]);
    expect(s.models[0]!.blockAttributes).toEqual([{ name: "index", args: "[name]" }]);
  });

  it("1 つ壊れていても、ほかの model とフィールドは読める (行・列つきのエラー)", () => {
    const s = parsePrismaDsl(`model A {
  id String @id
  1bad Int
  ok Int
}
こわれた行
model B {
  id String @id
}`);
    expect(s.models.map((m) => m.name)).toEqual(["A", "B"]);
    expect(s.models[0]!.fields.map((f) => f.name)).toEqual(["id", "ok"]);
    expect(s.errors.map((e) => [e.line, e.column])).toEqual([
      [3, 3],
      [6, 1],
    ]);
  });

  it("閉じていないブロックはエラーにして、読めたところまで残す", () => {
    const s = parsePrismaDsl(`model A {
  id String @id`);
    expect(s.models[0]!.fields).toHaveLength(1);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]!.line).toBe(1);
    expect(s.errors[0]!.message).toContain("閉じられていません");
  });

  it("未知の型を参照するフィールド・同名の model・同名のフィールドはエラー", () => {
    const s = parsePrismaDsl(`model A {
  id String @id
  x Missing
  id Int
}
model A {
  y String
}
enum A {
  Z
}`);
    expect(s.models).toHaveLength(1);
    expect(s.models[0]!.fields.map((f) => f.name)).toEqual(["id", "x"]);
    const messages = s.errors.map((e) => `${e.line}:${e.column} ${e.message}`);
    expect(messages).toEqual([
      expect.stringMatching(/^3:5 未知の型です: Missing/),
      expect.stringMatching(/^4:3 同じ名前のフィールドがあります: id/),
      expect.stringMatching(/^6:7 同じ名前の model \/ enum があります: A/),
      expect.stringMatching(/^9:6 同じ名前の model \/ enum があります: A/),
    ]);
  });

  it("model と enum の名前は型として使える", () => {
    const s = parsePrismaDsl(`model A { id String @id\n b B\n e E }\nmodel B { id String @id }\nenum E { X }`);
    expect(s.errors).toEqual([]);
  });

  it("属性のかっこが閉じていないとエラー", () => {
    const s = parsePrismaDsl(`model A {\n  id String @default(foo(\n}`);
    expect(s.errors.some((e) => e.line === 2)).toBe(true);
  });

  it("文字列の中の } や { はブロックの終わりにならない", () => {
    const s = parsePrismaDsl(`model A {
  id   String @id
  a    Json   @default("{}")
  b    String @default("a } b")
  c    String @default("x") // }
}
model B { id String @id @default("}") }`);
    expect(s.errors).toEqual([]);
    expect(s.models.map((m) => m.name)).toEqual(["A", "B"]);
    expect(s.models[0]!.fields.map((f) => f.name)).toEqual(["id", "a", "b", "c"]);
    expect(s.models[0]!.fields[1]!.defaultValue).toBe('"{}"');
  });

  it("} の閉じ忘れは、次のブロックの見出しから読み直す", () => {
    const s = parsePrismaDsl(`model A {
  id String @id

model B {
  id String @id
}
enum E {
  X
`);
    expect(s.models.map((m) => m.name)).toEqual(["A", "B"]);
    expect(s.enums.map((e) => e.name)).toEqual(["E"]);
    expect(s.models[0]!.fields).toHaveLength(1);
    const unclosed = s.errors.filter((e) => e.message.includes("閉じられていません"));
    expect(unclosed.map((e) => [e.line, e.message])).toEqual([
      [1, "A のブロックが } で閉じられていません"],
      [7, "E のブロックが } で閉じられていません"],
    ]);
  });

  it("CRLF・タブ・/// のコメントを読める", () => {
    const s = parsePrismaDsl("/// ドキュメントコメント\r\nmodel A {\r\n\tid\tString\t@id /// 主キー\r\n\tn Int?\r\n}\r\n");
    expect(s.errors).toEqual([]);
    expect(s.models[0]!.fields.map((f) => [f.name, f.type, f.isId, f.isOptional])).toEqual([
      ["id", "String", true, false],
      ["n", "Int", false, true],
    ]);
  });

  it("読み飛ばした type / view の名前は型として使える", () => {
    const s = parsePrismaDsl(`type Address {\n  city String\n}\nview V {\n  id Int\n}\nmodel A {\n  id Int @id\n  addr Address\n  v V\n}`);
    expect(s.errors).toEqual([]);
    expect(s.models.map((m) => m.name)).toEqual(["A"]);
  });

  it("一時的な解析結果の要約を作れる", () => {
    const s = parsePrismaDsl(`model A {\n  id Int @id @default(autoincrement())\n  b B? @relation(fields: [bId], references: [id])\n  tags String[] @unique\n}\nmodel B { id Int @id }`);
    const [id, b, tags] = s.models[0]!.fields;
    expect(describePrismaField(id!)).toBe("Int @id @default(autoincrement())");
    expect(describePrismaField(b!)).toBe("B? @relation(bId → id)");
    expect(describePrismaField(tags!)).toBe("String[] @unique");
  });
});

describe("parsePrismaDslCached", () => {
  it("同じ文字列なら同じ結果を返し、変わったら解析し直す", () => {
    const a = parsePrismaDslCached("model A { id Int }");
    expect(parsePrismaDslCached("model A { id Int }")).toBe(a);
    const b = parsePrismaDslCached("model B { id Int }");
    expect(b).not.toBe(a);
    expect(b.models[0]!.name).toBe("B");
    // 直近の数件は覚えている
    expect(parsePrismaDslCached("model A { id Int }")).toBe(a);
    for (let i = 0; i < 10; i++) parsePrismaDslCached(`model M${i} { id Int }`);
    expect(parsePrismaDslCached("model A { id Int }")).not.toBe(a);
  });
});
