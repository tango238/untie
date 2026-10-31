import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addElement, addRelation, relationKindFor, removeElement, updateElement, validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { createHotelSample } from "@untie/core/sample";
import { applyModelDiff, getRoots, loadModel, rebuildModel } from "..";
import { allOrders, cloneDoc, createRng, runRandomCommands, seedMathRandom, sync } from "./helpers";

afterEach(() => vi.restoreAllMocks());

function expectValid(m: UntieModel) {
  const r = validateModel(JSON.parse(JSON.stringify(m)));
  expect(r.ok ? [] : r.errors).toEqual([]);
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error((r as unknown as { reason: string }).reason);
  return r as Extract<T, { ok: true }>;
}

/** 同じ初期モデルを持つ 2 つの Y.Doc (片方に入れて、もう片方へ update で写す。別々に入れると全要素が二重になる) */
function twoPeers(model: UntieModel) {
  const a = new Y.Doc();
  loadModel(a, model);
  return { a, b: cloneDoc(a), model };
}

const name = (m: UntieModel, id: string) => m.elements.find((e) => e.id === id)!.name;
const description = (m: UntieModel, id: string) => m.elements.find((e) => e.id === id)!.description;

describe("合流", () => {
  it("別々のコマンドを当てて update を交換すると、両方が同じモデルになる", () => {
    const { a, b, model } = twoPeers(createHotelSample());
    const ra = ok(updateElement(model, { id: "actor_front", patch: { name: "Aが変えた" } }));
    const rb = ok(addElement(model, { kind: "actor", name: "Bが足した", id: "actor_new", boardId: model.boards[0].id }));
    applyModelDiff(a, model, ra.model, "a");
    applyModelDiff(b, model, rb.model, "b");
    sync(a, b);
    const ma = rebuildModel(a);
    expect(rebuildModel(b)).toStrictEqual(ma);
    expect(name(ma, "actor_front")).toBe("Aが変えた");
    expect(ma.elements.some((e) => e.id === "actor_new")).toBe(true);
    expect(ma.boards[0].nodes.some((n) => n.elementId === "actor_new")).toBe(true);
    expectValid(ma);
  });

  it("同じ要素の name を両方で変えると、どちらかが残る (後勝ち)", () => {
    const { a, b, model } = twoPeers(createHotelSample());
    applyModelDiff(a, model, ok(updateElement(model, { id: "actor_front", patch: { name: "A" } })).model, "a");
    applyModelDiff(b, model, ok(updateElement(model, { id: "actor_front", patch: { name: "B" } })).model, "b");
    sync(a, b);
    const ma = rebuildModel(a);
    expect(["A", "B"]).toContain(name(ma, "actor_front"));
    expect(rebuildModel(b)).toStrictEqual(ma);
  });

  it("別の項目 (name と description) を変えると、両方残る", () => {
    const { a, b, model } = twoPeers(createHotelSample());
    applyModelDiff(a, model, ok(updateElement(model, { id: "actor_front", patch: { name: "新しい名前" } })).model, "a");
    applyModelDiff(b, model, ok(updateElement(model, { id: "actor_front", patch: { description: "新しい説明" } })).model, "b");
    sync(a, b);
    for (const doc of [a, b]) {
      const m = rebuildModel(doc);
      expect(name(m, "actor_front")).toBe("新しい名前");
      expect(description(m, "actor_front")).toBe("新しい説明");
    }
  });

  it("ボードのノードを別々に動かすと、別のノードの移動は両方残る", () => {
    const { a, b, model } = twoPeers(createHotelSample());
    const nodes = model.boards[0].nodes;
    const edit = (index: number, x: number): UntieModel => {
      const m: UntieModel = JSON.parse(JSON.stringify(model));
      m.boards[0].nodes[index].x = x;
      return m;
    };
    applyModelDiff(a, model, edit(0, 111), "a");
    applyModelDiff(b, model, edit(1, 222), "b");
    sync(a, b);
    const m = rebuildModel(a);
    expect(m.boards[0].nodes[0]).toMatchObject({ elementId: nodes[0].elementId, x: 111 });
    expect(m.boards[0].nodes[1]).toMatchObject({ elementId: nodes[1].elementId, x: 222 });
    expect(rebuildModel(b)).toStrictEqual(m);
  });

  it("片方で要素を消し、片方でその要素への関係を足すと、組み立てた結果にその関係は含まれず validateModel を通る", () => {
    const model = createHotelSample();
    // まだ関係の無い、結べる組み合わせを探す
    const actor = model.elements.find((e) => e.kind === "actor")!;
    const target = model.elements.find(
      (e) =>
        e.kind === "business" &&
        relationKindFor(actor.kind, e.kind) !== null &&
        !model.relations.some((r) => r.sourceId === actor.id && r.targetId === e.id),
    )!;
    const { a, b } = twoPeers(model);
    const removed = ok(removeElement(model, { id: target.id })).model;
    const added = ok(addRelation(model, { sourceId: actor.id, targetId: target.id, id: "rel_late" }));
    applyModelDiff(a, model, removed, "a");
    applyModelDiff(b, model, added.model, "b");
    sync(a, b);

    for (const doc of [a, b]) {
      // Y.Doc には関係が残るが、組み立てた出力には出ない
      expect(getRoots(doc).relations.has("rel_late")).toBe(true);
      const m = rebuildModel(doc);
      expect(m.relations.some((r) => r.id === "rel_late")).toBe(false);
      expect(m.elements.some((e) => e.id === target.id)).toBe(false);
      expectValid(m);
    }
    expect(rebuildModel(a)).toStrictEqual(rebuildModel(b));
  });

  it("同じ関係を両方で足すと (id が違う重複)、表示では 1 本に畳まれ、両方で同じになる", () => {
    const model = createHotelSample();
    const actor = model.elements.find((e) => e.kind === "actor")!;
    const biz = model.elements.find(
      (e) => e.kind === "business" && !model.relations.some((r) => r.sourceId === actor.id && r.targetId === e.id),
    )!;
    const { a, b } = twoPeers(model);
    applyModelDiff(a, model, ok(addRelation(model, { sourceId: actor.id, targetId: biz.id, id: "rel_x" })).model, "a");
    applyModelDiff(b, model, ok(addRelation(model, { sourceId: actor.id, targetId: biz.id, id: "rel_y" })).model, "b");
    sync(a, b);
    const m = rebuildModel(a);
    expect(m.relations.filter((r) => r.sourceId === actor.id && r.targetId === biz.id)).toHaveLength(1);
    expect(rebuildModel(b)).toStrictEqual(m);
    expectValid(m);
  });

  it("コマンドをランダムに当てて交換する往復を繰り返しても、両方が同じモデルで validateModel を通る (20 seed)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      seedMathRandom(seed);
      const rng = createRng(1000 + seed);
      const start = createHotelSample();
      const { a, b } = twoPeers(start);
      let ma = start;
      let mb = start;
      const trace: string[] = [];
      for (let round = 0; round < 4; round++) {
        const where = (side: string) => `seed ${seed} round ${round} ${side}: ${trace.join(" → ")}`;
        // 各ステップで、自分の Doc から組み立てたモデルが手元の after と一致する
        ma = runRandomCommands(ma, rng, 1 + rng.int(10), (before, after) => {
          applyModelDiff(a, before, after, "a");
          trace.push("(a)");
          expect(rebuildModel(a), where("a")).toStrictEqual(after);
        }, trace);
        mb = runRandomCommands(mb, rng, 1 + rng.int(10), (before, after) => {
          applyModelDiff(b, before, after, "b");
          trace.push("(b)");
          expect(rebuildModel(b), where("b")).toStrictEqual(after);
        }, trace);
        sync(a, b);
        const merged = rebuildModel(a);
        expect(rebuildModel(b), where("merge")).toStrictEqual(merged);
        expectValid(merged);
        // 合流後は、組み立てたモデルを各自の手元のモデルにする (ストアが行うこと)
        ma = merged;
        mb = merged;
      }
      vi.restoreAllMocks();
    }
  });
});

