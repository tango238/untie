import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { emptyModel, ensureDesign, removeElement, validateModel } from "@untie/core";
import type { SystemDesign, UntieModel } from "@untie/core";
import { applyModelDiff, getRoots, loadModel, observeModelChanges, readModel, rebuildModel, repairDoc } from "..";
import { cloneDoc } from "./helpers";

function designed(): UntieModel {
  const m = emptyModel();
  m.elements = [
    { id: "sys_a", kind: "system", name: "予約システム" },
    { id: "scr_1", kind: "screen", name: "一覧", systemId: "sys_a" },
    { id: "scr_2", kind: "screen", name: "詳細", systemId: "sys_a" },
    { id: "info_1", kind: "information", name: "予約", contextId: null },
  ] as UntieModel["elements"];
  m.databases = [
    { id: "db_default", name: "既定のデータベース", dsl: "model A {}", tables: [{ table: "A", informationIds: ["info_1"] }] },
    { id: "db_two", name: "二つ目", dsl: "", tables: [] },
  ];
  m.designs = [
    {
      systemId: "sys_a",
      databaseIds: ["db_default"],
      screens: [
        { id: "ds_top", source: { kind: "builtin", builtin: "top" } },
        { id: "ds_1", source: { kind: "screen", screenId: "scr_1" }, view: { type: "page", children: [] }, bindings: [{ item: "名前", databaseId: "db_default", table: "A", column: "name" }] },
        { id: "ds_2", source: { kind: "screen", screenId: "scr_2" } },
      ],
      transitions: [
        { id: "tr_1", from: "ds_top", to: "ds_1", via: "nav" },
        { id: "tr_2", from: "ds_1", to: "ds_2", label: "開く" },
      ],
      layout: { shell: "shell", header: { systemName: "予約" }, navigation: [{ id: "nav_1", group: "予約", items: [{ screenId: "ds_1" }, { screenId: "ds_2", label: "詳細" }] }] },
    },
  ];
  return m;
}

const fresh = (m: UntieModel) => {
  const doc = new Y.Doc();
  loadModel(doc, m);
  return doc;
};

/** before → after を Y.Doc に差分で書いて、組み立て直した結果を返す */
function apply(before: UntieModel, edit: (m: UntieModel) => UntieModel) {
  const doc = fresh(before);
  const after = edit(JSON.parse(JSON.stringify(before)));
  applyModelDiff(doc, before, after, "local");
  return { doc, after };
}

