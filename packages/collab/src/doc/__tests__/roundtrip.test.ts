import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addElement, addRelation, emptyModel, removeElement, updateElement, validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { createHotelSample } from "@untie/core/sample";
import { applyModelDiff, getRoots, loadModel, rebuildModel } from "..";
import { allOrders, createRng, runRandomCommands, seedMathRandom } from "./helpers";

function expectValid(m: UntieModel) {
  const r = validateModel(JSON.parse(JSON.stringify(m)));
  expect(r.ok ? [] : r.errors).toEqual([]);
}

/** order という項目がどこにも無い */
function hasOrderKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOrderKey);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([k, v]) => k === "order" || hasOrderKey(v));
  }
  return false;
}

afterEach(() => vi.restoreAllMocks());

const fresh = (m: UntieModel) => {
  const doc = new Y.Doc();
  loadModel(doc, m);
  return doc;
};

describe("loadModel / rebuildModel の往復", () => {
  it("サンプルを入れて組み立てると元と同じになる (order は出ない、validateModel を通る)", () => {
    const sample = createHotelSample();
    const rebuilt = rebuildModel(fresh(sample));
    expect(rebuilt).toStrictEqual(sample);
    expect(hasOrderKey(rebuilt)).toBe(false);
    expectValid(rebuilt);
  });

  it("空のモデルでも往復できる", () => {
    const empty = emptyModel();
    const rebuilt = rebuildModel(fresh(empty));
    expect(rebuilt).toStrictEqual(empty);
    expectValid(rebuilt);
  });

  it("名前だけ・説明つきの meta、線の設定を持つボードも往復できる", () => {
    const m = createHotelSample();
    m.meta.description = "説明";
    m.boards[0].edges = [{ relationId: m.relations[0].id, sourceSide: "top" }, { relationId: m.relations[1].id, targetSide: "bottom" }];
    expect(rebuildModel(fresh(m))).toStrictEqual(m);
  });

  it("配列の順に順序キーが振られ、キーは重複しない", () => {
    const orders = allOrders(fresh(createHotelSample()));
    for (const [name, keys] of Object.entries(orders)) {
      expect(new Set(keys).size, name).toBe(keys.length);
    }
  });

  it("Y.Doc に入れた値は、入れたあとに元のモデルを書き換えても変わらない (参照を共有しない)", () => {
    const m = emptyModel();
    m.elements.push({ id: "act_1", kind: "activity", name: "作業", bucId: null, links: [{ title: "T", url: "https://example.com" }] });
    const doc = fresh(m);
    const expected = JSON.parse(JSON.stringify(m));
    const el = m.elements[0];
    if (el.kind === "activity") el.links![0].title = "書き換えた";
    expect(rebuildModel(doc)).toStrictEqual(expected);
  });
});

