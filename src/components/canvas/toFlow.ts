// モデル (ボード内の絶対座標) と React Flow のノード・エッジの変換。純粋関数だけを置く。
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { DEFAULT_FRAME_SIZE } from "../../model/commands";
import { isUndirected, relationLabel } from "../../model/relations";
import { issueSummaries } from "../../model/selectors";
import {
  isFrameKind,
  type Element,
  type ElementKind,
  type FrameKind,
  type UntieModel,
} from "../../model/types";

/** カードの表示サイズ (CSS と合わせる)。枠の当たり判定にも使う */
export const CARD_SIZE = { width: 168, height: 64 };

export type CardNodeData = {
  elementId: string;
  kind: ElementKind;
  name: string;
  /** 所属の枠が無いときに出す所属ラベル (業務名、「業務名 / BUC 名」) */
  label?: string;
  issueCount: number;
  maxSeverity: number;
};

export type FrameNodeData = {
  elementId: string;
  kind: FrameKind;
  name: string;
  /** BUC の小枠が業務の枠の外にあるときの業務名 */
  label?: string;
  issueCount: number;
  maxSeverity: number;
};

export type CardFlowNode = Node<CardNodeData, "card">;
export type FrameFlowNode = Node<FrameNodeData, "frame">;
export type FlowNode = CardFlowNode | FrameFlowNode;
export type FlowEdge = Edge<{ kind: string; relationId: string }>;

export interface BuildNodesOptions {
  selectedElementId?: string | null;
}

export interface Point {
  x: number;
  y: number;
}

/** 親の絶対座標を足して、相対座標 (React Flow) をモデルの絶対座標に戻す */
export function toModelPosition(relative: Point, parentAbsolute: Point | null): Point {
  return parentAbsolute ? { x: relative.x + parentAbsolute.x, y: relative.y + parentAbsolute.y } : { ...relative };
}

/** 絶対座標を親からの相対座標にする */
export function toRelativePosition(absolute: Point, parentAbsolute: Point | null): Point {
  return parentAbsolute ? { x: absolute.x - parentAbsolute.x, y: absolute.y - parentAbsolute.y } : { ...absolute };
}

function elementMap(model: UntieModel): Map<string, Element> {
  return new Map(model.elements.map((e) => [e.id, e]));
}

/**
 * ボード上で、その要素の親になる枠の要素 id。
 * アクティビティ: 所属 BUC の小枠 → なければ業務の枠 (同じボードにあるもの)。
 * BUC: 業務の枠。どちらも無ければ null。
 */
export function parentFrameElementId(model: UntieModel, boardId: string, elementId: string): string | null {
  const board = model.boards.find((b) => b.id === boardId);
  if (!board) return null;
  const onBoard = new Set(board.nodes.map((n) => n.elementId));
  const byId = elementMap(model);
  const el = byId.get(elementId);
  if (!el) return null;
  if (el.kind === "buc") {
    return !el.isDefault && onBoard.has(el.businessId) ? el.businessId : null;
  }
  if (el.kind === "activity" && el.bucId) {
    const buc = byId.get(el.bucId);
    if (!buc || buc.kind !== "buc") return null;
    if (!buc.isDefault && onBoard.has(buc.id)) return buc.id;
    return onBoard.has(buc.businessId) ? buc.businessId : null;
  }
  return null;
}

/** 枠の下に (孫も含めて) ぶら下がるボード上の要素 id */
export function descendantElementIds(model: UntieModel, boardId: string, frameId: string): string[] {
  const board = model.boards.find((b) => b.id === boardId);
  if (!board) return [];
  const result: string[] = [];
  for (const n of board.nodes) {
    let cur: string | null = parentFrameElementId(model, boardId, n.elementId);
    let guard = 0;
    while (cur && guard++ < 4) {
      if (cur === frameId) {
        result.push(n.elementId);
        break;
      }
      cur = parentFrameElementId(model, boardId, cur);
    }
  }
  return result;
}

/** 親の枠が無いときの所属ラベル */
function ownerLabel(model: UntieModel, el: Element): string | undefined {
  const byId = elementMap(model);
  if (el.kind === "activity") {
    if (!el.bucId) return "未所属";
    const buc = byId.get(el.bucId);
    if (!buc || buc.kind !== "buc") return undefined;
    const biz = byId.get(buc.businessId);
    const bizName = biz ? biz.name : "";
    return buc.isDefault ? bizName : `${bizName} / ${buc.name}`;
  }
  if (el.kind === "buc") {
    const biz = byId.get(el.businessId);
    return biz ? biz.name : undefined;
  }
  return undefined;
}