describe("設計データの往復", () => {
  it("loadModel → rebuildModel で元と同じになる。order は出ない", () => {
    const m = designed();
    const rebuilt = rebuildModel(fresh(m));
    expect(rebuilt).toStrictEqual(m);
    expect(JSON.stringify(rebuilt.designs)).not.toContain('"order"');
    expect(validateModel(JSON.parse(JSON.stringify(rebuilt))).ok).toBe(true);
  });

  it("空の設計・データベース無しでも往復できる", () => {
    const m = emptyModel();
    expect(rebuildModel(fresh(m))).toStrictEqual(m);
  });

  it("Y.Doc の粒度: 平らなキーに JSON の値で置く。入れ子の Y.Map は使わない", () => {
    const roots = getRoots(fresh(designed()));
    expect(roots.designs.get("sys_a/meta")).toMatchObject({ databaseIds: ["db_default"] });
    expect(roots.designs.get("sys_a/layout")).toEqual({ shell: "shell", header: { systemName: "予約" } });
    expect([...roots.designScreens.keys()]).toEqual(["ds_top", "ds_1", "ds_2"]);
    expect(roots.designScreens.get("ds_1")).toMatchObject({ systemId: "sys_a", id: "ds_1", source: { kind: "screen", screenId: "scr_1" } });
    expect([...roots.designTransitions.keys()]).toEqual(["tr_1", "tr_2"]);
    expect(roots.designTransitions.get("tr_2")).toMatchObject({ systemId: "sys_a", from: "ds_1", to: "ds_2", label: "開く" });
    expect(roots.designNav.get("nav_1")).toMatchObject({ systemId: "sys_a", group: "予約" });
    expect(roots.databases.get("db_default/name")).toBe("既定のデータベース");
    expect(roots.databases.get("db_default/dsl")).toBe("model A {}");
    expect(roots.databases.get("db_default/tables")).toEqual([{ table: "A", informationIds: ["info_1"] }]);
    for (const m of [roots.designs, roots.designScreens, roots.designTransitions, roots.designNav, roots.databases]) {
      for (const v of m.values()) expect(v instanceof Y.AbstractType).toBe(false);
    }
  });

  it("形の壊れた項目は読み飛ばす (スキーマの検証関数で読む時点で)", () => {
    const doc = fresh(designed());
    const roots = getRoots(doc);
    roots.designScreens.set("ds_bad1", { systemId: "sys_a", id: "ds_bad1", source: { kind: "nothing" }, order: "z1" });
    roots.designScreens.set("ds_bad2", { systemId: "sys_a", id: "ds_bad2", source: { kind: "builtin", builtin: "top" }, view: "文字列" as never, order: "z2" });
    roots.designScreens.set("ds_bad3", { systemId: "sys_a", id: "ds_bad3", source: { kind: "builtin", builtin: "nothing" }, order: "z2" } as never);
    roots.designTransitions.set("tr_bad", { systemId: "sys_a", id: "tr_bad", from: 1 as never, to: "ds_1", order: "z3" });
    roots.designNav.set("nav_bad", { systemId: "sys_a", id: "nav_bad", group: "x", items: "壊れた", order: "z4" });
    // 設計が無い (消えた) システムの画面・遷移・ナビは読み飛ばす
    roots.designScreens.set("ds_orphan", { systemId: "sys_gone", id: "ds_orphan", source: { kind: "builtin", builtin: "top" }, order: "z5" });
    roots.designNav.set("nav_orphan", { systemId: "sys_gone", id: "nav_orphan", group: "x", items: [], order: "z6" });
    roots.designs.set("sys_broken/meta", { databaseIds: "壊れた" as never, order: "z7" });
    roots.databases.set("db_bad/name", "名前だけ");
    roots.databases.set("db_bad2/name", "dsl が壊れた");
    roots.databases.set("db_bad2/dsl", 1);
    roots.databases.set("db_bad2/tables", []);
    expect(readModel(doc)).toStrictEqual(designed());
  });

  it("レイアウトが壊れている・無いときは既定値で補い、画面と遷移は残す", () => {
    for (const layout of [undefined, { shell: "壊れた" }, "x"]) {
      const doc = fresh(designed());
      const roots = getRoots(doc);
      if (layout === undefined) roots.designs.delete("sys_a/layout");
      else roots.designs.set("sys_a/layout", layout);
      const d = readModel(doc).designs[0]!;
      expect(d.layout.shell).toBe("shell");
      expect(d.layout.header).toBeUndefined();
      expect(d.screens).toHaveLength(3);
      expect(d.transitions).toHaveLength(2);
      expect(d.layout.navigation).toHaveLength(1);
    }
  });
});

