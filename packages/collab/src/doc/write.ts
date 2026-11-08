// モデルの項目を Y.Doc の値に変える書き込みの部品 (loadModel と applyModelDiff で共有する)。
import * as Y from "yjs";
import type { Board, BoardEdge, BoardNode, Database, DesignScreen, Element, IssueAnalysis, Layout, NavGroup, Relation, SystemDesign, Transition } from "@untie/core";
import { cloneJson } from "./json";
import { initialOrders } from "./order";
import { databaseKey, designKey, ORDER_KEY } from "./roots";
import type { DesignLayoutRecord, DesignMetaRecord, DesignScreenRecord, EdgeRecord, NavGroupRecord, NodeRecord, RelationRecord, TransitionRecord, UntieDocRoots } from "./roots";

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
  return { ...relationFields(r), order };
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
  return { kind: r.kind, sourceId: r.sourceId, targetId: r.targetId, ...(r.access !== undefined ? { access: r.access } : {}) };
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

// ---------------------------------------------------------------- 設計 (0.5.0)

/** order を除いた値 (比較用)。systemId を値に持たせる (設計が消えたら一緒に読み飛ばすため) */
export function designScreenFields(systemId: string, s: DesignScreen): Omit<DesignScreenRecord, "order"> {
  return {
    systemId,
    id: s.id,
    source: cloneJson(s.source),
    ...(s.shell !== undefined ? { shell: s.shell } : {}),
    ...(s.view !== undefined ? { view: cloneJson(s.view) } : {}),
    ...(s.bindings !== undefined ? { bindings: cloneJson(s.bindings) } : {}),
  };
}

export function transitionFields(systemId: string, t: Transition): Omit<TransitionRecord, "order"> {
  return { systemId, id: t.id, from: t.from, to: t.to, ...(t.via !== undefined ? { via: t.via } : {}), ...(t.label !== undefined ? { label: t.label } : {}) };
}

export function navGroupFields(systemId: string, g: NavGroup): Omit<NavGroupRecord, "order"> {
  return { systemId, id: g.id, group: g.group, items: cloneJson(g.items) };
}

/** ナビゲーションを除いたレイアウト */
export function layoutRecord(layout: Layout): DesignLayoutRecord {
  return { shell: layout.shell, ...(layout.header !== undefined ? { header: cloneJson(layout.header) } : {}) };
}

/** 設計を平らなキーに書く (loadModel と、applyModelDiff で足された設計) */
export function writeDesign(roots: UntieDocRoots, design: SystemDesign, order: string): void {
  const id = design.systemId;
  roots.designs.set(designKey(id, "meta"), { databaseIds: cloneJson(design.databaseIds), order } satisfies DesignMetaRecord);
  roots.designs.set(designKey(id, "layout"), layoutRecord(design.layout));
  const screens = initialOrders(design.screens.length);
  design.screens.forEach((s, i) => roots.designScreens.set(s.id, { ...designScreenFields(id, s), order: screens[i] }));
  const transitions = initialOrders(design.transitions.length);
  design.transitions.forEach((t, i) => roots.designTransitions.set(t.id, { ...transitionFields(id, t), order: transitions[i] }));
  const groups = initialOrders(design.layout.navigation.length);
  design.layout.navigation.forEach((g, i) => roots.designNav.set(g.id, { ...navGroupFields(id, g), order: groups[i] }));
}

/** データベースを平らなキーに書く。有無は `${id}/name` で決まる */
export function writeDatabase(roots: UntieDocRoots, db: Database, order: string): void {
  roots.databases.set(databaseKey(db.id, "name"), db.name);
  roots.databases.set(databaseKey(db.id, "dsl"), db.dsl);
  roots.databases.set(databaseKey(db.id, "tables"), cloneJson(db.tables));
  roots.databases.set(databaseKey(db.id, "order"), order);
}
