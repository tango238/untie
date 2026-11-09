import { describe, expect, it } from "vitest";
import { addDatabase, editDatabaseDsl, setDatabaseDsl, setTableInformation } from "../commands";
import { parsePrismaDsl } from "../prisma";
import { applyPrismaEdit, freePrismaFieldName, freePrismaModelName, oppositeRelationField, prismaRelationLines, type PrismaEdit } from "../prismaEdit";
import { emptyModel, type UntieModel } from "../types";

const DSL = `// 予約
model Reservation {
  id      String @id // 予約番号
  guestId String
  guest   Guest  @relation(fields: [guestId], references: [id])
  note    String?

  @@map("reservations")
}

model Guest {
  id           String        @id
  reservations Reservation[]
}

enum Status {
  OPEN
  CLOSED
}
`;

const apply = (dsl: string, edit: PrismaEdit): string => {
  const r = applyPrismaEdit(dsl, edit);
  if (!r.ok) throw new Error(r.reason);
  expect(parsePrismaDsl(r.dsl).errors).toEqual([]);
  return r.dsl;
};
const reason = (dsl: string, edit: PrismaEdit): string => {
  const r = applyPrismaEdit(dsl, edit);
  if (r.ok) throw new Error("通ってしまった");
  return r.reason;
};

describe("applyPrismaEdit: テーブル", () => {
  it("テーブルを足すと、末尾に id だけの model を足す", () => {
    expect(apply("", { type: "addModel", name: "Room" })).toBe("model Room {\n  id String @id\n}\n");
    const out = apply(DSL, { type: "addModel", name: "Room" });
    expect(out.startsWith(DSL.trimEnd())).toBe(true);
    expect(out.endsWith("}\n\nmodel Room {\n  id String @id\n}\n")).toBe(true);
  });

  it("使えない名前・重なる名前は断る", () => {
    expect(reason(DSL, { type: "addModel", name: "1st" })).toContain("英数字");
    expect(reason(DSL, { type: "addModel", name: "Guest" })).toContain("同じ名前");
    expect(reason(DSL, { type: "addModel", name: "Status" })).toContain("同じ名前");
    expect(reason(DSL, { type: "addModel", name: "String" })).toContain("型の名前");
  });

  it("名前を変えると、見出しと、型として参照しているフィールドを直す。ほかの行とコメントは残す", () => {
    const out = apply(DSL, { type: "renameModel", from: "Guest", to: "Customer" });
    expect(out).toContain("model Customer {");
    expect(out).toContain("  guest Customer @relation(fields: [guestId], references: [id])");
    expect(out).toContain("  id      String @id // 予約番号");
    expect(out).toContain("// 予約\n");
    expect(out).not.toContain("Guest ");
  });

  it("消すと、ブロックと直前のコメント、ほかのテーブルからの関連と、その関連だけに使う外部キーの列を消す", () => {
    const out = apply(DSL, { type: "removeModel", name: "Guest" });
    expect(out).not.toContain("Guest");
    expect(out).not.toContain("guestId");
    expect(out).toContain("note    String?");
    const out2 = apply(DSL, { type: "removeModel", name: "Reservation" });
    expect(out2).not.toContain("// 予約");
    expect(out2).not.toContain("reservations Reservation[]");
    expect(out2.startsWith("model Guest {")).toBe(true);
  });

  it("消すテーブルへの外部キーの列でも、@@unique などの一覧に使っていれば残す", () => {
    const dsl = "model A {\n  id String @id\n  bs B[]\n}\n\nmodel B {\n  id  String @id\n  aId String\n  a   A @relation(fields: [aId], references: [id])\n  @@unique([aId, id])\n}\n";
    const out = apply(dsl, { type: "removeModel", name: "A" });
    expect(out).toBe("model B {\n  id  String @id\n  aId String\n  @@unique([aId, id])\n}\n");
  });

  it("1 行で書いた model は、触るときに 1 行 1 フィールドへ展開する", () => {
    const out = apply("model A { id String @id }\n", { type: "addField", model: "A", field: { name: "name", type: "String" } });
    expect(out).toBe("model A {\n  id String @id\n  name String\n}\n");
  });

  it("解析エラーのある DSL は書き換えない", () => {
    expect(reason("model A {\n  id Foo\n}", { type: "addModel", name: "B" })).toContain("解析エラー");
  });
});

