import { describe, expect, it } from "vitest";
import {
  addDatabase,
  setDatabaseDesign,
  removeDatabase,
  removeElement,
  renameDatabase,
  setDatabaseDsl,
  setDesignDatabases,
  setTableInformation,
} from "../commands";
import { DSL_MAX_LENGTH } from "../limits";
import { addScaffold, databaseBindingCount, designsUsingDatabase, systemInformationIds, tablesOfInformation } from "../designData";
import { checkAllDesigns, checkDesign } from "../designCheck";
import { parsePrismaDsl } from "../prisma";
import { emptyModel, type UntieModel } from "../types";
import { validateModel } from "../validate";
import { retailSample } from "../../sample";
import { expectFail, okModel } from "./helpers";

/** システム 2 つ。A: 画面 2 (を使う操作が情報 b, c を扱う)、システムを対象にした操作が情報 a, d を扱う。B: 操作が情報 e を扱う */
function base(): UntieModel {
  const m = emptyModel();
  m.elements = [
    { id: "sys_a", kind: "system", name: "予約システム" },
    { id: "sys_b", kind: "system", name: "会計システム" },
    { id: "scr_1", kind: "screen", name: "予約一覧", systemId: "sys_a" },
    { id: "scr_2", kind: "screen", name: "予約詳細", systemId: "sys_a" },
    { id: "info_a", kind: "information", name: "予約", contextId: null },
    { id: "info_b", kind: "information", name: "客", contextId: null },
    { id: "info_c", kind: "information", name: "部屋", contextId: null },
    { id: "info_d", kind: "information", name: "あ取得元", contextId: null },
    { id: "info_e", kind: "information", name: "請求", contextId: null },
    { id: "uc_1", kind: "usecase", name: "一覧を見る" },
    { id: "uc_2", kind: "usecase", name: "詳細を見る" },
    { id: "uc_3", kind: "usecase", name: "予約を保存する" },
    { id: "uc_4", kind: "usecase", name: "請求を保存する" },
  ] as UntieModel["elements"];
  const rel = (kind: string, sourceId: string, targetId: string) => ({ id: `rel_${sourceId}_${targetId}`, kind, sourceId, targetId });
  m.relations = [
    rel("usecaseScreen", "uc_1", "scr_1"),
    rel("usecaseInformation", "uc_1", "info_b"),
    rel("usecaseScreen", "uc_2", "scr_2"),
    rel("usecaseInformation", "uc_2", "info_c"),
    rel("usecaseInformation", "uc_2", "info_b"),
    rel("usecaseSystem", "uc_3", "sys_a"),
    rel("usecaseInformation", "uc_3", "info_a"),
    rel("usecaseInformation", "uc_3", "info_d"),
    rel("usecaseSystem", "uc_4", "sys_b"),
    rel("usecaseInformation", "uc_4", "info_e"),
  ] as UntieModel["relations"];
  return m;
}

const withDb = (m: UntieModel): UntieModel => okModel(setDesignDatabases(m, { systemId: "sys_a", databaseIds: [] }));
const dbs = (m: UntieModel) => m.databases;

describe("systemInformationIds", () => {
  it("システムを対象にした操作と、そのシステムの画面を使う操作が扱う情報を、名前順で返す", () => {
    expect(systemInformationIds(base(), "sys_a")).toEqual(["info_d", "info_b", "info_c", "info_a"]);
    expect(systemInformationIds(base(), "sys_b")).toEqual(["info_e"]);
  });

  it("関係のないシステムや、情報でないものは入れない", () => {
    expect(systemInformationIds(base(), "none")).toEqual([]);
  });
});

