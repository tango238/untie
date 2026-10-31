import * as Y from "yjs";
import { vi } from "vitest";
import {
  addBoard,
  clearAll,
  addElement,
  addRelation,
  ELEMENT_KINDS,
  moveActivity,
  moveBuc,
  moveNode,
  moveToContext,
  placeOnBoard,
  removeBoard,
  removeElement,
  removeFromBoard,
  removeRelation,
  renameBoard,
  setEdgeSides,
  setIssueTargets,
  updateElement,
  EDGE_SIDES,
  type CommandResult,
  type Element,
  type ElementKind,
  type ElementPatch,
  type UntieModel,
} from "@untie/core";
import { ORDER_KEY, getRoots } from "..";

/** 乱数で選べる候補が無いときの例外 (これだけは飛ばしてよい。ほかの例外は本物のバグなので投げ直す) */
export class NoCandidate extends Error {
  constructor() {
    super("候補がありません");
  }
}

/** 決まった乱数 (線形合同法)。seed が同じなら毎回同じ列になる */
export function createRng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new NoCandidate();
      return items[Math.floor(next() * items.length)];
    },
    bool: (p = 0.5) => next() < p,
  };
}
export type Rng = ReturnType<typeof createRng>;

/**
 * Math.random を seed で決まる列につなぐ (順序キーの乱数後ろ付けと、newId の id が seed で決まる)。
 * テストの afterEach で vi.restoreAllMocks() を呼ぶこと。
 */
export function seedMathRandom(seed: number): void {
  const rng = createRng(seed ^ 0x5bd1e995);
  vi.spyOn(Math, "random").mockImplementation(rng.next);
}

const ofKind = <K extends ElementKind>(m: UntieModel, kind: K) =>
  m.elements.filter((e): e is Extract<Element, { kind: K }> => e.kind === kind);

const WORDS = ["受付", "確認", "請求", "予約", "清掃", "点検", "連絡", "変更"];
const word = (rng: Rng) => rng.pick(WORDS) + String(rng.int(100));

function randomPatch(el: Element, rng: Rng): ElementPatch {
  const patch: ElementPatch = {};
  const fields: (() => void)[] = [];
  if (!(el.kind === "buc" && el.isDefault)) fields.push(() => (patch.name = word(rng)));
  fields.push(() => (patch.description = rng.bool(0.3) ? "" : word(rng)));
  if (el.kind === "activity" || el.kind === "usecase") {
    fields.push(() => (patch.hours = rng.bool(0.3) ? null : rng.int(100) / 10));
    fields.push(() => (patch.links = rng.bool(0.3) ? [] : [{ title: word(rng), url: `https://example.com/${rng.int(1000)}` }]));
  }
  if (el.kind === "state") fields.push(() => (patch.group = rng.bool(0.3) ? "" : word(rng)));
  if (el.kind === "variation") fields.push(() => (patch.values = Array.from({ length: rng.int(4) }, () => word(rng))));
  if (el.kind === "issue") {
    fields.push(() => (patch.severity = 1 + rng.int(5)));
    fields.push(() => {
      const keys = ["phenomenon", "location", "cause", "impact"] as const;
      const key = rng.pick(keys);
      patch.analysis = rng.bool(0.1) ? null : { [key]: rng.bool(0.3) ? "" : word(rng) };
    });
  }
  // 1〜2 項目を変える
  for (let i = 0; i < 1 + rng.int(2); i++) rng.pick(fields)();
  return patch;
}

export interface RandomStep {
  /** 失敗の手がかりに残す、コマンド名と対象 */
  name: string;
  result: CommandResult;
}

/** 乱数でコマンドを 1 つ選んで当てる。失敗 (ok: false) もありうる */
export function randomCommand(model: UntieModel, rng: Rng): RandomStep {
  const name = { current: "" };
  const result = pickCommand(model, rng, name);
  return { name: name.current, result };
}