describe("applyPrismaEdit: 列", () => {
  it("列を足すと、@@ の前 (空行の前) に、同じ字下げで足す", () => {
    const out = apply(DSL, { type: "addField", model: "Reservation", field: { name: "status", type: "Status", isOptional: true } });
    expect(out).toContain('  note    String?\n  status Status?\n\n  @@map("reservations")');
  });

  it("列の名前・型・? / []・主キー・一意を変える。ほかの属性と行末のコメントは残す", () => {
    let out = apply(DSL, { type: "updateField", model: "Reservation", field: "note", patch: { type: "Int", isOptional: false, isUnique: true } });
    expect(out).toContain("  note Int @unique\n");
    out = apply(DSL, { type: "updateField", model: "Reservation", field: "id", patch: { name: "code" } });
    expect(out).toContain("  code String @id // 予約番号");
    out = apply(DSL, { type: "updateField", model: "Reservation", field: "note", patch: { isList: true } });
    expect(out).toContain("  note String[]");
  });

  it("列の名前を変えると、@relation の fields・references と @@ の一覧も合わせる", () => {
    let out = apply(DSL, { type: "updateField", model: "Reservation", field: "guestId", patch: { name: "customerId" } });
    expect(out).toContain("  customerId String\n  guest   Guest  @relation(fields: [customerId], references: [id])");
    out = apply(DSL, { type: "updateField", model: "Guest", field: "id", patch: { name: "guestNo" } });
    expect(out).toContain("references: [guestNo]");
    out = apply("model A {\n  a String\n  b String\n  @@id([a, b])\n}\n", { type: "updateField", model: "A", field: "a", patch: { name: "x" } });
    expect(out).toContain("@@id([x, b])");
  });

  it("断るもの: 重なる名前、未知の型、関連の列の型の変更、NULL 可の主キー", () => {
    expect(reason(DSL, { type: "updateField", model: "Reservation", field: "note", patch: { name: "guestId" } })).toContain("同じ名前");
    expect(reason(DSL, { type: "updateField", model: "Reservation", field: "note", patch: { type: "Nope" } })).toContain("未知の型");
    expect(reason(DSL, { type: "updateField", model: "Reservation", field: "guest", patch: { type: "String" } })).toContain("関連の列");
    expect(reason(DSL, { type: "updateField", model: "Reservation", field: "id", patch: { isOptional: true } })).toContain("主キー");
    expect(reason(DSL, { type: "addField", model: "Reservation", field: { name: "x", type: "Guest" } })).toContain("線を引いて");
  });

  it("参照先の列を消すと、ほかのテーブルからそれを参照する関連 (と対) も消す", () => {
    const out = apply(DSL, { type: "removeField", model: "Guest", field: "id" });
    expect(out).not.toContain("@relation");
    expect(out).not.toContain("Reservation[]");
    expect(out).toContain("guestId String");
  });

  it("@@id・@@unique などの一覧に使う列は消さない。複合主キーの列は NULL 可にしない", () => {
    const dsl = "model A {\n  a String\n  b String\n  @@id([a, b])\n}\n";
    expect(reason(dsl, { type: "removeField", model: "A", field: "a" })).toContain("@@id");
    expect(reason(dsl, { type: "updateField", model: "A", field: "a", patch: { isOptional: true } })).toContain("主キー");
  });

  it("外部キーの列を消すと、それを使う関連 (と相手側の対) も消す", () => {
    const out = apply(DSL, { type: "removeField", model: "Reservation", field: "guestId" });
    expect(out).not.toContain("guest");
    expect(out).not.toContain("reservations Reservation[]");
  });
});

