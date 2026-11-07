// サイトマップの画面と遷移を React Flow のノード・エッジに直す。位置は保存せず、毎回ここで決める。
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { TRANSITION_VIA_LABELS, designScreenName } from "@untie/core/model/sitemap";
import type { SystemDesign, UntieModel } from "@untie/core/model/types";

export const SITEMAP_NODE_WIDTH = 200;
export const SITEMAP_NODE_HEIGHT = 72;
const GAP_X = 90;
const GAP_Y = 28;

export interface SitemapNodeData extends Record<string, unknown> {
  designScreenId: string;
  name: string;
  /** 入口の画面か (分析の画面で、サイトマップで入ってくる遷移が無い) */
  entry: boolean;
  /** 入口の注記を 1 行に */
  note: string;
  builtin: boolean;
  selected: boolean;
}

export type SitemapFlowNode = Node<SitemapNodeData, "screen">;

/**
 * 層 (左から右へ) を決める。入ってくる遷移が無い画面 (サインイン・トップページ・入口の画面) から幅優先で辿った距離を層にする。
 * 輪だけでつながって入口の無い画面は、先にある画面から辿る。遷移が 1 本も無い孤立した画面は、最後の列
 */
export function sitemapLayers(design: Pick<SystemDesign, "screens" | "transitions">, entryIds: readonly string[] = []): Map<string, number> {
  const ids = design.screens.map((s) => s.id);
  const known = new Set(ids);
  const transitions = design.transitions.filter((t) => known.has(t.from) && known.has(t.to) && t.from !== t.to);
  const out = new Map<string, string[]>();
  const hasIn = new Set<string>();
  const connected = new Set<string>();
  for (const t of transitions) {
    out.set(t.from, [...(out.get(t.from) ?? []), t.to]);
    hasIn.add(t.to);
    connected.add(t.from);
    connected.add(t.to);
  }
  const layer = new Map<string, number>();
  const walk = (starts: string[]) => {
    const queue = [...starts];
    for (const s of starts) layer.set(s, 0);
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const next of out.get(id) ?? []) {
        if (layer.has(next)) continue;
        layer.set(next, layer.get(id)! + 1);
        queue.push(next);
      }
    }
  };
  walk(ids.filter((id) => connected.has(id) && !hasIn.has(id)));
  // 輪だけの画面。入口の画面を先にする
  const entries = new Set(entryIds);
  for (const id of [...ids.filter((i) => entries.has(i)), ...ids]) {
    if (connected.has(id) && !layer.has(id)) {
      const queue = [id];
      layer.set(id, 0);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const next of out.get(cur) ?? []) {
          if (layer.has(next)) continue;
          layer.set(next, layer.get(cur)! + 1);
          queue.push(next);
        }
      }
    }
  }
  const last = Math.max(-1, ...layer.values()) + 1;
  for (const id of ids) if (!layer.has(id)) layer.set(id, last);
  return layer;
}

/** 層ごとに縦に並べた位置 (層 × 設計の画面の並び順) */
export function sitemapPositions(design: Pick<SystemDesign, "screens" | "transitions">, entryIds: readonly string[] = []): Map<string, { x: number; y: number }> {
  const layers = sitemapLayers(design, entryIds);
  const count = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const s of design.screens) {
    const l = layers.get(s.id) ?? 0;
    const row = count.get(l) ?? 0;
    count.set(l, row + 1);
    pos.set(s.id, { x: l * (SITEMAP_NODE_WIDTH + GAP_X), y: row * (SITEMAP_NODE_HEIGHT + GAP_Y) });
  }
  return pos;
}

export function buildSitemapFlow(
  model: UntieModel,
  design: SystemDesign,
  notes: ReadonlyMap<string, string[]>,
  selectedId: string | undefined,
  selectedTransitionId: string | undefined,
): { nodes: SitemapFlowNode[]; edges: Edge[] } {
  const positions = sitemapPositions(design, [...notes.keys()]);
  const nodes: SitemapFlowNode[] = design.screens.map((s) => ({
    id: s.id,
    type: "screen",
    position: positions.get(s.id) ?? { x: 0, y: 0 },
    width: SITEMAP_NODE_WIDTH,
    height: SITEMAP_NODE_HEIGHT,
    draggable: false,
    selected: s.id === selectedId,
    data: {
      designScreenId: s.id,
      name: designScreenName(model, s),
      entry: notes.has(s.id),
      note: (notes.get(s.id) ?? []).join(" / "),
      builtin: s.source.kind === "builtin",
      selected: s.id === selectedId,
    },
  }));
  const edges: Edge[] = design.transitions.map((t) => {
    const highlighted = t.id === selectedTransitionId;
    const via = t.via ? TRANSITION_VIA_LABELS[t.via] : "未定";
    return {
      id: t.id,
      source: t.from,
      target: t.to,
      label: t.label ? `${via}: ${t.label}` : via,
      markerEnd: { type: MarkerType.ArrowClosed },
      className: t.via ? "" : "is-undecided",
      style: { strokeDasharray: t.via ? undefined : "5 4", strokeWidth: highlighted ? 3 : 1.5 },
      data: { transitionId: t.id },
    };
  });
  return { nodes, edges };
}