describe("applyModelDiff", () => {
  it("before と after が同じ参照なら何も書かない", () => {
    const m = createHotelSample();
    const doc = fresh(m);
    let updates = 0;
    doc.on("update", () => updates++);
    applyModelDiff(doc, m, m, "local");
    expect(updates).toBe(0);
  });

  it("origin がトランザクションに渡る (1 回の差分は 1 つのトランザクション)", () => {
    const before = createHotelSample();
    const doc = fresh(before);
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tx) => origins.push(tx.origin));
    let after = before;
    const r1 = updateElement(after, { id: "actor_front", patch: { name: "A", description: "B" } });
    if (!r1.ok) throw new Error(r1.reason);
    const r2 = addElement(r1.model, { kind: "actor", name: "新", boardId: before.boards[0].id });
    if (!r2.ok) throw new Error(r2.reason);
    after = r2.model;
    applyModelDiff(doc, before, after, "my-origin");
    expect(origins).toEqual(["my-origin"]);
    expect(rebuildModel(doc)).toStrictEqual(after);
  });

  it("未定義になった項目はキーが消える (説明・時間・分析)", () => {
    let m = createHotelSample();
    const doc = fresh(m);
    const issue = m.elements.find((e) => e.kind === "issue")!;
    const steps = [
      updateElement(m, { id: issue.id, patch: { analysis: { phenomenon: "現象", cause: "理由" }, description: "説明" } }),
    ];
    for (const r of steps) {
      if (!r.ok) throw new Error(r.reason);
      applyModelDiff(doc, m, r.model, "local");
      m = r.model;
    }
    expect(rebuildModel(doc)).toStrictEqual(m);
    const clear = updateElement(m, { id: issue.id, patch: { analysis: null, description: "" } });
    if (!clear.ok) throw new Error(clear.reason);
    applyModelDiff(doc, m, clear.model, "local");
    const ymap = getRoots(doc).elements.get(issue.id)!;
    // 分析の Y.Map は残り、項目だけ消える
    expect((ymap.get("analysis") as Y.Map<unknown>).size).toBe(0);
    expect(ymap.has("description")).toBe(false);
    expect(rebuildModel(doc)).toStrictEqual(clear.model);
  });

  it("分析は項目ごとの Y.Map で、別の項目は別々に書ける", () => {
    const base = okAddIssue();
    const docA = fresh(base);
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const a = updateElement(base, { id: "issue_x", patch: { analysis: { phenomenon: "Aの現象" } } });
    const b = updateElement(base, { id: "issue_x", patch: { analysis: { cause: "Bの理由" } } });
    if (!a.ok || !b.ok) throw new Error("失敗");
    applyModelDiff(docA, base, a.model, "a");
    applyModelDiff(docB, base, b.model, "b");
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const merged = rebuildModel(docA);
    const issue = merged.elements.find((e) => e.id === "issue_x");
    expect(issue && issue.kind === "issue" && issue.analysis).toEqual({ phenomenon: "Aの現象", cause: "Bの理由" });
    expect(rebuildModel(docB)).toStrictEqual(merged);
  });

  it("コマンドをランダムに当てても、毎回 rebuildModel(doc) が after と一致する (サンプル、20 seed)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      seedMathRandom(seed);
      const rng = createRng(seed);
      const trace: string[] = [];
      const start = createHotelSample();
      const doc = fresh(start);
      // 別の Y.Doc に update を流し続け、そちらでも同じになること
      const mirror = new Y.Doc();
      Y.applyUpdate(mirror, Y.encodeStateAsUpdate(doc));
      doc.on("update", (u: Uint8Array) => Y.applyUpdate(mirror, u));

      let prev = rebuildModel(doc);
      const count = 1 + rng.int(50);
      let steps = 0;
      runRandomCommands(start, rng, count, (before, after) => {
        steps++;
        applyModelDiff(doc, before, after, "local");
        const where = `seed ${seed} step ${steps}: ${trace.join(" → ")}`;
        const rebuilt = rebuildModel(doc);
        expect(rebuilt, where).toStrictEqual(after);
        expect(rebuildModel(mirror), `${where} (mirror)`).toStrictEqual(after);
        // prev を渡しても同じ内容
        const shared = rebuildModel(doc, prev);
        expect(shared).toStrictEqual(after);
        prev = shared;
        for (const [name, keys] of Object.entries(allOrders(doc))) expect(new Set(keys).size, `${where} (${name} の order が重複)`).toBe(keys.length);
      }, trace);
      expect(steps, `seed ${seed}`).toBeGreaterThan(0);
      expectValid(rebuildModel(doc));
      vi.restoreAllMocks();
    }
  });

  it("空のモデルから始めても往復できる (20 seed)", () => {
    for (let seed = 101; seed <= 120; seed++) {
      seedMathRandom(seed);
      const rng = createRng(seed);
      const trace: string[] = [];
      const start = emptyModel();
      const doc = fresh(start);
      let steps = 0;
      // 空だと選べる候補が無いので、最初にいくつか要素を足してから乱数に任せる
      let model = start;
      for (const kind of ["actor", "business", "context", "information", "activity", "usecase", "system"] as const) {
        const r = addElement(model, { kind, name: kind, boardId: model.boards[0].id });
        if (!r.ok) throw new Error(r.reason);
        applyModelDiff(doc, model, r.model, "local");
        model = r.model;
      }
      const rel = addRelation(model, { sourceId: model.elements.find((e) => e.kind === "actor")!.id, targetId: model.elements.find((e) => e.kind === "activity")!.id });
      if (!rel.ok) throw new Error(rel.reason);
      applyModelDiff(doc, model, rel.model, "local");
      model = rel.model;
      runRandomCommands(model, rng, 1 + rng.int(50), (before, after) => {
        steps++;
        applyModelDiff(doc, before, after, "local");
        expect(rebuildModel(doc), `seed ${seed} step ${steps}: ${trace.join(" → ")}`).toStrictEqual(after);
      }, trace);
      vi.restoreAllMocks();
    }
  });

  it("要素を全部消して空に近い状態にしても往復できる", () => {
    let m = createHotelSample();
    const doc = fresh(m);
    for (const e of [...m.elements]) {
      const r = removeElement(m, { id: e.id });
      if (!r.ok) continue;
      applyModelDiff(doc, m, r.model, "local");
      m = r.model;
    }
    expect(rebuildModel(doc)).toStrictEqual(m);
  });
});