const FRAME_ORDER: Record<string, number> = { business: 0, buc: 1 };

/** ボードのノードを React Flow のノードにする。親の枠が先に来る順に並べる */
export function buildFlowNodes(model: UntieModel, boardId: string, options: BuildNodesOptions = {}): FlowNode[] {
  const board = model.boards.find((b) => b.id === boardId);
  if (!board) return [];
  const byId = elementMap(model);
  const summaries = issueSummaries(model);
  const abs = new Map(board.nodes.map((n) => [n.elementId, n]));

  const nodes: FlowNode[] = [];
  for (const bn of board.nodes) {
    const el = byId.get(bn.elementId);
    if (!el || el.kind === "issue" || (el.kind === "buc" && el.isDefault)) continue;

    const parentId = parentFrameElementId(model, boardId, el.id);
    const parentNode = parentId ? abs.get(parentId) : undefined;
    const position = toRelativePosition({ x: bn.x, y: bn.y }, parentNode ? { x: parentNode.x, y: parentNode.y } : null);
    const summary = summaries.get(el.id);
    const selected = options.selectedElementId === el.id;

    const parentProps = parentId ? { parentId } : {};
    if (isFrameKind(el.kind)) {
      const size = DEFAULT_FRAME_SIZE[el.kind];
      const label = el.kind === "buc" && !parentId ? ownerLabel(model, el) : undefined;
      nodes.push({
        id: el.id,
        type: "frame",
        position,
        width: bn.width ?? size.width,
        height: bn.height ?? size.height,
        selected,
        dragHandle: ".frame-title",
        zIndex: FRAME_ORDER[el.kind],
        ...parentProps,
        data: {
          elementId: el.id,
          kind: el.kind,
          name: el.name,
          ...(label ? { label } : {}),
          issueCount: summary?.count ?? 0,
          maxSeverity: summary?.maxSeverity ?? 0,
        },
      });
    } else {
      // 親が BUC の小枠なら所属は明らか。業務の枠が親で BUC の枠が無いときは BUC 名を添える
      let label: string | undefined;
      if (!parentId) label = ownerLabel(model, el);
      else if (el.kind === "activity" && parentId && byId.get(parentId)?.kind === "business" && el.bucId) {
        const buc = byId.get(el.bucId);
        if (buc && buc.kind === "buc" && !buc.isDefault) label = buc.name;
      }
      nodes.push({
        id: el.id,
        type: "card",
        position,
        selected,
        zIndex: 2,
        ...parentProps,
        data: {
          elementId: el.id,
          kind: el.kind,
          name: el.name,
          ...(label ? { label } : {}),
          issueCount: summary?.count ?? 0,
          maxSeverity: summary?.maxSeverity ?? 0,
        },
      });
    }
  }

  // 業務の枠 → BUC の小枠 → カードの順 (安定ソート)。親が必ず子より前に来る
  const rank = (n: FlowNode) => (n.type === "frame" ? FRAME_ORDER[n.data.kind] : 2);
  return nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i)
    .map((x) => x.n);
}

export interface BuildEdgesOptions {
  selectedRelationId?: string | null;
}

/** 両端がボードにある関係だけを React Flow のエッジにする */
export function buildFlowEdges(model: UntieModel, boardId: string, options: BuildEdgesOptions = {}): FlowEdge[] {
  const board = model.boards.find((b) => b.id === boardId);
  if (!board) return [];
  const onBoard = new Set(board.nodes.map((n) => n.elementId));
  const byId = elementMap(model);
  return model.relations
    .filter((r) => onBoard.has(r.sourceId) && onBoard.has(r.targetId))
    .filter((r) => {
      // ボードに出ない要素 (課題・既定 BUC) に向かう線は描かない
      const s = byId.get(r.sourceId);
      const t = byId.get(r.targetId);
      return !!s && !!t && s.kind !== "issue" && t.kind !== "issue";
    })
    .map((r) => ({
      id: r.id,
      source: r.sourceId,
      target: r.targetId,
      label: relationLabel(r.kind),
      selected: options.selectedRelationId === r.id,
      ...(isUndirected(r.kind) ? {} : { markerEnd: { type: MarkerType.ArrowClosed } }),
      data: { kind: r.kind, relationId: r.id },
    }));
}