describe("同時に作っても負けない", () => {
  const sync = (a: Y.Doc, b: Y.Doc) => {
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  };
  const base = () => {
    const m = emptyModel();
    m.elements = [
      { id: "sys_a", kind: "system", name: "A" },
      { id: "sys_b", kind: "system", name: "B" },
    ] as UntieModel["elements"];
    return m;
  };
  const edit = (doc: Y.Doc, before: UntieModel, fn: (m: UntieModel) => UntieModel) => {
    const after = fn(JSON.parse(JSON.stringify(before)));
    applyModelDiff(doc, before, after, "local");
    return after;
  };
  const ensure = (m: UntieModel, id: string) => {
    const r = ensureDesign(m, { systemId: id });
    if (!r.ok) throw new Error(r.reason);
    return r.model;
  };

  it("別々のシステムを 2 人が同時に ensureDesign しても、両方の設計が残り、既定のデータベースは 1 つ", () => {
    const b = base();
    const a = fresh(b);
    const c = cloneDoc(a);
    edit(a, b, (m) => ensure(m, "sys_a"));
    edit(c, b, (m) => ensure(m, "sys_b"));
    sync(a, c);
    const merged = rebuildModel(a);
    expect(rebuildModel(c)).toStrictEqual(merged);
    expect(merged.designs.map((d) => d.systemId).sort()).toEqual(["sys_a", "sys_b"]);
    expect(merged.databases.map((d) => d.id)).toEqual(["db_default"]);
    expect(validateModel(JSON.parse(JSON.stringify(merged))).ok).toBe(true);
  });

  it("同じシステムを 2 人が同時に ensureDesign したあと、それぞれが画面を足しても両方残る", () => {
    const b = base();
    const a = fresh(b);
    const c = cloneDoc(a);
    const ma = edit(a, b, (m) => ensure(m, "sys_a"));
    const mc = edit(c, b, (m) => ensure(m, "sys_a"));
    sync(a, c);
    expect(rebuildModel(a).designs).toHaveLength(1);
    const add = (id: string) => (m: UntieModel) => {
      m.designs[0]!.screens.push({ id, source: { kind: "builtin", builtin: id === "ds_a" ? "top" : "signIn" } });
      return m;
    };
    edit(a, ma, add("ds_a"));
    edit(c, mc, add("ds_c"));
    sync(a, c);
    expect(rebuildModel(a).designs[0]!.screens.map((s) => s.id).sort()).toEqual(["ds_a", "ds_c"]);
  });

  it("設計がある状態で、2 人が別々の画面・別々のナビのグループを同時に足すと、両方残る", () => {
    const b = ensure(base(), "sys_a");
    const a = fresh(b);
    const c = cloneDoc(a);
    edit(a, b, (m) => {
      m.designs[0]!.screens.push({ id: "ds_a", source: { kind: "builtin", builtin: "top" } });
      m.designs[0]!.layout.navigation.push({ id: "nav_a", group: "A のグループ", items: [{ screenId: "ds_a" }] });
      return m;
    });
    edit(c, b, (m) => {
      m.designs[0]!.screens.push({ id: "ds_c", source: { kind: "builtin", builtin: "signIn" } });
      m.designs[0]!.layout.navigation.push({ id: "nav_c", group: "C のグループ", items: [{ screenId: "ds_c" }] });
      return m;
    });
    sync(a, c);
    const merged = rebuildModel(a);
    expect(rebuildModel(c)).toStrictEqual(merged);
    const d = merged.designs[0]!;
    expect(d.screens.map((s) => s.id).sort()).toEqual(["ds_a", "ds_c"]);
    expect(d.layout.navigation.map((g) => g.id).sort()).toEqual(["nav_a", "nav_c"]);
    expect(validateModel(JSON.parse(JSON.stringify(merged))).ok).toBe(true);
  });

  it("同時に既定のデータベースを作っても 1 つになる", () => {
    const b = base();
    const a = fresh(b);
    const c = cloneDoc(a);
    for (const doc of [a, c]) edit(doc, b, (m) => ensure(m, "sys_a"));
    sync(a, c);
    expect(rebuildModel(a).databases).toHaveLength(1);
    expect(rebuildModel(a).designs).toHaveLength(1);
  });

  it("設計を消した人と画面を足した人が同時でも、足した画面は設計が無いので現れない (壊れた設計にならない)", () => {
    const b = ensure(base(), "sys_a");
    const a = fresh(b);
    const c = cloneDoc(a);
    edit(a, b, (m) => ({ ...m, designs: [] }));
    edit(c, b, (m) => {
      m.designs[0]!.screens.push({ id: "ds_c", source: { kind: "builtin", builtin: "top" } });
      return m;
    });
    sync(a, c);
    expect(rebuildModel(a).designs).toEqual([]);
    expect(validateModel(JSON.parse(JSON.stringify(rebuildModel(a)))).ok).toBe(true);
  });
});

