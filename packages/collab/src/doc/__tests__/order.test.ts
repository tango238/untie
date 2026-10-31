import { describe, expect, it } from "vitest";
import { compareOrder, planOrders } from "../order";
import { createRng } from "./helpers";

const existing = (keys: Record<string, string>) => (id: string) => keys[id];

describe("planOrders", () => {
  it("すでに増えている並びなら何も振り直さない", () => {
    expect(planOrders(["a", "b", "c"], existing({ a: "a0", b: "a1", c: "a2" })).size).toBe(0);
  });

  it("キーの無い id にだけ、前後のキーの間の値を振る", () => {
    const plan = planOrders(["a", "x", "b"], existing({ a: "a0", b: "a1" }));
    expect([...plan.keys()]).toEqual(["x"]);
    expect(compareOrder("a0", plan.get("x")!)).toBe(-1);
    expect(compareOrder(plan.get("x")!, "a1")).toBe(-1);
  });

  it("先頭・末尾・複数連続でも、並びが厳密に増える", () => {
    const plan = planOrders(["p", "q", "a", "r", "s", "b", "t"], existing({ a: "a0", b: "a1" }));
    const keys = { a: "a0", b: "a1", ...Object.fromEntries(plan) };
    const seq = ["p", "q", "a", "r", "s", "b", "t"].map((id) => keys[id as keyof typeof keys]);
    for (let i = 1; i < seq.length; i++) expect(compareOrder(seq[i - 1], seq[i])).toBe(-1);
    expect(plan.size).toBe(5);
  });

  it("入れ替わった並びは最小限だけ振り直す", () => {
    // d を先頭へ: a b c は動かさず d だけ
    const plan = planOrders(["d", "a", "b", "c"], existing({ a: "a0", b: "a1", c: "a2", d: "a3" }));
    expect([...plan.keys()]).toEqual(["d"]);
  });

  it("同じキーが並ぶ (重複) 場合は片方だけ振り直し、重複が解消する", () => {
    const plan = planOrders(["a", "b"], existing({ a: "a0", b: "a0" }));
    expect(plan.size).toBe(1);
  });

  it("形の不正なキーだけを振り直し、ほかのキーは動かさない", () => {
    const plan = planOrders(["a", "b", "c", "d"], existing({ a: "a0", b: "!!", c: "a1", d: "" }));
    expect([...plan.keys()].sort()).toEqual(["b", "d"]);
    const keys: Record<string, string> = { a: "a0", c: "a1", ...Object.fromEntries(plan) };
    const seq = ["a", "b", "c", "d"].map((id) => keys[id]);
    for (let i = 1; i < seq.length; i++) expect(compareOrder(seq[i - 1], seq[i])).toBe(-1);
  });

  it("乱数で並べ替えを繰り返しても、振り直したあとの並びは常に厳密に増える", () => {
    const rng = createRng(7);
    let ids = Array.from({ length: 12 }, (_, i) => `id${i}`);
    let keys: Record<string, string> = {};
    for (const [i, id] of ids.entries()) keys[id] = String.fromCharCode(97) + String(i).padStart(2, "0").replace(/0+$/, "1");
    keys = Object.fromEntries(planOrders(ids, () => undefined));
    for (let step = 0; step < 200; step++) {
      const next = ids.slice();
      if (rng.bool(0.5)) {
        const [x] = next.splice(rng.int(next.length), 1);
        next.splice(rng.int(next.length + 1), 0, x);
      } else {
        next.splice(rng.int(next.length + 1), 0, `n${step}`);
      }
      const plan = planOrders(next, (id) => keys[id]);
      keys = { ...keys, ...Object.fromEntries(plan) };
      const seq = next.map((id) => keys[id]);
      for (let i = 1; i < seq.length; i++) expect(compareOrder(seq[i - 1], seq[i]), `step ${step}`).toBe(-1);
      ids = next;
    }
  });
});
