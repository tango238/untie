import { describe, expect, it } from "vitest";
import { clearAll, ensureDesign, moveToSystem, removeDesign, removeElement } from "../commands";
import { DEFAULT_DATABASE_ID, DESIGN_BOARD_KINDS, DESIGN_BOARD_LABELS, designBoardId, effectiveDatabaseIds, parseDesignBoardId } from "../design";
import { truncateModelStrings } from "../truncate";
import { designReferences } from "../selectors";
import { emptyModel, type UntieModel } from "../types";
import { validateModel } from "../validate";
import { expectFail, okModel } from "./helpers";

/** システム 2 つ・画面 2 つ・情報 1 つと、システム A の設計 (画面 2、遷移 1、ナビ 1) */
function designed(): UntieModel {
  const m = emptyModel();
  m.elements = [
    { id: "sys_a", kind: "system", name: "予約システム" },
    { id: "sys_b", kind: "system", name: "会計システム" },
    { id: "scr_a1", kind: "screen", name: "予約一覧", systemId: "sys_a" },
    { id: "scr_a2", kind: "screen", name: "予約詳細", systemId: "sys_a" },
    { id: "scr_b1", kind: "screen", name: "請求一覧", systemId: "sys_b" },
    { id: "info_1", kind: "information", name: "予約", contextId: null },
  ] as UntieModel["elements"];
  m.designs = [
    {
      systemId: "sys_a",
      databaseIds: ["db_default"],
      screens: [
        { id: "ds_top", source: { kind: "builtin", builtin: "top" } },
        { id: "ds_1", source: { kind: "screen", screenId: "scr_a1" }, view: { type: "page" }, bindings: [{ item: "名前", databaseId: "db_default", table: "Reservation", column: "name" }] },
        { id: "ds_2", source: { kind: "screen", screenId: "scr_a2" } },
      ],
      transitions: [
        { id: "tr_1", from: "ds_top", to: "ds_1", via: "nav" },
        { id: "tr_2", from: "ds_1", to: "ds_2", via: "row", label: "開く" },
      ],
      layout: { shell: "shell", navigation: [{ id: "nav_1", group: "予約", items: [{ screenId: "ds_1" }, { screenId: "ds_2", label: "詳細" }] }] },
    },
  ];
  m.databases = [{ id: "db_default", name: "既定のデータベース", dsl: "model Reservation {}", tables: [{ table: "Reservation", informationIds: ["info_1"] }] }];
  return m;
}

const errorsOf = (m: unknown) => {
  const r = validateModel(JSON.parse(JSON.stringify(m)));
  return r.ok ? [] : r.errors;
};

describe("設計ボードの id", () => {
  it("順序・ラベル・id の往復", () => {
    expect([...DESIGN_BOARD_KINDS]).toEqual(["sitemap", "navigation", "screen", "data", "relation", "domain"]);
    expect(DESIGN_BOARD_LABELS.domain).toBe("ドメイン");
    expect(DESIGN_BOARD_LABELS.sitemap).toBe("サイトマップ");
    expect(designBoardId("navigation")).toBe("design:navigation");
    for (const k of DESIGN_BOARD_KINDS) expect(parseDesignBoardId(designBoardId(k))).toBe(k);
    expect(parseDesignBoardId("design:unknown")).toBeNull();
    expect(parseDesignBoardId("fixed:business")).toBeNull();
  });
});