describe("rebuildModel の構造共有", () => {
  it("何も変わっていなければ prev そのものを返す", () => {
    const doc = fresh(createHotelSample());
    const prev = rebuildModel(doc);
    expect(rebuildModel(doc, prev)).toBe(prev);
  });

  it("変わっていない要素・関係・ボードは prev の参照、変わった要素だけ新しい参照", () => {
    const start = createHotelSample();
    const doc = fresh(start);
    const prev = rebuildModel(doc);
    const targetId = "actor_front";
    const r = updateElement(start, { id: targetId, patch: { name: "名前を変えた" } });
    if (!r.ok) throw new Error(r.reason);
    applyModelDiff(doc, start, r.model, "local");

    const next = rebuildModel(doc, prev);
    expect(next).not.toBe(prev);
    expect(next).toStrictEqual(r.model);
    expect(next.elements).not.toBe(prev.elements);
    next.elements.forEach((e, i) => {
      if (e.id === targetId) expect(e).not.toBe(prev.elements[i]);
      else expect(e).toBe(prev.elements[i]);
    });
    // 関係・ボード・メタは丸ごと同じ
    expect(next.relations).toBe(prev.relations);
    expect(next.boards).toBe(prev.boards);
    expect(next.meta).toBe(prev.meta);
  });

  it("ノードを動かすと、そのボードとノードだけが新しくなる", () => {
    const start = createHotelSample();
    const doc = fresh(start);
    const prev = rebuildModel(doc);
    const board = start.boards.find((b) => b.nodes.length > 1)!;
    const node = board.nodes[0];
    const after: UntieModel = JSON.parse(JSON.stringify(start));
    const b2 = after.boards.find((b) => b.id === board.id)!;
    b2.nodes[0].x += 10;
    applyModelDiff(doc, start, after, "local");

    const next = rebuildModel(doc, prev);
    expect(next.elements).toBe(prev.elements);
    expect(next.relations).toBe(prev.relations);
    next.boards.forEach((b, i) => {
      if (b.id !== board.id) return expect(b).toBe(prev.boards[i]);
      expect(b).not.toBe(prev.boards[i]);
      expect(b.nodes[0]).not.toBe(prev.boards[i].nodes[0]);
      expect(b.nodes[0].elementId).toBe(node.elementId);
      b.nodes.slice(1).forEach((n, k) => expect(n).toBe(prev.boards[i].nodes[k + 1]));
    });
    expect(next).toStrictEqual(after);
  });
});

