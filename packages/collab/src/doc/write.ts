// モデルの項目を Y.Doc の値に変える書き込みの部品 (loadModel と applyModelDiff で共有する)。
import * as Y from "yjs";
import type { Board, BoardEdge, BoardNode, Element, IssueAnalysis, Relation } from "@untie/core";
import { cloneJson } from "./json";
import { ORDER_KEY } from "./roots";
import type { EdgeRecord, NodeRecord, RelationRecord } from "./roots";

/** 要素の Y.Map に置かない項目 (id はキー、order は別に振る) */
export const ELEMENT_SKIPPED_KEYS: ReadonlySet<string> = new Set(["id", ORDER_KEY]);

/** 課題の分析を項目ごとの Y.Map にする */
export function analysisToYMap(analysis: IssueAnalysis): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(analysis)) if (v !== undefined) map.set(k, v);
  return map;
}

/**
 * 要素を Y.Map にする (id は入れない。キーになる)。
 * 課題の analysis は入れ子の Y.Map で、分析が無くても空の Y.Map を作っておく。
 * 別々の人が最初の項目を同時に書いても、同じ Y.Map に入って項目ごとに合流する (無いと後から作った Y.Map ごと負ける)。
 */
export function elementToYMap(element: Element, order: string): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(element)) {
    if (v === undefined || ELEMENT_SKIPPED_KEYS.has(k) || k === "analysis") continue;
    map.set(k, cloneJson(v));
  }
  if (element.kind === "issue") map.set("analysis", analysisToYMap(element.analysis ?? {}));
  map.set(ORDER_KEY, order);
  return map;
}

export function relationToRecord(r: Relation, order: string): RelationRecord {
  return { kind: r.kind, sourceId: r.sourceId, targetId: r.targetId, order };
}

/** order を除いた値 (比較用) */
export function nodeFields(n: BoardNode): Omit<NodeRecord, "order"> {
  return {
    x: n.x,
    y: n.y,
    ...(n.width !== undefined ? { width: n.width } : {}),
    ...(n.height !== undefined ? { height: n.height } : {}),
  };
}

export function edgeFields(e: BoardEdge): Omit<EdgeRecord, "order"> {
  return {
    ...(e.sourceSide !== undefined ? { sourceSide: e.sourceSide } : {}),
    ...(e.targetSide !== undefined ? { targetSide: e.targetSide } : {}),
  };
}

export function relationFields(r: Relation): Omit<RelationRecord, "order"> {
  return { kind: r.kind, sourceId: r.sourceId, targetId: r.targetId };
}

/** ボードを Y.Map にする。nodes と edges は空でも必ず作る (別々に足した 2 人が同じ Y.Map に入るように) */
export function boardToYMap(
  board: Board,
  order: string,
  nodeOrders: readonly string[],
  edgeOrders: readonly string[],
): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("name", board.name);
  map.set(ORDER_KEY, order);
  const nodes = new Y.Map<NodeRecord>();
  board.nodes.forEach((n, i) => nodes.set(n.elementId, { ...nodeFields(n), order: nodeOrders[i] }));
  map.set("nodes", nodes);
  const edges = new Y.Map<EdgeRecord>();
  (board.edges ?? []).forEach((e, i) => edges.set(e.relationId, { ...edgeFields(e), order: edgeOrders[i] }));
  map.set("edges", edges);
  return map;
}
