import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { addBoard, addElement, addRelation, moveNode, removeElement, updateElement } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { createHotelSample } from "@untie/core/sample";
import { applyModelDiff, loadModel, observeModelChanges } from "..";
import type { ModelChanges } from "..";
import { cloneDoc } from "./helpers";

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error((r as unknown as { reason: string }).reason);
  return r as Extract<T, { ok: true }>;
}

/** リモートの Doc で model を before → after に変え、その update を観測する Doc に当てたときに届く通知 */
function observeRemote(before: UntieModel, edit: (m: UntieModel) => UntieModel) {
  const remote = new Y.Doc();
  loadModel(remote, before);
  const local = cloneDoc(remote);
  const calls: { changed: ModelChanges; origin: unknown }[] = [];
  const stop = observeModelChanges(local, (changed, origin) => calls.push({ changed, origin }));

  const sv = Y.encodeStateVector(local);
  applyModelDiff(remote, before, edit(before), "remote-user");
  Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, sv), "network");
  return { calls, stop, local };
}

const sets = (c: ModelChanges) => ({
  elements: [...c.elements].sort(),
  relations: [...c.relations].sort(),
  boards: [...c.boards].sort(),
  meta: c.meta,
});

describe("observeModelChanges", () => {
  it("リモートの update を当てると、変わった要素の id だけが 1 回届く", () => {
    const { calls } = observeRemote(createHotelSample(), (m) => ok(updateElement(m, { id: "actor_front", patch: { name: "変えた", description: "説明" } })).model);
    expect(calls).toHaveLength(1);
    expect(sets(calls[0].changed)).toEqual({ elements: ["actor_front"], relations: [], boards: [], meta: false });
    expect(calls[0].origin).toBe("network");
  });

  it("要素の追加は、要素・ボードのノードの id が届く", () => {
    const m0 = createHotelSample();
    const boardId = m0.boards[0].id;
    const { calls } = observeRemote(m0, (m) => ok(addElement(m, { kind: "actor", name: "新", id: "actor_new", boardId })).model);
    expect(calls).toHaveLength(1);
    expect(sets(calls[0].changed)).toEqual({ elements: ["actor_new"], relations: [], boards: [boardId], meta: false });
  });

  it("関係の追加・要素の削除では、関係と要素の id が届く", () => {
    const m0 = createHotelSample();
    const actor = m0.elements.find((e) => e.kind === "actor")!;
    const biz = m0.elements.find(
      (e) => e.kind === "business" && !m0.relations.some((r) => r.sourceId === actor.id && r.targetId === e.id),
    )!;
    const added = observeRemote(m0, (m) => ok(addRelation(m, { sourceId: actor.id, targetId: biz.id, id: "rel_new" })).model);
    expect(sets(added.calls[0].changed)).toEqual({ elements: [], relations: ["rel_new"], boards: [], meta: false });

    const removeId = "act_clean";
    const removed = observeRemote(m0, (m) => ok(removeElement(m, { id: removeId })).model);
    expect(removed.calls).toHaveLength(1);
    // 消した要素と、その要素を対象にしていた課題 (targetIds が変わる)
    expect([...removed.calls[0].changed.elements].sort()).toEqual([removeId, "issue_cleaning_phone"].sort());
    expect(removed.calls[0].changed.relations.size).toBeGreaterThan(0);
  });

  it("ノードの移動は、そのボードの id だけが届く", () => {
    const m0 = createHotelSample();
    const board = m0.boards[0];
    const { calls } = observeRemote(m0, (m) => ok(moveNode(m, { boardId: board.id, elementId: board.nodes[0].elementId, position: { x: 999, y: 999 } })).model);
    expect(sets(calls[0].changed)).toEqual({ elements: [], relations: [], boards: [board.id], meta: false });
  });

  it("ボードの追加と meta の変更", () => {
    const m0 = createHotelSample();
    const { calls } = observeRemote(m0, (m) => {
      const added = ok(addBoard(m, { name: "新しいボード", id: "board_new" })).model;
      return { ...added, meta: { ...added.meta, name: "新しい名前" } };
    });
    expect(sets(calls[0].changed)).toEqual({ elements: [], relations: [], boards: ["board_new"], meta: true });
  });

  it("自分の書き込みの origin も届く。解除したあとは届かない", () => {
    const m0 = createHotelSample();
    const doc = new Y.Doc();
    loadModel(doc, m0);
    const calls: unknown[] = [];
    const stop = observeModelChanges(doc, (_c, origin) => calls.push(origin));
    applyModelDiff(doc, m0, ok(updateElement(m0, { id: "actor_front", patch: { name: "x" } })).model, "local");
    expect(calls).toEqual(["local"]);
    stop();
    applyModelDiff(doc, m0, ok(updateElement(m0, { id: "actor_front", patch: { name: "y" } })).model, "local");
    expect(calls).toEqual(["local"]);
  });
});