describe("rebuildModel は壊れた参照を表示から外す (Y.Doc は変えない)", () => {
  it("両端が無い関係・要素の無いノード・無い要素を指す targetIds・無い BUC/コンテキストを指す参照を外す", () => {
    let m = emptyModel();
    const add = (kind: Parameters<typeof addElement>[1]["kind"], id: string, init: Parameters<typeof addElement>[1]["init"] = {}, board = false) => {
      const r = addElement(m, { kind, name: id, id, init, ...(board ? { boardId: "board_main" } : {}) });
      if (!r.ok) throw new Error(r.reason);
      m = r.model;
    };
    add("actor", "actor_a", {}, true);
    add("activity", "act_a", {}, true);
    add("business", "biz_a");
    add("buc", "buc_a", { businessId: "biz_a" });
    add("activity", "act_b", { bucId: "buc_a" });
    add("context", "ctx_a");
    add("information", "info_a", { contextId: "ctx_a" });
    add("issue", "issue_a", { targetIds: ["actor_a", "act_a"].slice(0, 1) });
    const r = addRelation(m, { sourceId: "actor_a", targetId: "act_a", id: "rel_a" });
    if (!r.ok) throw new Error(r.reason);
    m = r.model;
    const doc = fresh(m);
    const roots = getRoots(doc);

    // 合流で壊れた状態を直接作る
    roots.elements.delete("actor_a"); // 関係・ノード・targetIds が宙に浮く
    roots.elements.delete("buc_a"); // act_b の bucId が宙に浮く
    roots.elements.delete("ctx_a"); // info_a の contextId が宙に浮く
    roots.elements.delete("biz_a"); // 業務の無い BUC (既定の活動) が残る
    roots.relations.set("rel_dangling", { kind: "actorActivity", sourceId: "nobody", targetId: "nothing", order: "a9" });

    const rebuilt = rebuildModel(doc);
    expectValid(rebuilt);
    expect(rebuilt.relations).toEqual([]);
    expect(rebuilt.boards[0].nodes.map((n) => n.elementId)).toEqual(["act_a"]);
    const get = (id: string) => rebuilt.elements.find((e) => e.id === id) as Record<string, unknown> | undefined;
    expect(get("issue_a")!.targetIds).toEqual([]);
    expect(get("act_b")!.bucId).toBeNull();
    expect(get("info_a")!.contextId).toBeNull();
    expect(rebuilt.elements.some((e) => e.kind === "buc")).toBe(false);
    // Y.Doc は変えていない
    expect(roots.relations.has("rel_a")).toBe(true);
    expect(roots.relations.has("rel_dangling")).toBe(true);
  });

  it("ボードが 0 枚なら emptyModel と同じ「ボード 1」を入れる (Y.Doc は変えない)", () => {
    const doc = fresh(emptyModel());
    const roots = getRoots(doc);
    roots.boards.delete("board_main");
    const rebuilt = rebuildModel(doc);
    expect(rebuilt.boards).toEqual(emptyModel().boards);
    expectValid(rebuilt);
    expect(roots.boards.size).toBe(0);
  });

  it("同じ関係の重複は先頭を残して表示から外す", () => {
    let m = emptyModel();
    for (const [kind, id] of [["actor", "actor_a"], ["activity", "act_a"]] as const) {
      const r = addElement(m, { kind, name: id, id });
      if (!r.ok) throw new Error(r.reason);
      m = r.model;
    }
    const r = addRelation(m, { sourceId: "actor_a", targetId: "act_a", id: "rel_1" });
    if (!r.ok) throw new Error(r.reason);
    const doc = fresh(r.model);
    getRoots(doc).relations.set("rel_2", { kind: "actorActivity", sourceId: "actor_a", targetId: "act_a", order: "a5" });
    const rebuilt = rebuildModel(doc);
    expect(rebuilt.relations.map((x) => x.id)).toEqual(["rel_1"]);
    expectValid(rebuilt);
  });
});

function okAddIssue(): UntieModel {
  const r = addElement(emptyModel(), { kind: "issue", name: "課題", id: "issue_x" });
  if (!r.ok) throw new Error(r.reason);
  return r.model;
}