describe("applyPrismaEdit: 関連", () => {
  const BASE = "model Room {\n  id Int @id\n}\n\nmodel Stay {\n  id     String @id\n  roomId Int\n}\n";

  it("列から列へ結ぶと、関連のフィールドと、相手側の対 (一覧) を足す", () => {
    const out = apply(BASE, { type: "addRelation", from: "Stay", fields: ["roomId"], to: "Room", references: ["id"] });
    expect(out).toContain("  room Room @relation(fields: [roomId], references: [id])");
    expect(out).toContain("  stays Stay[]");
    const lines = prismaRelationLines(parsePrismaDsl(out));
    expect(lines).toEqual([{ from: "Stay", field: "room", fields: ["roomId"], to: "Room", references: ["id"] }]);
  });

  it("外部キーが一意なら 1 対 1、NULL 可なら関連も NULL 可", () => {
    const dsl = BASE.replace("roomId Int", "roomId Int? @unique");
    const out = apply(dsl, { type: "addRelation", from: "Stay", fields: ["roomId"], to: "Room", references: ["id"] });
    expect(out).toContain("room Room? @relation(fields: [roomId], references: [id])");
    expect(out).toContain("  stay Stay?");
  });

  it("同じテーブルの間の 2 本目と、自分への関連には名前を付ける", () => {
    let out = apply(BASE, { type: "addRelation", from: "Stay", fields: ["roomId"], to: "Room", references: ["id"] });
    out = apply(out.replace("  roomId Int\n", "  roomId Int\n  nextRoomId Int\n"), { type: "addRelation", from: "Stay", fields: ["nextRoomId"], to: "Room", references: ["id"] });
    expect(out).toContain('nextRoom Room @relation("Stay_nextRoomId", fields: [nextRoomId], references: [id])');
    expect(out).toContain('stays2 Stay[] @relation("Stay_nextRoomId")');
    const self = apply("model Node {\n  id String @id\n  parentId String?\n}\n", { type: "addRelation", from: "Node", fields: ["parentId"], to: "Node", references: ["id"] });
    expect(self).toContain('parent Node? @relation("Node_parentId", fields: [parentId], references: [id])');
    expect(self).toContain('nodes Node[] @relation("Node_parentId")');
  });

  it("型が違う列、関連の列、すでにある関連は結ばない", () => {
    expect(reason(BASE.replace("roomId Int", "roomId String"), { type: "addRelation", from: "Stay", fields: ["roomId"], to: "Room", references: ["id"] })).toContain("型が違う");
    expect(reason(DSL, { type: "addRelation", from: "Reservation", fields: ["guestId"], to: "Guest", references: ["id"] })).toContain("もうあります");
    expect(reason(DSL, { type: "addRelation", from: "Reservation", fields: ["guest"], to: "Guest", references: ["id"] })).toContain("関連の列");
  });

  it("関連を消すと、両側のフィールドを消し、外部キーの列は残す", () => {
    const out = apply(DSL, { type: "removeRelation", model: "Reservation", field: "guest" });
    expect(out).toContain("guestId String");
    expect(out).not.toContain("@relation");
    expect(out).not.toContain("Reservation[]");
    // 対の側から消しても同じ
    expect(apply(DSL, { type: "removeRelation", model: "Guest", field: "reservations" })).toBe(out);
    expect(oppositeRelationField(parsePrismaDsl(DSL), "Reservation", "guest")).toEqual({ model: "Guest", field: "reservations" });
  });

  it("空いている名前", () => {
    expect(freePrismaModelName("model Table1 {\n  id String @id\n}")).toBe("Table2");
    expect(freePrismaFieldName(DSL, "Guest")).toBe("column1");
  });

  it("CRLF の DSL は CRLF のまま書く", () => {
    const out = apply(BASE.replace(/\n/g, "\r\n"), { type: "addField", model: "Room", field: { name: "name", type: "String" } });
    expect(out).toContain("  id Int @id\r\n  name String\r\n}");
  });
});

describe("editDatabaseDsl", () => {
  function model(): UntieModel {
    let m = emptyModel();
    m.elements = [{ id: "info_a", kind: "information", name: "予約", contextId: null } as UntieModel["elements"][number], { id: "sys_a", kind: "system", name: "予約システム" } as UntieModel["elements"][number], { id: "scr_1", kind: "screen", name: "一覧", systemId: "sys_a" } as UntieModel["elements"][number]];
    const ok = <T extends { ok: boolean }>(r: T) => {
      if (!r.ok) throw new Error(JSON.stringify(r));
      return (r as unknown as { model: UntieModel }).model;
    };
    m = ok(addDatabase(m, { id: "db_1", name: "DB" }));
    m = ok(setDatabaseDsl(m, { id: "db_1", dsl: DSL }));
    m = ok(setTableInformation(m, { id: "db_1", table: "Reservation", informationIds: ["info_a"] }));
    m = { ...m, designs: [
      {
        systemId: "sys_a",
        databaseIds: [],
        screens: [{ id: "ds_1", screenId: "scr_1", bindings: [{ item: "note", databaseId: "db_1", table: "Reservation", column: "note" }] }],
        transitions: [],
        layout: { shell: "shell", groups: [] },
      } as unknown as UntieModel["designs"][number],
    ] };
    return m;
  }

  it("テーブル・列の名前を変えると、情報の対応と画面の項目の対応も付いてくる", () => {
    let r = editDatabaseDsl(model(), { id: "db_1", edit: { type: "renameModel", from: "Reservation", to: "Booking" } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.model.databases[0]!.tables).toEqual([{ table: "Booking", informationIds: ["info_a"] }]);
    expect(r.model.designs[0]!.screens[0]!.bindings![0]).toMatchObject({ table: "Booking", column: "note" });
    r = editDatabaseDsl(r.model, { id: "db_1", edit: { type: "updateField", model: "Booking", field: "note", patch: { name: "memo" } } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.model.designs[0]!.screens[0]!.bindings![0]).toMatchObject({ table: "Booking", column: "memo" });
  });

  it("テーブルを消すと、情報の対応も消す", () => {
    const r = editDatabaseDsl(model(), { id: "db_1", edit: { type: "removeModel", name: "Reservation" } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.model.databases[0]!.tables).toEqual([]);
  });

  it("無いデータベース・失敗した操作は理由を返す", () => {
    expect(editDatabaseDsl(model(), { id: "db_x", edit: { type: "addModel", name: "A" } }).ok).toBe(false);
    const r = editDatabaseDsl(model(), { id: "db_1", edit: { type: "addModel", name: "Guest" } });
    expect(r.ok).toBe(false);
  });
});