describe("データベースのコマンド", () => {
  it("addDatabase: db_ の id を作り、名前は trim・必須・上限つき", () => {
    const r = addDatabase(base(), { name: " 分析用 " });
    expect(r.ok && r.id.startsWith("db_")).toBe(true);
    const m = okModel(r);
    expect(dbs(m)).toEqual([{ id: (r as { id: string }).id, name: "分析用", dsl: "", tables: [] }]);
    expectFail(addDatabase(base(), { name: "  " }), /名前が必要/);
    expectFail(addDatabase(base(), { name: "あ".repeat(201) }), /200/);
    const fixed = okModel(addDatabase(base(), { id: "db_x", name: "x" }));
    expectFail(addDatabase(fixed, { id: "db_x", name: "y" }), /すでに使われています/);
    expect(validateModel(JSON.parse(JSON.stringify(fixed))).ok).toBe(true);
  });

  it("renameDatabase", () => {
    const m = okModel(addDatabase(base(), { id: "db_x", name: "x" }));
    expect(dbs(okModel(renameDatabase(m, { id: "db_x", name: " y " })))[0]!.name).toBe("y");
    expectFail(renameDatabase(m, { id: "db_none", name: "y" }), /存在しません/);
    expectFail(renameDatabase(m, { id: "db_x", name: "" }), /名前が必要/);
  });

  it("setDatabaseDsl: 上限を超えると失敗し、解析エラーのある DSL も保存する", () => {
    const m = okModel(addDatabase(base(), { id: "db_x", name: "x" }));
    const saved = okModel(setDatabaseDsl(m, { id: "db_x", dsl: "こわれ" }));
    expect(dbs(saved)[0]!.dsl).toBe("こわれ");
    expectFail(setDatabaseDsl(m, { id: "db_x", dsl: "a".repeat(DSL_MAX_LENGTH + 1) }), /DSL/);
    expect(okModel(setDatabaseDsl(m, { id: "db_x", dsl: "a".repeat(DSL_MAX_LENGTH) })).databases[0]!.dsl).toHaveLength(DSL_MAX_LENGTH);
    expectFail(setDatabaseDsl(m, { id: "db_none", dsl: "" }), /存在しません/);
    // 変わらなければ同じモデルを返す
    expect(okModel(setDatabaseDsl(saved, { id: "db_x", dsl: "こわれ" }))).toBe(saved);
  });

  it("setTableInformation: 置き換え・重複除去・空で項目を消す・存在しない情報は失敗", () => {
    let m = okModel(addDatabase(base(), { id: "db_x", name: "x" }));
    m = okModel(setTableInformation(m, { id: "db_x", table: "Guest", informationIds: ["info_b", "info_b", "info_c"] }));
    expect(dbs(m)[0]!.tables).toEqual([{ table: "Guest", informationIds: ["info_b", "info_c"] }]);
    m = okModel(setTableInformation(m, { id: "db_x", table: "Guest", informationIds: ["info_b"] }));
    expect(dbs(m)[0]!.tables).toEqual([{ table: "Guest", informationIds: ["info_b"] }]);
    expect(tablesOfInformation(dbs(m)[0]!, "info_b")).toEqual(["Guest"]);
    expectFail(setTableInformation(m, { id: "db_x", table: "Guest", informationIds: ["nope"] }), /情報が存在しません/);
    expectFail(setTableInformation(m, { id: "db_x", table: "Guest", informationIds: ["sys_a"] }), /情報が存在しません/);
    expectFail(setTableInformation(m, { id: "db_none", table: "Guest", informationIds: [] }), /存在しません/);
    m = okModel(setTableInformation(m, { id: "db_x", table: "Guest", informationIds: [] }));
    expect(dbs(m)[0]!.tables).toEqual([]);
    // 無いテーブルを空にしても何も起きない
    expect(okModel(setTableInformation(m, { id: "db_x", table: "Zzz", informationIds: [] })).databases[0]!.tables).toEqual([]);
  });

  it("setTableInformation / setDatabaseDesign: テーブル名は trim し、識別子でなければ失敗", () => {
    const m = okModel(addDatabase(base(), { id: "db_x", name: "x" }));
    const t = okModel(setTableInformation(m, { id: "db_x", table: " Guest ", informationIds: ["info_b"] }));
    expect(t.databases[0]!.tables).toEqual([{ table: "Guest", informationIds: ["info_b"] }]);
    expectFail(setTableInformation(m, { id: "db_x", table: "客", informationIds: ["info_b"] }), /英数字/);
    expectFail(setTableInformation(m, { id: "db_x", table: "a b", informationIds: [] }), /英数字/);
    const d = okModel(setDatabaseDesign(m, { id: "db_x", dsl: "", tables: [{ table: " A ", informationIds: ["info_a"] }, { table: "A", informationIds: ["info_b"] }] }));
    expect(d.databases[0]!.tables).toEqual([{ table: "A", informationIds: ["info_a", "info_b"] }]);
    expectFail(setDatabaseDesign(m, { id: "db_x", dsl: "", tables: [{ table: "1-x", informationIds: [] }] }), /英数字/);
  });

  it("setDesignDatabases: 設計を作り、存在しないデータベースは失敗", () => {
    let m = okModel(addDatabase(base(), { id: "db_x", name: "x" }));
    expect(m.designs).toEqual([]);
    m = okModel(setDesignDatabases(m, { systemId: "sys_a", databaseIds: ["db_x", "db_x"] }));
    expect(m.designs[0]!.databaseIds).toEqual(["db_x"]);
    expectFail(setDesignDatabases(m, { systemId: "sys_a", databaseIds: ["db_none"] }), /存在しません/);
    expectFail(setDesignDatabases(m, { systemId: "scr_1", databaseIds: [] }), /システムが存在しません/);
    expect(designsUsingDatabase(m, "db_x")).toEqual([{ systemId: "sys_a", explicit: true }]);
  });

  it("使う設計: 何もチェックが無い設計は既定の規則で db_default を使う", () => {
    const m = withDb(base());
    expect(designsUsingDatabase(m, "db_default")).toEqual([{ systemId: "sys_a", explicit: false }]);
  });

  it("removeDatabase: 全設計の使うデータベースと bindings から外す", () => {
    let m = okModel(addDatabase(withDb(base()), { id: "db_x", name: "x" }));
    m = okModel(setDesignDatabases(m, { systemId: "sys_a", databaseIds: ["db_x", "db_default"] }));
    m = {
      ...m,
      designs: m.designs.map((d) => ({
        ...d,
        screens: [
          {
            id: "ds_1",
            source: { kind: "screen", screenId: "scr_1" },
            bindings: [
              { item: "a", databaseId: "db_x", table: "T", column: "c" },
              { item: "b", databaseId: "db_default", table: "T", column: "c" },
            ],
          },
          { id: "ds_2", source: { kind: "screen", screenId: "scr_2" }, bindings: [{ item: "a", databaseId: "db_x", table: "T", column: "c" }] },
        ],
      })),
    } as UntieModel;
    expect(databaseBindingCount(m, "db_x")).toBe(2);
    const after = okModel(removeDatabase(m, { id: "db_x" }));
    expect(after.databases.map((d) => d.id)).toEqual(["db_default"]);
    expect(after.designs[0]!.databaseIds).toEqual(["db_default"]);
    expect(after.designs[0]!.screens[0]!.bindings).toEqual([{ item: "b", databaseId: "db_default", table: "T", column: "c" }]);
    expect(after.designs[0]!.screens[1]!.bindings).toBeUndefined();
    expect(validateModel(JSON.parse(JSON.stringify(after))).ok).toBe(true);
    expectFail(removeDatabase(after, { id: "db_x" }), /存在しません/);
  });

  it("情報を消すとテーブルの対応から外れ、空になった項目は消える", () => {
    let m = withDb(base());
    m = okModel(setTableInformation(m, { id: "db_default", table: "Guest", informationIds: ["info_b"] }));
    m = okModel(removeElement(m, { id: "info_b" }));
    expect(m.databases[0]!.tables).toEqual([]);
  });
});