describe("順序", () => {
  const ids = (m: UntieModel) => m.elements.map((e) => e.id);

  it("2 つの Doc で別々に要素を足して合流しても、順序が両方で同じで、order の重複が無い", () => {
    const { a, b, model } = twoPeers(createHotelSample());
    let ma = model;
    let mb = model;
    for (let i = 0; i < 3; i++) {
      const ra = ok(addElement(ma, { kind: "actor", name: `A${i}`, id: `actor_a${i}` }));
      applyModelDiff(a, ma, ra.model, "a");
      ma = ra.model;
      const rb = ok(addElement(mb, { kind: "actor", name: `B${i}`, id: `actor_b${i}` }));
      applyModelDiff(b, mb, rb.model, "b");
      mb = rb.model;
    }
    sync(a, b);
    const merged = rebuildModel(a);
    expect(ids(rebuildModel(b))).toEqual(ids(merged));
    expect(merged.elements).toHaveLength(model.elements.length + 6);
    // 各自の足した順は保たれる
    const pos = (id: string) => ids(merged).indexOf(id);
    expect(pos("actor_a0")).toBeLessThan(pos("actor_a1"));
    expect(pos("actor_a1")).toBeLessThan(pos("actor_a2"));
    expect(pos("actor_b0")).toBeLessThan(pos("actor_b1"));
    expect(pos("actor_b1")).toBeLessThan(pos("actor_b2"));
    for (const doc of [a, b]) {
      for (const [key, keys] of Object.entries(allOrders(doc))) expect(new Set(keys).size, key).toBe(keys.length);
    }
  });

  it("途中に足すと、足した要素にだけ隣のキーの間の値が振られ、既存のキーは動かない", () => {
    const model = createHotelSample();
    const doc = new Y.Doc();
    loadModel(doc, model);
    const roots = getRoots(doc);
    const orderOf = () => new Map([...roots.elements].map(([id, m]) => [id, m.get("order") as string]));
    const before = orderOf();
    const added = ok(addElement(model, { kind: "actor", name: "途中", id: "actor_mid" })).model;
    // 末尾に足された要素を 3 番目へ動かす
    const moved = added.elements.slice();
    const [last] = moved.splice(moved.length - 1, 1);
    moved.splice(2, 0, last);
    const after: UntieModel = { ...added, elements: moved };
    applyModelDiff(doc, model, after, "local");
    const now = orderOf();
    for (const [id, key] of before) expect(now.get(id)).toBe(key);
    const k = (i: number) => now.get(moved[i].id)!;
    expect(k(1) < k(2) && k(2) < k(3)).toBe(true);
    expect(ids(rebuildModel(doc))).toEqual(moved.map((e) => e.id));
  });

  it("既存の順が入れ替わっていたら最小限のキーだけ振り直す", () => {
    const model = createHotelSample();
    const doc = new Y.Doc();
    loadModel(doc, model);
    const roots = getRoots(doc);
    const orderOf = () => new Map([...roots.elements].map(([id, m]) => [id, m.get("order") as string]));
    const before = orderOf();
    // 先頭の要素を末尾へ動かす
    const elements = model.elements.slice(1).concat(model.elements[0]);
    applyModelDiff(doc, model, { ...model, elements }, "local");
    const now = orderOf();
    const changed = [...before].filter(([id, key]) => now.get(id) !== key).map(([id]) => id);
    expect(changed).toEqual([model.elements[0].id]);
    expect(ids(rebuildModel(doc))).toEqual(elements.map((e) => e.id));
  });

  it("ボード・関係・ノードの並び替えも往復できる", () => {
    const model = createHotelSample();
    const doc = new Y.Doc();
    loadModel(doc, model);
    const reversed: UntieModel = {
      ...model,
      relations: model.relations.slice().reverse(),
      boards: model.boards.map((b) => ({ ...b, nodes: b.nodes.slice().reverse() })).reverse() as UntieModel["boards"],
    };
    applyModelDiff(doc, model, reversed, "local");
    expect(rebuildModel(doc)).toStrictEqual(reversed);
  });
});