describe("applyModelDiff: 設計", () => {
  it("画面を 1 つ足す: 足した画面だけが書かれ、ほかの画面の値は変わらない", () => {
    const before = designed();
    const doc = fresh(before);
    const screens = getRoots(doc).designScreens;
    const untouched = screens.get("ds_1");
    const after = JSON.parse(JSON.stringify(before)) as UntieModel;
    after.designs[0]!.screens.splice(1, 0, { id: "ds_new", source: { kind: "builtin", builtin: "signIn" } });
    applyModelDiff(doc, before, after, "local");
    expect(screens.get("ds_1")).toBe(untouched);
    expect(rebuildModel(doc)).toStrictEqual(after);
  });

  it("画面を消す", () => {
    const { doc, after } = apply(designed(), (m) => {
      m.designs[0]!.screens = m.designs[0]!.screens.filter((s) => s.id !== "ds_2");
      return m;
    });
    expect(getRoots(doc).designScreens.has("ds_2")).toBe(false);
    expect(rebuildModel(doc, undefined).designs[0]!.screens.map((s) => s.id)).toEqual(["ds_top", "ds_1"]);
    expect(after.designs[0]!.screens).toHaveLength(2);
  });

  it("画面の view を変える: 変えた画面だけ書かれる", () => {
    const before = designed();
    const doc = fresh(before);
    const screens = getRoots(doc).designScreens;
    const other = screens.get("ds_top");
    const after = JSON.parse(JSON.stringify(before)) as UntieModel;
    after.designs[0]!.screens[1]!.view = { type: "page", children: [{ type: "text", text: "こんにちは" }] };
    applyModelDiff(doc, before, after, "local");
    expect(screens.get("ds_top")).toBe(other);
    expect(rebuildModel(doc)).toStrictEqual(after);
    // view を消すとキーも消える
    const cleared = JSON.parse(JSON.stringify(after)) as UntieModel;
    delete cleared.designs[0]!.screens[1]!.view;
    applyModelDiff(doc, after, cleared, "local");
    expect(rebuildModel(doc)).toStrictEqual(cleared);
  });

  it("画面ごとのレイアウトの上書き (shell) も画面の値に載って往復する。消すとキーも消え、列挙の外の値は落として画面を残す", () => {
    const before = designed();
    const doc = fresh(before);
    const after = JSON.parse(JSON.stringify(before)) as UntieModel;
    after.designs[0]!.screens[1]!.shell = "plain";
    applyModelDiff(doc, before, after, "local");
    expect((getRoots(doc).designScreens.get("ds_1") as { shell?: string }).shell).toBe("plain");
    expect(rebuildModel(doc)).toStrictEqual(after);
    expect(validateModel(JSON.parse(JSON.stringify(rebuildModel(doc)))).ok).toBe(true);
    // 初めから shell を持つモデルを読み込んでも同じ
    expect(rebuildModel(fresh(after))).toStrictEqual(after);
    // 消す
    const cleared = JSON.parse(JSON.stringify(after)) as UntieModel;
    delete cleared.designs[0]!.screens[1]!.shell;
    applyModelDiff(doc, after, cleared, "local");
    expect("shell" in (getRoots(doc).designScreens.get("ds_1") as object)).toBe(false);
    expect(rebuildModel(doc)).toStrictEqual(cleared);
    // 列挙の外の値 (古い・壊れたクライアント) は shell だけを落とし、画面は残す
    getRoots(doc).designScreens.set("ds_1", { ...(getRoots(doc).designScreens.get("ds_1") as object), shell: "bogus" } as never);
    const rebuilt = rebuildModel(doc);
    expect(rebuilt.designs[0]!.screens.map((s) => s.id)).toEqual(["ds_top", "ds_1", "ds_2"]);
    expect("shell" in rebuilt.designs[0]!.screens[1]!).toBe(false);
  });

  it("遷移・レイアウト・使うデータベースを変える", () => {
    const { doc, after } = apply(designed(), (m) => {
      const d: SystemDesign = m.designs[0]!;
      d.transitions.push({ id: "tr_3", from: "ds_2", to: "ds_top", via: "button" });
      d.transitions = d.transitions.filter((t) => t.id !== "tr_1");
      d.layout.shell = "plain";
      d.databaseIds = ["db_default", "db_two"];
      return m;
    });
    expect(rebuildModel(doc)).toStrictEqual(after);
  });

  it("設計の追加・削除", () => {
    const base = designed();
    const { doc: d1, after: a1 } = apply(base, (m) => {
      m.designs = [];
      return m;
    });
    expect(getRoots(d1).designs.size).toBe(0);
    expect(getRoots(d1).designScreens.size).toBe(0);
    expect(getRoots(d1).designTransitions.size).toBe(0);
    expect(getRoots(d1).designNav.size).toBe(0);
    expect(rebuildModel(d1)).toStrictEqual(a1);
    const { doc: d2, after: a2 } = apply(a1, (m) => {
      m.designs = designed().designs;
      return m;
    });
    expect(rebuildModel(d2)).toStrictEqual(a2);
  });

  it("データベースの dsl を変える: 変えた項目だけ書かれる。足す・消すもできる", () => {
    const before = designed();
    const doc = fresh(before);
    const roots = getRoots(doc);
    const after = JSON.parse(JSON.stringify(before)) as UntieModel;
    after.databases[0]!.dsl = "model A { id Int }";
    applyModelDiff(doc, before, after, "local");
    expect(roots.databases.get("db_default/dsl")).toBe("model A { id Int }");
    expect(roots.databases.get("db_default/name")).toBe("既定のデータベース");
    expect(rebuildModel(doc)).toStrictEqual(after);

    const next = JSON.parse(JSON.stringify(after)) as UntieModel;
    next.databases.push({ id: "db_three", name: "三つ目", dsl: "", tables: [{ table: "B", informationIds: [] }] });
    next.databases = next.databases.filter((d) => d.id !== "db_two");
    applyModelDiff(doc, after, next, "local");
    expect(roots.databases.has("db_two/name")).toBe(false);
    expect(rebuildModel(doc)).toStrictEqual(next);
  });

  it("別々の人が別の画面・別のデータベースを同時に変えても合流する", () => {
    const base = designed();
    const a = fresh(base);
    const b = cloneDoc(a);
    const ea = JSON.parse(JSON.stringify(base)) as UntieModel;
    ea.designs[0]!.screens[1]!.view = { type: "A" };
    const eb = JSON.parse(JSON.stringify(base)) as UntieModel;
    eb.designs[0]!.screens[2]!.view = { type: "B" };
    eb.databases[1]!.dsl = "model B {}";
    applyModelDiff(a, base, ea, "a");
    applyModelDiff(b, base, eb, "b");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const merged = rebuildModel(a);
    expect(merged).toStrictEqual(rebuildModel(b));
    expect(merged.designs[0]!.screens[1]!.view).toEqual({ type: "A" });
    expect(merged.designs[0]!.screens[2]!.view).toEqual({ type: "B" });
    expect(merged.databases[1]!.dsl).toBe("model B {}");
  });

  it("rebuildModel に prev を渡すと、変わっていない設計・データベースは参照を使い回す", () => {
    const doc = fresh(designed());
    const prev = rebuildModel(doc);
    expect(rebuildModel(doc, prev)).toBe(prev);
    const after = JSON.parse(JSON.stringify(prev)) as UntieModel;
    after.databases[0]!.dsl = "x";
    applyModelDiff(doc, prev, after, "local");
    const next = rebuildModel(doc, prev);
    expect(next.designs).toBe(prev.designs);
    expect(next.databases).not.toBe(prev.databases);
    expect(next.databases[1]).toBe(prev.databases[1]);
  });

  it("1 つの view を変えても、ほかの画面・遷移・ナビの参照は変わらない (shareDesign)", () => {
    const doc = fresh(designed());
    const prev = rebuildModel(doc);
    const after = JSON.parse(JSON.stringify(prev)) as UntieModel;
    after.designs[0]!.screens[1]!.view = { type: "changed" };
    applyModelDiff(doc, prev, after, "local");
    const next = rebuildModel(doc, prev);
    const p = prev.designs[0]!;
    const n = next.designs[0]!;
    expect(n).not.toBe(p);
    expect(n.screens).not.toBe(p.screens);
    expect(n.screens[0]).toBe(p.screens[0]);
    expect(n.screens[1]).not.toBe(p.screens[1]);
    expect(n.screens[2]).toBe(p.screens[2]);
    expect(n.transitions).toBe(p.transitions);
    expect(n.layout.navigation).toBe(p.layout.navigation);
  });
});