describe("validateModel: 設計データ (0.5.0)", () => {
  it("正しい設計は通る", () => {
    expect(errorsOf(designed())).toEqual([]);
    expect(validateModel(JSON.parse(JSON.stringify(designed()))).ok).toBe(true);
  });

  it("designs と databases が無いと、スキーマで落ちる", () => {
    const j = JSON.parse(JSON.stringify(emptyModel()));
    delete j.designs;
    const r = validateModel(j);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toContain("(全体): 必須項目「designs」がありません");
  });

  it("systemId が system を指さない・同じ systemId が 2 つ", () => {
    const missing = designed();
    missing.designs[0]!.systemId = "nothing";
    expect(errorsOf(missing).join()).toMatch(/システムが存在しません/);
    const notSystem = designed();
    notSystem.designs[0]!.systemId = "info_1";
    expect(errorsOf(notSystem).join()).toMatch(/システムではありません/);
    const dup = designed();
    dup.designs.push(JSON.parse(JSON.stringify(dup.designs[0])));
    expect(errorsOf(dup).join()).toMatch(/複数あります/);
  });

  it("databaseIds・bindings の databaseId が databases を指す", () => {
    const a = designed();
    a.designs[0]!.databaseIds = ["db_x"];
    expect(errorsOf(a).join()).toMatch(/データベース db_x が存在しません/);
    const b = designed();
    b.designs[0]!.screens[1]!.bindings![0]!.databaseId = "db_y";
    expect(errorsOf(b).join()).toMatch(/データベース db_y が存在しません/);
  });

  it("source.screenId は同じシステムの画面だけ", () => {
    const missing = designed();
    missing.designs[0]!.screens[1]!.source = { kind: "screen", screenId: "scr_none" };
    expect(errorsOf(missing).join()).toMatch(/scr_none が存在しません/);
    const other = designed();
    other.designs[0]!.screens[1]!.source = { kind: "screen", screenId: "scr_b1" };
    expect(errorsOf(other).join()).toMatch(/別のシステムの画面/);
    const notScreen = designed();
    notScreen.designs[0]!.screens[1]!.source = { kind: "screen", screenId: "sys_a" };
    expect(errorsOf(notScreen).join()).toMatch(/画面ではありません/);
  });

  it("遷移とナビゲーションは、同じ設計の画面を指す", () => {
    const from = designed();
    from.designs[0]!.transitions[0]!.from = "ds_none";
    expect(errorsOf(from).join()).toMatch(/遷移元 ds_none/);
    const to = designed();
    to.designs[0]!.transitions[0]!.to = "ds_none";
    expect(errorsOf(to).join()).toMatch(/遷移先 ds_none/);
    const nav = designed();
    nav.designs[0]!.layout.navigation[0]!.items[0]!.screenId = "ds_none";
    expect(errorsOf(nav).join()).toMatch(/ナビゲーション「予約」の画面 ds_none/);
    // メッセージにはシステム名を添える
    expect(errorsOf(nav).join()).toMatch(/設計「予約システム」\(sys_a\)/);
  });

  it("テーブルの informationIds は情報を指す。データベースの id は一意", () => {
    const a = designed();
    a.databases[0]!.tables[0]!.informationIds = ["info_none"];
    expect(errorsOf(a).join()).toMatch(/情報 info_none が存在しません/);
    const b = designed();
    b.databases[0]!.tables[0]!.informationIds = ["sys_a"];
    expect(errorsOf(b).join()).toMatch(/情報ではありません/);
    const c = designed();
    c.databases.push(JSON.parse(JSON.stringify(c.databases[0])));
    expect(errorsOf(c).join()).toMatch(/データベースの id が重複/);
  });

  it("画面・遷移・ナビのグループの id は設計をまたいで一意", () => {
    const m = designed();
    m.elements.push({ id: "sys_b", kind: "system", name: "会計" } as UntieModel["elements"][number]);
    const copy = JSON.parse(JSON.stringify(m.designs[0]));
    copy.systemId = "sys_b";
    copy.screens = copy.screens.filter((s: { source: { kind: string } }) => s.source.kind === "builtin");
    copy.transitions = [];
    copy.layout.navigation = [{ id: "nav_1", group: "x", items: [] }];
    m.designs.push(copy);
    const errors = errorsOf(m).join();
    expect(errors).toMatch(/画面の id が重複しています: ds_top/);
    expect(errors).toMatch(/グループの id が重複しています: nav_1/);
    const noId = JSON.parse(JSON.stringify(designed()));
    delete noId.designs[0].layout.navigation[0].id;
    expect(errorsOf(noId).join()).toMatch(/必須項目「id」/);
  });

  it("view は中身を検証しない (任意のオブジェクト)", () => {
    const m = designed();
    m.designs[0]!.screens[2]!.view = { anything: [1, { deep: true }], version: 2 };
    expect(errorsOf(m)).toEqual([]);
  });
});

