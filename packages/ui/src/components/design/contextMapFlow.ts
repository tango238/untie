// コンテキストマップの図 (5.7): 境界づけられたコンテキストをノードに、関係を線にする。位置は保存せず、上流を左・下流を右に毎回決める。
// 保存した関係は実線 (ラベルは 種類の略号 · 統合の方式)、つながりがあるのに関係を決めていない組は破線 (「未決」)。
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { CONTEXT_RELATION_SHORT, INTEGRATION_ENGLISH, SUBDOMAIN_LABELS, SYMMETRIC_RELATION_KINDS } from "@untie/core/model/domain";
import type { ContextMap } from "@untie/core/model/domainMap";
import type { BoundedContext } from "@untie/core/model/types";

export interface ContextNodeData extends Record<string, unknown> {
  context: BoundedContext;
  /** 分類の表示 (未定なら空) */
  subdomain: string;
  /** 実装するシステムの名前 (無ければ「未割り当て」) */
  systems: string;
  /** 集約の数 (0 なら外部) */
  aggregates: number;
}
export type ContextNode = Node<ContextNodeData, "context">;

export const CONTEXT_NODE_WIDTH = 210;
export const CONTEXT_NODE_HEIGHT = 74;
const COLUMN_GAP = 150;
const ROW_GAP = 40;

/**
 * 図のノードと線。層は、上流から下流へ辿った最長の距離 (輪になる線は、先に出たものを順方向として、戻る線は層を決めるのに使わない)
 */
export function buildContextMapFlow(map: ContextMap, systemName: (id: string) => string, aggregateCount: (contextId: string) => number): { nodes: ContextNode[]; edges: Edge[] } {
  const ids = map.contexts.map((c) => c.id);
  // 線: 保存した関係と、未決のつながり
  type Line = { id: string; source: string; target: string; label: string; undecided: boolean; symmetric: boolean };
  const relations = [...new Map([...map.flows.flatMap((f) => (f.relation ? [f.relation] : f.reverseRelation ? [f.reverseRelation] : [])), ...map.relationsWithoutFlow].map((r) => [r.id, r])).values()];
  const lines: Line[] = [
    ...relations.map((r) => ({
      id: r.id,
      source: r.upstreamId,
      target: r.downstreamId,
      label: `${CONTEXT_RELATION_SHORT[r.kind]}${r.integration ? ` · ${INTEGRATION_ENGLISH[r.integration]}` : ""}`,
      undecided: false,
      symmetric: SYMMETRIC_RELATION_KINDS.has(r.kind),
    })),
    ...map.flows.filter((f) => !f.relation && !f.reverseRelation).map((f) => ({ id: `flow:${f.upstreamId}:${f.downstreamId}`, source: f.upstreamId, target: f.downstreamId, label: "未決", undecided: true, symmetric: false })),
  ];
  // 層: 戻る線 (すでに逆向きに辿れる組) を除いて、最長の距離
  const forward = new Map<string, string[]>(ids.map((id) => [id, []]));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set([from]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      if (queue[i] === to) return true;
      for (const next of forward.get(queue[i]!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return false;
  };
  for (const l of lines) {
    if (!forward.has(l.source) || !forward.has(l.target) || reaches(l.target, l.source)) continue;
    forward.get(l.source)!.push(l.target);
  }
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const id of ids) {
      for (const next of forward.get(id) ?? []) {
        if (layer.get(next)! < layer.get(id)! + 1) {
          layer.set(next, layer.get(id)! + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  const nodes: ContextNode[] = map.contexts.map((c) => {
    const col = layer.get(c.id) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    return {
      id: c.id,
      type: "context" as const,
      position: { x: col * (CONTEXT_NODE_WIDTH + COLUMN_GAP), y: row * (CONTEXT_NODE_HEIGHT + ROW_GAP) + (col % 2) * 24 },
      width: CONTEXT_NODE_WIDTH,
      height: CONTEXT_NODE_HEIGHT,
      data: {
        context: c,
        subdomain: c.subdomain ? SUBDOMAIN_LABELS[c.subdomain] : "",
        systems: c.systemIds.length > 0 ? c.systemIds.map(systemName).join("・") : "未割り当て",
        aggregates: aggregateCount(c.id),
      },
    };
  });
  const edges: Edge[] = lines
    .filter((l) => forward.has(l.source) && forward.has(l.target))
    .map((l) => ({
      id: l.id,
      source: l.source,
      target: l.target,
      label: l.label,
      markerEnd: { type: MarkerType.ArrowClosed },
      ...(l.symmetric ? { markerStart: { type: MarkerType.ArrowClosed } } : {}),
      ...(l.undecided ? { style: { strokeDasharray: "5 4" }, className: "is-undecided" } : {}),
    }));
  return { nodes, edges };
}