describe("addScaffold", () => {
  it("まだ対応していない情報の雛形を DSL の末尾に足し、対応も足す", () => {
    let m = withDb(base());
    m = okModel(setDatabaseDsl(m, { id: "db_default", dsl: "model Table1 {\n  id String @id\n}" }));
    m = okModel(setTableInformation(m, { id: "db_default", table: "Table1", informationIds: ["info_a"] }));
    const r = addScaffold(m, "sys_a", "db_default");
    expect(r.ok && r.added).toBe(3);
    const next = okModel(r);
    const db = next.databases[0]!;
    const schema = parsePrismaDsl(db.dsl);
    expect(schema.errors).toEqual([]);
    expect(schema.models.map((x) => x.name)).toEqual(["Table1", "Table2", "Table3", "Table4"]);
    expect(schema.models[1]!.mapName).toBe("あ取得元");
    expect(db.dsl).toContain("// TODO: 名前を直す");
    expect(db.tables.map((t) => [t.table, t.informationIds])).toEqual([
      ["Table1", ["info_a"]],
      ["Table2", ["info_d"]],
      ["Table3", ["info_b"]],
      ["Table4", ["info_c"]],
    ]);
    // 全部対応済みなら何も変えない
    expect(addScaffold(next, "sys_a", "db_default")).toMatchObject({ ok: true, added: 0, model: next });
  });

  it("日本語名の引用符は逃がし、空の DSL からは先頭から始める", () => {
    let m = withDb(base());
    m = { ...m, elements: m.elements.map((e) => (e.id === "info_a" ? { ...e, name: '予約 "A"' } : e)) } as UntieModel;
    const next = okModel(addScaffold(m, "sys_a", "db_default"));
    expect(next.databases[0]!.dsl.startsWith("// TODO")).toBe(true);
    expect(parsePrismaDsl(next.databases[0]!.dsl).errors).toEqual([]);
    expectFail(addScaffold(m, "sys_a", "db_none"), /存在しません/);
  });
});