function pickCommand(model: UntieModel, rng: Rng, name: { current: string }): CommandResult {
  const els = model.elements;
  const boards = model.boards;
  const board = rng.pick(boards);
  const choice = rng.int(18);
  switch (choice) {
    case 0:
    case 1: {
      const kind = rng.pick(ELEMENT_KINDS);
      name.current = `addElement(${kind})`;
      const init: Parameters<typeof addElement>[1]["init"] = {};
      if (kind === "buc") init.businessId = rng.pick(ofKind(model, "business")).id;
      if (kind === "activity" && rng.bool(0.6)) init.bucId = rng.pick(ofKind(model, "buc")).id;
      if (["information", "state", "condition", "variation"].includes(kind) && rng.bool(0.6)) init.contextId = rng.pick(ofKind(model, "context")).id;
      if (kind === "variation") init.values = [word(rng), word(rng)];
      if (kind === "state" && rng.bool(0.5)) init.group = word(rng);
      if (kind === "issue") {
        init.severity = 1 + rng.int(5);
        init.targetIds = rng.bool(0.5) ? [rng.pick(ofKind(model, "actor")).id] : [];
      }
      if (rng.bool(0.4)) init.description = word(rng);
      return addElement(model, {
        kind,
        name: word(rng),
        init,
        ...(rng.bool(0.6) ? { boardId: board.id, position: { x: rng.int(1000), y: rng.int(1000) } } : {}),
      });
    }
    case 2:
    case 3:
    case 4: {
      const el = rng.pick(els);
      name.current = `updateElement(${el.kind})`;
      return updateElement(model, { id: el.id, patch: randomPatch(el, rng) });
    }
    case 5:
      name.current = "removeElement";
      return removeElement(model, { id: rng.pick(els).id });
    case 6:
      name.current = "moveActivity";
      return moveActivity(model, { activityId: rng.pick(ofKind(model, "activity")).id, bucId: rng.bool(0.2) ? null : rng.pick(ofKind(model, "buc")).id });
    case 7: {
      name.current = "moveToContext";
      const members = els.filter((e) => ["information", "state", "condition", "variation"].includes(e.kind));
      return moveToContext(model, { elementId: rng.pick(members).id, contextId: rng.bool(0.2) ? null : rng.pick(ofKind(model, "context")).id });
    }
    case 8:
      name.current = "moveBuc";
      return moveBuc(model, { bucId: rng.pick(ofKind(model, "buc")).id, businessId: rng.pick(ofKind(model, "business")).id });
    case 9: {
      name.current = "addRelation";
      // 組み合わせが合わないことが多いので、何度か引き直す
      for (let i = 0; i < 30; i++) {
        const r = addRelation(model, { sourceId: rng.pick(els).id, targetId: rng.pick(els).id });
        if (r.ok) return r;
      }
      return addRelation(model, { sourceId: els[0].id, targetId: els[0].id });
    }
    case 10:
      name.current = "removeRelation";
      return removeRelation(model, { id: rng.pick(model.relations).id });
    case 11: {
      const which = rng.int(3);
      name.current = ["addBoard", "renameBoard", "removeBoard"][which];
      return which === 0
        ? addBoard(model, { name: word(rng) })
        : which === 1
          ? renameBoard(model, { id: board.id, name: word(rng) })
          : removeBoard(model, { id: board.id });
    }
    case 12:
      name.current = "placeOnBoard";
      return placeOnBoard(model, { boardId: board.id, elementId: rng.pick(els).id, position: { x: rng.int(1000), y: rng.int(1000) } });
    case 13:
      name.current = "removeFromBoard";
      return removeFromBoard(model, { boardId: board.id, elementId: rng.pick(board.nodes).elementId });
    case 14: {
      name.current = "moveNode";
      const node = rng.pick(board.nodes);
      return moveNode(model, {
        boardId: board.id,
        elementId: node.elementId,
        position: { x: rng.int(1000), y: rng.int(1000) },
        ...(rng.bool(0.3) ? { size: { width: 100 + rng.int(300), height: 100 + rng.int(300) } } : {}),
      });
    }
    case 15: {
      if (rng.bool(0.5)) {
        name.current = "setEdgeSides";
        return setEdgeSides(model, {
          boardId: board.id,
          relationId: rng.pick(model.relations).id,
          ...(rng.bool(0.7) ? { sourceSide: rng.pick(EDGE_SIDES) } : {}),
          ...(rng.bool(0.7) ? { targetSide: rng.pick(EDGE_SIDES) } : {}),
        });
      }
      name.current = "setIssueTargets";
      const issues = ofKind(model, "issue");
      const targets: Element[] = rng.bool(0.5) ? ofKind(model, "actor") : ofKind(model, "activity");
      return setIssueTargets(model, {
        issueId: rng.pick(issues).id,
        targetIds: Array.from({ length: rng.int(3) }, () => rng.pick(targets).id),
      });
    }
    case 16:
      // 全部消す。ほかの手が選べなくなるので、たまにだけ
      if (rng.bool(0.15)) {
        name.current = "clearAll";
        return clearAll(model);
      }
      return setMeta(model, rng, name);
    default:
      return setMeta(model, rng, name);
  }
}

