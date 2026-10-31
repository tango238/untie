import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { addBoard, addElement, addRelation, emptyModel, placeOnBoard, removeBoard, removeRelation, setEdgeSides, validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { createHotelSample } from "@untie/core/sample";
import { applyModelDiff, getRoots, loadModel, readModel, rebuildModel, repairDoc } from "..";
import { cloneDoc, sync } from "./helpers";

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error((r as unknown as { reason: string }).reason);
  return r as Extract<T, { ok: true }>;
}

function expectValid(m: UntieModel) {
  const r = validateModel(JSON.parse(JSON.stringify(m)));
  expect(r.ok ? [] : r.errors).toEqual([]);
}

const fresh = (m: UntieModel) => {
  const doc = new Y.Doc();
  loadModel(doc, m);
  return doc;
};

/** 合流で壊れた Doc を作る (消えた要素を指す関係・ノード・参照、業務の無い活動、ボード 0 枚、重複した関係) */
function brokenDoc(): Y.Doc {
  let m = emptyModel();
  const add = (kind: Parameters<typeof addElement>[1]["kind"], id: string, init: Parameters<typeof addElement>[1]["init"] = {}, board = false) => {
    m = ok(addElement(m, { kind, name: id, id, init, ...(board ? { boardId: "board_main" } : {}) })).model;
  };
  add("actor", "actor_a", {}, true);
  add("activity", "act_a", {}, true);
  add("business", "biz_a");
  add("buc", "buc_a", { businessId: "biz_a" });
  add("activity", "act_b", { bucId: "buc_a" });
  add("context", "ctx_a");
  add("information", "info_a", { contextId: "ctx_a" });
  add("issue", "issue_a", { targetIds: ["actor_a"] });
  m = ok(addRelation(m, { sourceId: "actor_a", targetId: "act_a", id: "rel_a" })).model;
  const doc = fresh(m);
  const roots = getRoots(doc);
  roots.elements.delete("actor_a");
  roots.elements.delete("buc_a");
  roots.elements.delete("ctx_a");
  roots.elements.delete("biz_a");
  roots.relations.set("rel_dangling", { kind: "actorActivity", sourceId: "nobody", targetId: "nothing", order: "a9" });
  roots.boards.delete("board_main");
  return doc;
}

describe("readModel", () => {
  it("壊れた参照を外さず、ボードが 0 枚でも補わない", () => {
    const doc = brokenDoc();
    const raw = readModel(doc);
    expect(raw.boards).toEqual([]);
    expect(raw.relations.map((r) => r.id).sort()).toEqual(["rel_a", "rel_dangling"]);
    expect(raw.elements.some((e) => e.id === "act_b" && e.kind === "activity" && e.bucId === "buc_a")).toBe(true);
    // rebuildModel は外す
    const rebuilt = rebuildModel(doc);
    expect(rebuilt.relations).toEqual([]);
    expectValid(rebuilt);
  });

  it("壊れていない Doc では rebuildModel と同じ", () => {
    const doc = fresh(createHotelSample());
    expect(readModel(doc)).toStrictEqual(rebuildModel(doc));
  });
});

describe("repairDoc", () => {
  it("壊れた Doc を直すと、readModel の結果が validateModel を通り、直した内容が返る", () => {
    const doc = brokenDoc();
    const expected = rebuildModel(doc);
    const changes = repairDoc(doc, "repair");
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => typeof c === "string")).toBe(true);
    const after = readModel(doc);
    expectValid(after);
    // クライアントの表示 (rebuildModel) と、直したあとの Doc の中身が一致する
    expect(after).toStrictEqual(expected);
    expect(getRoots(doc).relations.has("rel_dangling")).toBe(false);
  });

  it("2 回目は何も書かず、空の配列を返す", () => {
    const doc = brokenDoc();
    repairDoc(doc, "repair");
    let updates = 0;
    doc.on("update", () => updates++);
    expect(repairDoc(doc, "repair")).toEqual([]);
    expect(updates).toBe(0);
  });

  it("壊れていなければ何も書かない", () => {
    for (const m of [createHotelSample(), emptyModel()]) {
      const doc = fresh(m);
      let updates = 0;
      doc.on("update", () => updates++);
      expect(repairDoc(doc, "repair")).toEqual([]);
      expect(updates).toBe(0);
    }
  });

  it("書き込みは指定した origin の 1 トランザクション", () => {
    const doc = brokenDoc();
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tx) => origins.push(tx.origin));
    repairDoc(doc, "repair");
    expect(origins).toEqual(["repair"]);
  });

  it("直した結果は別の端末にも届き、同じ表示になる", () => {
    const doc = brokenDoc();
    const other = cloneDoc(doc);
    repairDoc(doc, "repair");
    sync(doc, other);
    expect(rebuildModel(other)).toStrictEqual(rebuildModel(doc));
    expect(readModel(other)).toStrictEqual(readModel(doc));
  });

  it("業務の既定の活動が無い・複数ある・名前が違う Doc も直せる", () => {
    const m = ok(addElement(emptyModel(), { kind: "business", name: "業務", id: "biz_a" })).model;
    const doc = fresh(m);
    const roots = getRoots(doc);
    const defaultId = [...roots.elements].find(([, e]) => e.get("kind") === "buc")![0];
    roots.elements.get("biz_a")!.set("name", "改名後");
    // 2 個目の既定の活動 (order は後ろ)
    const second = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ kind: "buc", name: "業務", businessId: "biz_a", isDefault: true, order: "zz" })) second.set(k, v);
    roots.elements.set("buc_dup", second);
    repairDoc(doc, "repair");
    const after = readModel(doc);
    expectValid(after);
    const defaults = after.elements.filter((e) => e.kind === "buc" && e.isDefault);
    expect(defaults.map((e) => e.id)).toEqual([defaultId]);
    expect(defaults[0].name).toBe("改名後");
    // 既定の活動が全く無い場合
    roots.elements.delete(defaultId);
    repairDoc(doc, "repair");
    expect(readModel(doc).elements.filter((e) => e.kind === "buc" && e.isDefault).map((e) => e.id)).toEqual(["buc_biz_a"]);
    expectValid(readModel(doc));
  });
});

