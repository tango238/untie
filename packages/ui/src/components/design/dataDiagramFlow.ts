// データボードの図 (ER 図) のノードと線を、DSL の解析結果から作る。位置はモデルに保存せず、
// 動かした位置だけをこの画面を開いている間 (ページを読み直すまで) データベースごとに覚える。
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { PrismaSchema } from "@untie/core/model/prisma";
import { prismaRelationLines } from "@untie/core/model/prismaEdit";

export const DIAGRAM_NODE_WIDTH = 260;
const HEAD_HEIGHT = 34;
const ROW_HEIGHT = 24;
const FOOT_HEIGHT = 28;
const GAP_X = 70;
const GAP_Y = 50;

export interface DiagramRow {
  name: string;
  /** 型の表記 (String? や Guest[]) */
  type: string;
  baseType: string;
  isId: boolean;
  isUnique: boolean;
  isOptional: boolean;
  isList: boolean;
  /** 関連のフィールド (型がテーブル) */
  isRelation: boolean;
  /** 外部キーとして関連に使っている列 */
  isForeignKey: boolean;
}

export interface TableNodeData extends Record<string, unknown> {
  table: string;
  mapName?: string;
  rows: DiagramRow[];
}

export interface EnumNodeData extends Record<string, unknown> {
  name: string;
  values: string[];
}

export type DiagramNode = Node<TableNodeData, "table"> | Node<EnumNodeData, "enum">;

export interface RelationEdgeData extends Record<string, unknown> {
  /** 外部キーを持つテーブル */
  model: string;
  /** 関連のフィールド */
  field: string;
}

export type DiagramEdge = Edge<RelationEdgeData>;

export const tableNodeId = (table: string) => `table:${table}`;
export const enumNodeId = (name: string) => `enum:${name}`;
/** 列の線の端の id (s: が外部キーの側の右端、t: が参照される側の左端) */
export const sourceHandleId = (column: string) => `s:${column}`;
export const targetHandleId = (column: string) => `t:${column}`;
export const columnOfHandle = (handle: string | null | undefined) => (handle ? handle.replace(/^[st]:/, "") : undefined);

// ---------------------------------------------------------------- 位置

type Point = { x: number; y: number };
const positions = new Map<string, Map<string, Point>>();

/** 動かした位置 (ノードの id → 位置) */
export function diagramPositions(databaseId: string): Map<string, Point> {
  let m = positions.get(databaseId);
  if (!m) positions.set(databaseId, (m = new Map()));
  return m;
}

export function setDiagramPosition(databaseId: string, nodeId: string, p: Point) {
  diagramPositions(databaseId).set(nodeId, { x: p.x, y: p.y });
}

/** テーブルの名前を変えたら、覚えた位置も付け替える */
export function renameDiagramPosition(databaseId: string, from: string, to: string) {
  const m = diagramPositions(databaseId);
  const p = m.get(tableNodeId(from));
  if (!p) return;
  m.delete(tableNodeId(from));
  m.set(tableNodeId(to), p);
}

/** 覚えた位置を捨てて並べ直す */
export function resetDiagramPositions(databaseId: string) {
  positions.delete(databaseId);
}

const estimatedHeight = (rows: number) => HEAD_HEIGHT + rows * ROW_HEIGHT + FOOT_HEIGHT;

// ---------------------------------------------------------------- 組み立て

/**
 * 図のノードと線。テーブル (model) と enum をノードに、外部キーの列 → 参照先の列を線にする。
 * 位置を覚えていないノードは、テーブル → enum の順に、ほぼ正方形の格子に並べる
 */
export function buildDataDiagram(schema: PrismaSchema, databaseId: string): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const modelNames = new Set(schema.models.map((m) => m.name));
  const lines = prismaRelationLines(schema);
  const fkOf = new Map<string, Set<string>>();
  for (const l of lines) {
    const s = fkOf.get(l.from) ?? new Set<string>();
    for (const f of l.fields) s.add(f);
    fkOf.set(l.from, s);
  }

  const items: { id: string; height: number; node: Omit<DiagramNode, "position"> }[] = [];
  for (const m of schema.models) {
    const rows: DiagramRow[] = m.fields.map((f) => ({
      name: f.name,
      type: `${f.type}${f.isList ? "[]" : ""}${f.isOptional ? "?" : ""}`,
      baseType: f.type,
      isId: f.isId || m.blockAttributes.some((a) => a.name === "id" && new RegExp(`\\b${f.name}\\b`).test(a.args)),
      isUnique: f.isUnique,
      isOptional: f.isOptional,
      isList: f.isList,
      isRelation: modelNames.has(f.type),
      isForeignKey: fkOf.get(m.name)?.has(f.name) ?? false,
    }));
    const id = tableNodeId(m.name);
    items.push({ id, height: estimatedHeight(rows.length), node: { id, type: "table", data: { table: m.name, ...(m.mapName ? { mapName: m.mapName } : {}), rows } } as Omit<DiagramNode, "position"> });
  }
  for (const e of schema.enums) {
    const id = enumNodeId(e.name);
    items.push({ id, height: HEAD_HEIGHT + e.values.length * 20 + 8, node: { id, type: "enum", data: { name: e.name, values: e.values } } as Omit<DiagramNode, "position"> });
  }

  const saved = diagramPositions(databaseId);
  const columns = Math.max(1, Math.ceil(Math.sqrt(items.length)));
  const nodes: DiagramNode[] = [];
  let y = 0;
  for (let i = 0; i < items.length; i += columns) {
    const row = items.slice(i, i + columns);
    row.forEach((it, c) => {
      // 並べた位置も覚える (あとでテーブルが増えても、今あるノードは動かさない)
      const position = saved.get(it.id) ?? { x: c * (DIAGRAM_NODE_WIDTH + GAP_X), y };
      saved.set(it.id, position);
      nodes.push({ ...it.node, position } as DiagramNode);
    });
    y += Math.max(...row.map((it) => it.height)) + GAP_Y;
  }

  const edges: DiagramEdge[] = [];
  for (const l of lines) {
    l.fields.forEach((fk, i) => {
      const ref = l.references[i];
      if (ref === undefined) return;
      edges.push({
        id: `rel:${l.from}.${l.field}:${i}`,
        source: tableNodeId(l.from),
        sourceHandle: sourceHandleId(fk),
        target: tableNodeId(l.to),
        targetHandle: targetHandleId(ref),
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { model: l.from, field: l.field },
      });
    });
  }
  return { nodes, edges };
}
