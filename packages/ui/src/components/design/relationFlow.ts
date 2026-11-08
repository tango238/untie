// 関連ボードの情報・テーブル・画面を React Flow のノード・エッジに直す。位置は保存せず、毎回ここで決める (3 列。各列は上から縦に積む)。
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { DesignRelationSelection, RelationEdge, RelationGraph } from "@untie/core/model/designRelation";

export const RELATION_COLUMN_X = { information: 0, table: 300, screen: 680 } as const;
export const RELATION_INFO_WIDTH = 180;
export const RELATION_INFO_HEIGHT = 44;
export const RELATION_TABLE_WIDTH = 240;
export const RELATION_TABLE_HEAD_HEIGHT = 30;
export const RELATION_ROW_HEIGHT = 22;
/** テーブルのノードの下の余白 */
const TABLE_PAD = 6;
export const RELATION_SCREEN_WIDTH = 240;
export const RELATION_SCREEN_HEIGHT = 44;
const GAP_Y = 20;
/** データベースの枠の見出しの高さと、枠の内側の余白 */
const FRAME_HEAD = 28;
const FRAME_PAD = 10;

/** ノードを押したときに選ぶもの */
interface WithSelection {
  selection: DesignRelationSelection;
}

export interface RelationInfoData extends Record<string, unknown>, WithSelection {
  informationId: string;
  name: string;
  /** どのテーブルにも対応していない (赤の印「未対応」) */
  unmapped: boolean;
  selected: boolean;
  dim: boolean;
}
export interface RelationTableRow {
  name: string;
  type: string;
  usedBy: number;
}
export interface RelationTableData extends Record<string, unknown>, WithSelection {
  databaseId: string;
  table: string;
  /** 画面から使われている項目の行 */
  rows: RelationTableRow[];
  /** 畳んだ (画面から使われていない) 項目の数 */
  folded: number;
  selected: boolean;
  dim: boolean;
}
export interface RelationScreenData extends Record<string, unknown>, WithSelection {
  screenId: string;
  name: string;
  hasView: boolean;
  /** 列の対応が無い項目の数 (0 なら印を出さない。黄の印「未対応 n」) */
  unbound: number;
  selected: boolean;
  dim: boolean;
}
export interface RelationFrameData extends Record<string, unknown> {
  name: string;
}

export type RelationFlowNode =
  | Node<RelationInfoData, "information">
  | Node<RelationTableData, "table">
  | Node<RelationScreenData, "screen">
  | Node<RelationFrameData, "frame">;

export const informationNodeId = (id: string) => `information:${id}`;
export const tableNodeId = (databaseId: string, table: string) => `table:${databaseId}:${table}`;
export const screenNodeId = (id: string) => `screen:${id}`;
const frameNodeId = (databaseId: string) => `db:${databaseId}`;

const edgeId = (e: RelationEdge): string =>
  e.kind === "informationTable" ? `ie:${e.informationId}:${e.databaseId}:${e.table}` : `ce:${e.databaseId}:${e.table}:${e.column}:${e.screenId}`;

/** テーブルのノードの高さ: 見出し + 使われている項目の行 + 畳んだ行 */
export function relationTableHeight(usedRows: number, folded: number): number {
  return RELATION_TABLE_HEAD_HEIGHT + usedRows * RELATION_ROW_HEIGHT + (folded > 0 ? RELATION_ROW_HEIGHT : 0) + TABLE_PAD;
}

/** 選んだものにつながるノードと線 (1 ホップ。情報 → テーブル → 画面)。選んでいなければ null (全部そのまま) */
export function relationHighlight(graph: RelationGraph, sel: DesignRelationSelection | undefined): { nodes: Set<string>; edges: Set<string> } | null {
  if (!sel) return null;
  // 選んだものが図に無いときは、全部薄くならないよう何も強調しない
  const inGraph =
    sel.kind === "information"
      ? graph.informations.some((i) => i.id === sel.id)
      : sel.kind === "screen"
        ? graph.screens.some((s) => s.id === sel.id)
        : graph.databases.some((d) => d.id === sel.databaseId && d.tables.some((t) => t.name === sel.table));
  if (!inGraph) return null;
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const tableKey = (e: { databaseId: string; table: string }) => tableNodeId(e.databaseId, e.table);
  // 選んだものから見える表と、その表の情報・画面の線をどこまで含めるか
  const tables = new Set<string>();
  if (sel.kind === "information") {
    nodes.add(informationNodeId(sel.id));
    for (const e of graph.edges) {
      if (e.kind === "informationTable" && e.informationId === sel.id) {
        tables.add(tableKey(e));
        edges.add(edgeId(e));
      }
    }
  } else if (sel.kind === "table") {
    tables.add(tableNodeId(sel.databaseId, sel.table));
    for (const e of graph.edges) if (e.kind === "informationTable" && tableKey(e) === tableNodeId(sel.databaseId, sel.table)) edges.add(edgeId(e)), nodes.add(informationNodeId(e.informationId));
  } else {
    nodes.add(screenNodeId(sel.id));
    for (const e of graph.edges) {
      if (e.kind === "columnScreen" && e.screenId === sel.id) {
        tables.add(tableKey(e));
        edges.add(edgeId(e));
      }
    }
    for (const e of graph.edges) if (e.kind === "informationTable" && tables.has(tableKey(e))) edges.add(edgeId(e)), nodes.add(informationNodeId(e.informationId));
  }
  for (const t of tables) nodes.add(t);
  if (sel.kind !== "screen") {
    for (const e of graph.edges) if (e.kind === "columnScreen" && tables.has(tableKey(e))) edges.add(edgeId(e)), nodes.add(screenNodeId(e.screenId));
  }
  return { nodes, edges };
}