describe("ボード 0 枚のときの編集", () => {
  it("2 人が別々のボードを同時に消して 0 枚になり、片方が placeOnBoard しても、往復でノードが残る", () => {
    let base = ok(addBoard(emptyModel(), { name: "ボード 2", id: "board_2" })).model;
    base = ok(addElement(base, { kind: "actor", name: "A", id: "actor_a" })).model;
    const a = fresh(base);
    const b = cloneDoc(a);
    applyModelDiff(a, base, ok(removeBoard(base, { id: "board_main" })).model, "a");
    applyModelDiff(b, base, ok(removeBoard(base, { id: "board_2" })).model, "b");
    sync(a, b);
    expect(getRoots(a).boards.size).toBe(0);

    // どちらの表示も board_main の 1 枚
    const shown = rebuildModel(a);
    expect(shown.boards.map((x) => x.id)).toEqual(["board_main"]);
    expect(rebuildModel(b)).toStrictEqual(shown);

    const placed = ok(placeOnBoard(shown, { boardId: "board_main", elementId: "actor_a", position: { x: 10, y: 20 } })).model;
    applyModelDiff(a, shown, placed, "a");
    expect(rebuildModel(a)).toStrictEqual(placed);
    expect(rebuildModel(a).boards[0].nodes).toEqual([{ elementId: "actor_a", x: 10, y: 20 }]);
    sync(a, b);
    expect(rebuildModel(b)).toStrictEqual(placed);
  });

  it("サーバーの修復 (repairDoc) と両方が board_main を作っても 1 枚に合流する", () => {
    const base = emptyModel();
    const a = fresh(base);
    const b = cloneDoc(a);
    // 0 枚の状態を直接作る
    getRoots(a).boards.clear();
    getRoots(b).boards.clear();
    sync(a, b);
    repairDoc(a, "repair");
    const shown = rebuildModel(b);
    const placed = ok(placeOnBoard(ok(addElement(shown, { kind: "actor", name: "A", id: "actor_a" })).model, { boardId: "board_main", elementId: "actor_a", position: { x: 1, y: 2 } })).model;
    applyModelDiff(b, shown, placed, "b");
    sync(a, b);
    expect(getRoots(a).boards.size).toBe(1);
    expect(rebuildModel(a)).toStrictEqual(rebuildModel(b));
  });
});