describe("observeModelChanges: 設計", () => {
  it("設計とデータベースの変更が id つきで届く", () => {
    const before = designed();
    const remote = fresh(before);
    const local = cloneDoc(remote);
    const calls: { designs: string[]; databases: string[] }[] = [];
    observeModelChanges(local, (c) => calls.push({ designs: [...c.designs], databases: [...c.databases] }));
    const after = JSON.parse(JSON.stringify(before)) as UntieModel;
    after.designs[0]!.screens[0]!.view = { a: 1 };
    after.databases[1]!.dsl = "x";
    const sv = Y.encodeStateVector(local);
    applyModelDiff(remote, before, after, "remote");
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, sv), "network");
    expect(calls).toEqual([{ designs: ["sys_a"], databases: ["db_two"] }]);
  });
});

describe("repairDoc: 設計", () => {
  it("消えたシステム・画面・情報を指す設計データを直す。データベースは残る", () => {
    const m = designed();
    const doc = fresh(m);
    const roots = getRoots(doc);
    // 他の人が画面と情報を消したのと同じ状態 (Y.Doc の要素だけ消す)
    roots.elements.delete("scr_1");
    roots.elements.delete("info_1");
    const changes = repairDoc(doc, "repair");
    expect(changes.length).toBeGreaterThan(0);
    const fixed = rebuildModel(doc);
    expect(validateModel(JSON.parse(JSON.stringify(fixed))).ok).toBe(true);
    expect(fixed.designs[0]!.screens.map((s) => s.id)).toEqual(["ds_top", "ds_2"]);
    expect(fixed.designs[0]!.transitions).toEqual([]);
    expect(fixed.designs[0]!.layout.navigation[0]!.items).toEqual([{ screenId: "ds_2", label: "詳細" }]);
    expect(fixed.databases).toHaveLength(2);
    expect(fixed.databases[0]!.tables[0]!.informationIds).toEqual([]);

    // システムが消えたら設計が消える
    roots.elements.delete("sys_a");
    repairDoc(doc, "repair");
    expect(rebuildModel(doc).designs).toEqual([]);
  });

  it("画面の shell が列挙の外の値なら、repairDoc が Y.Doc から消す。readModel も落とし、画面は残る", () => {
    const doc = fresh(designed());
    const roots = getRoots(doc);
    roots.designScreens.set("ds_1", { ...(roots.designScreens.get("ds_1") as object), shell: "bogus" } as never);
    expect(validateModel(JSON.parse(JSON.stringify(readModel(doc)))).ok).toBe(true);
    expect("shell" in readModel(doc).designs[0]!.screens[1]!).toBe(false);
    const changes = repairDoc(doc, "repair");
    expect(changes.join()).toContain("レイアウトの指定を外した");
    expect("shell" in (roots.designScreens.get("ds_1") as object)).toBe(false);
    expect(rebuildModel(doc).designs[0]!.screens.map((s) => s.id)).toEqual(["ds_top", "ds_1", "ds_2"]);
  });

  it("コマンドで消した結果と、修復で直した結果は同じ", () => {
    const m = designed();
    const doc = fresh(m);
    getRoots(doc).elements.delete("scr_1");
    repairDoc(doc, "repair");
    const r = removeElement(m, { id: "scr_1" });
    if (!r.ok) throw new Error(r.reason);
    expect(rebuildModel(doc).designs).toStrictEqual(r.model.designs);
  });

  it("壊れた設計の項目・長すぎる文字列を入れた Y.Doc に当てたあと、validateModel が通る", () => {
    const doc = fresh(designed());
    const roots = getRoots(doc);
    const long = "あ".repeat(250);
    // 読み飛ばされる壊れた項目
    roots.designScreens.set("ds_bad", { systemId: "sys_a", id: "ds_bad", source: { kind: "nothing" }, order: "z1" });
    roots.designNav.set("nav_bad", { systemId: "sys_a", id: "nav_bad", group: "x", items: 3, order: "z2" });
    roots.designs.set("sys_a/layout", { shell: "plain", header: { systemName: long } });
    // 切り詰められる長い文字列
    roots.designNav.set("nav_long", { systemId: "sys_a", id: "nav_long", group: long, items: [{ screenId: "ds_1", label: long }], order: "z3" });
    roots.designTransitions.set("tr_long", { systemId: "sys_a", id: "tr_long", from: "ds_1", to: "ds_2", label: long, order: "z4" });
    roots.designScreens.set("ds_long", { systemId: "sys_a", id: "ds_long", source: { kind: "builtin", builtin: "signIn" }, bindings: [{ item: long, databaseId: "db_default", table: long, column: long }], order: "z5" });
    roots.databases.set("db_default/name", long);
    roots.databases.set("db_default/dsl", "x".repeat(200010));
    roots.databases.set("db_default/tables", [{ table: long, informationIds: ["info_1"] }]);
    // 消えた参照
    roots.designTransitions.set("tr_dangling", { systemId: "sys_a", id: "tr_dangling", from: "ds_1", to: "ds_gone", order: "z6" });
    expect(validateModel(JSON.parse(JSON.stringify(readModel(doc)))).ok).toBe(false);
    const changes = repairDoc(doc, "repair");
    expect(changes.length).toBeGreaterThan(0);
    const r = validateModel(JSON.parse(JSON.stringify(rebuildModel(doc))));
    expect(r.ok ? [] : r.errors).toEqual([]);
    // 直したあとは、もう何も直さない
    expect(repairDoc(doc, "repair")).toEqual([]);
    const fixed = rebuildModel(doc);
    expect(fixed.designs[0]!.layout.shell).toBe("plain");
    expect(fixed.designs[0]!.layout.header!.systemName).toHaveLength(200);
    expect(fixed.databases[0]!.dsl).toHaveLength(200000);
    expect(fixed.designs[0]!.transitions.map((x) => x.id)).not.toContain("tr_dangling");
  });
});