describe("ensureDesign / removeDesign", () => {
  const base = () => {
    const m = emptyModel();
    m.elements = [{ id: "sys_a", kind: "system", name: "A" }] as UntieModel["elements"];
    return m;
  };

  it("設計と既定のデータベースを足す。2 回目は何も変えない", () => {
    const m = okModel(ensureDesign(base(), { systemId: "sys_a" }));
    expect(m.designs).toEqual([{ systemId: "sys_a", databaseIds: [], screens: [], transitions: [], layout: { shell: "shell", navigation: [] } }]);
    expect(m.databases).toEqual([{ id: DEFAULT_DATABASE_ID, name: "既定のデータベース", dsl: "", tables: [] }]);
    expect(validateModel(JSON.parse(JSON.stringify(m))).ok).toBe(true);
    expect(okModel(ensureDesign(m, { systemId: "sys_a" }))).toBe(m);
  });

  it("データベースがあれば足さない。システムでなければ失敗", () => {
    const b = base();
    b.databases = [{ id: "db_x", name: "x", dsl: "", tables: [] }];
    expect(okModel(ensureDesign(b, { systemId: "sys_a" })).databases).toHaveLength(1);
    expectFail(ensureDesign(base(), { systemId: "nothing" }), /システムが存在しません/);
  });

  it("removeDesign は設計だけを消し、データベースは残す", () => {
    const m = okModel(removeDesign(designed(), { systemId: "sys_a" }));
    expect(m.designs).toEqual([]);
    expect(m.databases).toHaveLength(1);
    expectFail(removeDesign(m, { systemId: "sys_a" }), /設計が存在しません/);
  });

  it("clearAll は設計とデータベースも消す", () => {
    const m = okModel(clearAll(designed()));
    expect(m.designs).toEqual([]);
    expect(m.databases).toEqual([]);
  });
});

describe("removeElement: 設計データの連鎖", () => {
  it("システムを消すと、その設計も消える。データベースは残る", () => {
    const m = okModel(removeElement(designed(), { id: "sys_a" }));
    expect(m.designs).toEqual([]);
    expect(m.databases).toHaveLength(1);
    expect(validateModel(JSON.parse(JSON.stringify(m))).ok).toBe(true);
  });

  it("別のシステムを消しても設計は残る", () => {
    expect(okModel(removeElement(designed(), { id: "sys_b" })).designs).toHaveLength(1);
  });

  it("画面を消すと、設計の画面と、それを参照する遷移・ナビゲーションの項目が消える", () => {
    const m = okModel(removeElement(designed(), { id: "scr_a1" }));
    const d = m.designs[0]!;
    expect(d.screens.map((s) => s.id)).toEqual(["ds_top", "ds_2"]);
    expect(d.transitions).toEqual([]);
    expect(d.layout.navigation).toEqual([{ id: "nav_1", group: "予約", items: [{ screenId: "ds_2", label: "詳細" }] }]);
    expect(validateModel(JSON.parse(JSON.stringify(m))).ok).toBe(true);
  });

  it("情報を消すと、テーブルの対応から外れ、表す情報が無くなったテーブルの項目は消える。データベースは残る", () => {
    const m = okModel(removeElement(designed(), { id: "info_1" }));
    expect(m.databases).toHaveLength(1);
    expect(m.databases[0]!.tables).toEqual([]);
  });
});

describe("designReferences", () => {
  it("システム: 設計の要約", () => {
    expect(designReferences(designed(), "sys_a")).toEqual(["「予約システム」の設計 (画面 3、遷移 2、画面 UI 1、ナビゲーション 2)"]);
  });

  it("画面: その画面だけが巻き込むもの", () => {
    expect(designReferences(designed(), "scr_a1")).toEqual(["「予約システム」の設計 (画面 1、遷移 2、画面 UI 1、ナビゲーション 1)"]);
    expect(designReferences(designed(), "scr_a2")).toEqual(["「予約システム」の設計 (画面 1、遷移 1、ナビゲーション 1)"]);
  });

  it("情報: テーブルとの対応", () => {
    expect(designReferences(designed(), "info_1")).toEqual(["テーブルとの対応 1"]);
  });

  it("参照されていない要素・空の設計・存在しない id は空", () => {
    const m = designed();
    expect(designReferences(m, "sys_b")).toEqual([]);
    expect(designReferences(m, "scr_b1")).toEqual([]);
    expect(designReferences(m, "none")).toEqual([]);
    expect(designReferences(okModel(ensureDesign(emptyModelWith(), { systemId: "sys_a" })), "sys_a")).toEqual([]);
  });
});