describe("重複した関係", () => {
  it("見えている方を消しても、隠れていた重複 (と線の設定) は Y.Doc からも消え、現れない", () => {
    const base = emptyModel();
    let m = ok(addElement(base, { kind: "actor", name: "A", id: "actor_a", boardId: "board_main" })).model;
    m = ok(addElement(m, { kind: "activity", name: "B", id: "act_b", boardId: "board_main" })).model;
    const a = fresh(m);
    const b = cloneDoc(a);
    const side = (doc: Y.Doc, id: string, side: "top" | "bottom") => {
      const withRel = ok(addRelation(m, { sourceId: "actor_a", targetId: "act_b", id })).model;
      const withEdge = ok(setEdgeSides(withRel, { boardId: "board_main", relationId: id, sourceSide: side })).model;
      applyModelDiff(doc, m, withEdge, id);
    };
    side(a, "rel_1", "top");
    side(b, "rel_2", "bottom");
    sync(a, b);

    const merged = rebuildModel(a);
    expect(merged.relations).toHaveLength(1);
    expect(getRoots(a).relations.size).toBe(2);
    const visible = merged.relations[0].id;

    const removed = ok(removeRelation(merged, { id: visible })).model;
    applyModelDiff(a, merged, removed, "a");
    expect(getRoots(a).relations.size).toBe(0);
    const edges = getRoots(a).boards.get("board_main")!.get("edges") as Y.Map<unknown>;
    expect(edges.size).toBe(0);
    expect(rebuildModel(a)).toStrictEqual(removed);
    expect(rebuildModel(a).relations).toEqual([]);
    sync(a, b);
    expect(rebuildModel(b)).toStrictEqual(removed);
  });

  it("無向の関係 (向きが逆の重複) も一緒に消える", () => {
    let m = ok(addElement(emptyModel(), { kind: "information", name: "I1", id: "info_1" })).model;
    m = ok(addElement(m, { kind: "information", name: "I2", id: "info_2" })).model;
    const withRel = ok(addRelation(m, { sourceId: "info_1", targetId: "info_2", id: "rel_1" })).model;
    const doc = fresh(withRel);
    getRoots(doc).relations.set("rel_rev", { kind: "informationRelated", sourceId: "info_2", targetId: "info_1", order: "zz" });
    const shown = rebuildModel(doc);
    expect(shown.relations.map((r) => r.id)).toEqual(["rel_1"]);
    applyModelDiff(doc, shown, ok(removeRelation(shown, { id: "rel_1" })).model, "local");
    expect(getRoots(doc).relations.size).toBe(0);
  });
});

describe("形の壊れた要素・ノード", () => {
  /** 要素を直接 Y.Doc に入れる */
  const setRaw = (doc: Y.Doc, id: string, fields: Record<string, unknown>) => {
    const ymap = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(fields)) ymap.set(k, v);
    ymap.set("order", "zzz");
    getRoots(doc).elements.set(id, ymap);
  };

  it("項目が欠けた・型が違う・種類が不明な要素は組み立てから外れ、ほかは落ちずに残る", () => {
    const sample = createHotelSample();
    const doc = fresh(sample);
    setRaw(doc, "issue_bad", { kind: "issue", name: "x", severity: 3 }); // targetIds が無い
    setRaw(doc, "issue_bad2", { kind: "issue", name: "x", severity: "high", targetIds: [] });
    setRaw(doc, "var_bad", { kind: "variation", name: "x", contextId: null }); // values が無い
    setRaw(doc, "buc_bad", { kind: "buc", name: "x", isDefault: false }); // businessId が無い
    setRaw(doc, "act_bad", { kind: "activity", name: "x", bucId: 5 });
    setRaw(doc, "info_bad", { kind: "information", name: "x", contextId: 5 });
    setRaw(doc, "act_bad2", { kind: "activity", name: "x", bucId: null, hours: "3" });
    setRaw(doc, "act_bad3", { kind: "activity", name: "x", bucId: null, links: "none" });
    setRaw(doc, "unknown_bad", { kind: "mystery", name: "x" });
    setRaw(doc, "noname_bad", { kind: "actor" });
    setRaw(doc, "str_bad", "oops" as never);
    const bad = ["issue_bad", "issue_bad2", "var_bad", "buc_bad", "act_bad", "info_bad", "act_bad2", "act_bad3", "unknown_bad", "noname_bad"];

    for (const model of [readModel(doc), rebuildModel(doc)]) {
      expect(model.elements.some((e) => bad.includes(e.id))).toBe(false);
      expect(model.elements).toHaveLength(sample.elements.length);
    }
    expect(rebuildModel(doc)).toStrictEqual(sample);
    expectValid(rebuildModel(doc));
    // 外れた要素を指す関係は、rebuildModel では出ない
    expect(repairDoc(doc, "repair")).toEqual([]);
  });

  it("座標が数でないノード・不正な線の設定・形の崩れた関係は外れる", () => {
    const sample = createHotelSample();
    const doc = fresh(sample);
    const roots = getRoots(doc);
    const board = roots.boards.get(sample.boards[0].id)!;
    const nodes = board.get("nodes") as Y.Map<unknown>;
    nodes.set("actor_front", { x: "10", y: 5, order: "a0" });
    nodes.set("actor_manager", { x: 1, y: 2, width: "wide", order: "a1" });
    (board.get("edges") as Y.Map<unknown>).set("rel_x", { sourceSide: "diagonal", order: "a0" });
    roots.relations.set("rel_broken", { kind: 5, sourceId: "a", targetId: "b", order: "a0" } as never);
    const rebuilt = rebuildModel(doc);
    const ids = rebuilt.boards.find((b) => b.id === sample.boards[0].id)!.nodes.map((n) => n.elementId);
    expect(ids).not.toContain("actor_manager");
    const original = sample.boards[0].nodes.map((n) => n.elementId);
    // 壊れた値で上書きされた 2 件だけが外れる
    expect(ids).toEqual(original.filter((id) => id !== "actor_front" && id !== "actor_manager"));
    expect(rebuilt.relations.some((r) => r.id === "rel_broken")).toBe(false);
    expectValid(rebuilt);
  });
});