describe("checkDesign", () => {
  const prep = (dsl: string, tables: { table: string; informationIds: string[] }[]) => {
    let m = withDb(base());
    m = okModel(setDatabaseDsl(m, { id: "db_default", dsl }));
    for (const t of tables) m = okModel(setTableInformation(m, { id: "db_default", table: t.table, informationIds: t.informationIds }));
    return m;
  };
  const types = (list: { type: string }[]) => list.map((p) => p.type);

  it("設計の無いシステムは検査しない", () => {
    expect(checkDesign(base(), "sys_a")).toEqual({ problems: [], warnings: [] });
    expect(checkAllDesigns(base())).toEqual([]);
  });

  it("(a) 対応していない情報、(b) DSL に無いテーブル", () => {
    const m = prep("model Guest { id String @id }", [{ table: "Guest", informationIds: ["info_b"] }, { table: "Ghost", informationIds: ["info_a"] }]);
    const r = checkDesign(m, "sys_a");
    expect(types(r.problems)).toEqual(["informationUnmapped", "informationUnmapped", "tableMissing"]);
    expect(r.problems.filter((p) => p.type === "informationUnmapped").map((p) => p.target)).toEqual([
      { kind: "information", id: "info_d" },
      { kind: "information", id: "info_c" },
    ]);
    expect(r.problems[2]!.target).toEqual({ kind: "table", id: "db_default", table: "Ghost" });
  });

  it("(c) DSL の解析エラーを DB ごとに 1 件にまとめる", () => {
    const m = prep("model A {\n 1x Int\n 2y Int\n}", []);
    const r = checkDesign(m, "sys_a");
    const dsl = r.problems.filter((p) => p.type === "dslError");
    expect(dsl).toHaveLength(1);
    expect(dsl[0]!.message).toContain("2 件");
    expect(dsl[0]!.target).toEqual({ kind: "database", id: "db_default" });
  });

  it("(d) bindings が無い DB・テーブル・列を指す", () => {
    let m = prep("model Guest { id String @id }", []);
    m = {
      ...m,
      designs: m.designs.map((d) => ({
        ...d,
        screens: [
          {
            id: "ds_1",
            source: { kind: "screen", screenId: "scr_1" },
            view: {},
            bindings: [
              { item: "ok", databaseId: "db_default", table: "Guest", column: "id" },
              { item: "列", databaseId: "db_default", table: "Guest", column: "zzz" },
              { item: "表", databaseId: "db_default", table: "Nope", column: "id" },
              { item: "DB", databaseId: "db_gone", table: "Guest", column: "id" },
            ],
          },
        ],
      })),
    } as UntieModel;
    const r = checkDesign(m, "sys_a").problems.filter((p) => p.type === "bindingInvalid");
    expect(r).toHaveLength(3);
    expect(r.every((p) => p.target?.kind === "screen" && p.target.id === "ds_1")).toBe(true);
  });

  it("(e) 使うデータベースが 1 つも無い", () => {
    const m = okModel(setDesignDatabases(base(), { systemId: "sys_a", databaseIds: [] }));
    const none = { ...m, databases: [] } as UntieModel;
    expect(types(checkDesign(none, "sys_a").problems)).toEqual(["noDatabase"]);
  });

  it("警告: 遷移のきっかけが未定、画面 UI が無い (画面が無ければ出さない)", () => {
    let m = prep("", []);
    expect(checkDesign(m, "sys_a").warnings).toEqual([]);
    m = {
      ...m,
      designs: m.designs.map((d) => ({
        ...d,
        screens: [
          { id: "ds_1", source: { kind: "screen", screenId: "scr_1" }, view: {} },
          { id: "ds_2", source: { kind: "screen", screenId: "scr_2" } },
        ],
        transitions: [
          { id: "tr_1", from: "ds_1", to: "ds_2" },
          { id: "tr_2", from: "ds_2", to: "ds_1", via: "button" },
        ],
      })),
    } as UntieModel;
    const w = checkDesign(m, "sys_a").warnings;
    // 画面 UI の無い画面は 1 行にまとめ、画面ボードへ移る
    expect(w.map((x) => [x.type, x.target])).toEqual([
      ["transitionViaUndecided", { kind: "transition", id: "tr_1" }],
      ["screenWithoutView", { kind: "board", id: "screen" }],
    ]);
    expect(w[0]!.message).toContain("予約一覧");
    expect(w[1]!.message).toContain("1 件");
  });

  it("対応がそろい、DSL に問題がなければエラーは無い", () => {
    const m = prep("model T { id String @id }", [{ table: "T", informationIds: ["info_a", "info_b", "info_c", "info_d"] }]);
    expect(checkDesign(m, "sys_a").problems).toEqual([]);
  });
});

describe("店舗サンプルの設計データ", () => {
  it("POSレジの設計の検証はエラー 0 で、警告は遷移の未定と画面 UI 無しだけ", () => {
    const results = checkAllDesigns(retailSample);
    expect(results.map((r) => r.systemId)).toEqual(["sys_pos"]);
    expect(results[0]!.problems).toEqual([]);
    expect([...new Set(results[0]!.warnings.map((w) => w.type))].sort()).toEqual(["screenWithoutView", "transitionViaUndecided"]);
  });

  it("DSL は 5〜8 の model と enum を含み、解析エラーが無い", () => {
    const db = retailSample.databases[0]!;
    const s = parsePrismaDsl(db.dsl);
    expect(s.errors).toEqual([]);
    expect(s.models.length).toBeGreaterThanOrEqual(5);
    expect(s.models.length).toBeLessThanOrEqual(8);
    expect(s.enums.length).toBeGreaterThan(0);
    expect(s.models.some((m) => m.fields.some((f) => f.relation))).toBe(true);
    expect(validateModel(JSON.parse(JSON.stringify(retailSample))).ok).toBe(true);
  });
});