export function buildRelationFlow(graph: RelationGraph, sel: DesignRelationSelection | undefined): { nodes: RelationFlowNode[]; edges: Edge[] } {
  const hl = relationHighlight(graph, sel);
  const dimmed = (id: string) => hl !== null && !hl.nodes.has(id);
  const nodes: RelationFlowNode[] = [];

  // 左の列: 情報
  let y = 0;
  for (const info of graph.informations) {
    const id = informationNodeId(info.id);
    nodes.push({
      id,
      type: "information",
      position: { x: RELATION_COLUMN_X.information, y },
      width: RELATION_INFO_WIDTH,
      height: RELATION_INFO_HEIGHT,
      draggable: false,
      data: { selection: { kind: "information", id: info.id }, informationId: info.id, name: info.name, unmapped: info.unmapped, selected: sel?.kind === "information" && sel.id === info.id, dim: dimmed(id) },
    });
    y += RELATION_INFO_HEIGHT + GAP_Y;
  }

  // 中の列: テーブル。データベースが 2 つ以上なら、データベースごとに枠にまとめる
  const framed = graph.databases.length >= 2;
  y = 0;
  for (const db of graph.databases) {
    const frameId = frameNodeId(db.id);
    let innerY = framed ? FRAME_HEAD : 0;
    const innerX = framed ? FRAME_PAD : 0;
    const tableNodes: RelationFlowNode[] = [];
    for (const t of db.tables) {
      const used = t.columns.filter((c) => c.usedBy.length > 0);
      const folded = t.columns.length - used.length;
      const height = relationTableHeight(used.length, folded);
      const id = tableNodeId(db.id, t.name);
      tableNodes.push({
        id,
        type: "table",
        position: framed ? { x: innerX, y: innerY } : { x: RELATION_COLUMN_X.table, y: y + innerY },
        ...(framed ? { parentId: frameId, extent: "parent" as const } : {}),
        width: RELATION_TABLE_WIDTH,
        height,
        draggable: false,
        data: {
          selection: { kind: "table", databaseId: db.id, table: t.name },
          databaseId: db.id,
          table: t.name,
          rows: used.map((c) => ({ name: c.name, type: c.type, usedBy: c.usedBy.length })),
          folded,
          selected: sel?.kind === "table" && sel.databaseId === db.id && sel.table === t.name,
          dim: dimmed(id),
        },
      });
      innerY += height + GAP_Y;
    }
    const contentHeight = Math.max(0, innerY - GAP_Y);
    if (framed) {
      const frameHeight = Math.max(FRAME_HEAD + 20, contentHeight + FRAME_PAD);
      nodes.push({
        id: frameId,
        type: "frame",
        position: { x: RELATION_COLUMN_X.table - FRAME_PAD, y },
        width: RELATION_TABLE_WIDTH + FRAME_PAD * 2,
        height: frameHeight,
        draggable: false,
        selectable: false,
        data: { name: db.name },
      });
      y += frameHeight + GAP_Y;
    } else y += Math.max(0, contentHeight) + (db.tables.length > 0 ? GAP_Y : 0);
    // 親 (枠) のノードは、子より前に置く
    nodes.push(...tableNodes);
  }

  // 右の列: 画面
  y = 0;
  for (const s of graph.screens) {
    const id = screenNodeId(s.id);
    nodes.push({
      id,
      type: "screen",
      position: { x: RELATION_COLUMN_X.screen, y },
      width: RELATION_SCREEN_WIDTH,
      height: RELATION_SCREEN_HEIGHT,
      draggable: false,
      data: { selection: { kind: "screen", id: s.id }, screenId: s.id, name: s.name, hasView: s.hasView, unbound: s.unbound, selected: sel?.kind === "screen" && sel.id === s.id, dim: dimmed(id) },
    });
    y += RELATION_SCREEN_HEIGHT + GAP_Y;
  }

  const edges: Edge[] = graph.edges.map((e) => {
    const id = edgeId(e);
    const dim = hl !== null && !hl.edges.has(id);
    const base = { id, markerEnd: { type: MarkerType.ArrowClosed }, className: dim ? "is-dim" : "" };
    return e.kind === "informationTable"
      ? { ...base, source: informationNodeId(e.informationId), target: tableNodeId(e.databaseId, e.table) }
      : { ...base, source: tableNodeId(e.databaseId, e.table), sourceHandle: e.column, target: screenNodeId(e.screenId) };
  });
  return { nodes, edges };
}