/** メタ (名前・説明) の変更。コマンドではないので、モデルを直接作る */
function setMeta(model: UntieModel, rng: Rng, name: { current: string }): CommandResult {
  name.current = "setMeta";
  return { ok: true, model: { ...model, meta: { name: word(rng), ...(rng.bool(0.6) ? { description: word(rng) } : {}) } } };
}

/**
 * 乱数でコマンドを当て続け、成功したものだけ model を進める。各ステップの (before, after) を渡す。
 * trace には成功した手の名前を順に積む (失敗メッセージに seed と一緒に出して、再現の手がかりにする)。
 * 選べる候補が無かった手 (NoCandidate) だけ飛ばし、ほかの例外は投げ直す。
 */
export function runRandomCommands(
  model: UntieModel,
  rng: Rng,
  count: number,
  onStep: (before: UntieModel, after: UntieModel) => void,
  trace: string[] = [],
): UntieModel {
  let current = model;
  for (let i = 0; i < count; i++) {
    let step: RandomStep;
    try {
      step = randomCommand(current, rng);
    } catch (e) {
      if (e instanceof NoCandidate) continue;
      throw e;
    }
    if (!step.result.ok) continue;
    trace.push(step.name);
    onStep(current, step.result.model);
    current = step.result.model;
  }
  return current;
}

/** 2 つの Y.Doc の更新を交換する (両方向) */
export function sync(a: Y.Doc, b: Y.Doc): void {
  const ua = Y.encodeStateAsUpdate(a);
  const ub = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(b, ua, "remote");
  Y.applyUpdate(a, ub, "remote");
}

/** a の状態を丸ごと写した新しい Y.Doc */
export function cloneDoc(a: Y.Doc): Y.Doc {
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return b;
}

/** Y.Doc にある順序キーを、要素・関係・ボード・各ボードのノードと線について列挙する */
export function allOrders(doc: Y.Doc): Record<string, string[]> {
  const roots = getRoots(doc);
  const out: Record<string, string[]> = {
    elements: [...roots.elements.values()].map((m) => m.get(ORDER_KEY) as string),
    relations: [...roots.relations.values()].map((r) => r.order),
    boards: [...roots.boards.values()].map((m) => m.get(ORDER_KEY) as string),
  };
  for (const [id, board] of roots.boards) {
    out[`nodes:${id}`] = [...(board.get("nodes") as Y.Map<{ order: string }>).values()].map((n) => n.order);
    out[`edges:${id}`] = [...(board.get("edges") as Y.Map<{ order: string }>).values()].map((n) => n.order);
  }
  return out;
}