function emptyModelWith(): UntieModel {
  const m = emptyModel();
  m.elements = [{ id: "sys_a", kind: "system", name: "A" }] as UntieModel["elements"];
  return m;
}

describe("moveToSystem: 設計の後始末", () => {
  it("画面を別のシステムへ移すと、それを指す設計の画面・遷移・ナビの項目が外れる (removeElement と同じ範囲)", () => {
    const m = okModel(moveToSystem(designed(), { elementId: "scr_a1", systemId: "sys_b" }));
    const d = m.designs[0]!;
    expect(d.screens.map((s) => s.id)).toEqual(["ds_top", "ds_2"]);
    expect(d.transitions).toEqual([]);
    expect(d.layout.navigation[0]!.items).toEqual([{ screenId: "ds_2", label: "詳細" }]);
    expect(validateModel(JSON.parse(JSON.stringify(m))).ok).toBe(true);
    expect(designReferences(designed(), "scr_a1")).toEqual(["「予約システム」の設計 (画面 1、遷移 2、画面 UI 1、ナビゲーション 1)"]);
  });

  it("同じシステムへの移動・非機能要件・設計に使われていない画面は設計に触れない", () => {
    const base = designed();
    expect(okModel(moveToSystem(base, { elementId: "scr_a1", systemId: "sys_a" }))).toBe(base);
    expect(okModel(moveToSystem(base, { elementId: "scr_b1", systemId: "sys_a" })).designs).toEqual(base.designs);
  });
});

describe("effectiveDatabaseIds", () => {
  it("指定があればそれ。空なら db_default、無ければ先頭、それも無ければ無し", () => {
    const m = designed();
    const d = m.designs[0]!;
    expect(effectiveDatabaseIds(m, d)).toEqual(["db_default"]);
    d.databaseIds = ["db_x"];
    expect(effectiveDatabaseIds(m, d)).toEqual(["db_x"]);
    d.databaseIds = [];
    expect(effectiveDatabaseIds(m, d)).toEqual(["db_default"]);
    m.databases = [{ id: "db_a", name: "a", dsl: "", tables: [] }, { id: "db_b", name: "b", dsl: "", tables: [] }];
    expect(effectiveDatabaseIds(m, d)).toEqual(["db_a"]);
    m.databases = [];
    expect(effectiveDatabaseIds(m, d)).toEqual([]);
  });
});

describe("truncateModelStrings: 設計の name 型の文字列", () => {
  it("ナビ・遷移・header・bindings・テーブル名・データベース名を上限まで切り詰め、検証に通る", () => {
    const long = "あ".repeat(201);
    const m = designed();
    const d = m.designs[0]!;
    d.layout.navigation[0]!.group = long;
    d.layout.navigation[0]!.items[0]!.label = long;
    d.layout.header = { systemName: long, userName: long, tenantName: long };
    d.transitions[1]!.label = long;
    d.screens[1]!.bindings = [{ item: long, databaseId: "db_default", table: long, column: long }];
    m.databases[0]!.name = long;
    m.databases[0]!.tables[0]!.table = long;
    m.databases[0]!.dsl = "x".repeat(200001);
    expect(validateModel(JSON.parse(JSON.stringify(m))).ok).toBe(false);
    const { model, changes } = truncateModelStrings(m);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.join()).not.toContain("あああ");
    expect(validateModel(JSON.parse(JSON.stringify(model))).ok).toBe(true);
    expect(model.designs[0]!.layout.navigation[0]!.group).toHaveLength(200);
    expect(model.databases[0]!.dsl).toHaveLength(200000);
    // 切るものが無ければ同じ参照
    const ok = designed();
    expect(truncateModelStrings(ok).model).toBe(ok);
  });
});
