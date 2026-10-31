// モデル (ボード内の絶対座標) と React Flow のノード・エッジの変換。純粋関数だけを置く。
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { DEFAULT_CARD_SIZE, DEFAULT_FRAME_SIZE } from "@untie/core/model/commands";
import { isShownAsLabel, isUndirected, relationLabel } from "@untie/core/model/relations";
import { issueSummaries } from "@untie/core/model/selectors";
import {
  DEFAULT_EDGE_SIDES,
  isFrameKind,
  type EdgeSide,
  type Element,
  type ElementKind,
  type FrameKind,
  type UntieModel,
} from "@untie/core/model/types";

/** カードの表示サイズ (CSS と合わせる)。枠の当たり判定にも使う */
export const CARD_SIZE = DEFAULT_CARD_SIZE;

/** 担当 (担い手) のラベル */
export type ActorLabel = { name: string; kind: "actor" | "externalActor" | "system" };

/** 情報の取得元・保存先 (システム・帳票) */
export type SystemLabel = { name: string; kind: "system" | "ledger"; role: "source" | "store" };

export type CardNodeData = {
  elementId: string;
  kind: ElementKind;
  name: string;
  /** 所属の枠が無いときに出す所属ラベル (業務名、「業務名 / BUC 名」) */
  label?: string;
  /** 担当アクター (線の代わりにラベルで出す) */
  actors?: ActorLabel[];
  issueCount: number;
  maxSeverity: number;
};

export type FrameNodeData = {
  elementId: string;
  kind: FrameKind;
  name: string;
  /** BUC の小枠が業務の枠の外にあるときの業務名 */
  label?: string;
  /** 主担当アクター (線の代わりにラベルで出す) */
  actors?: ActorLabel[];
  issueCount: number;
  maxSeverity: number;
};

export type CardFlowNode = Node<CardNodeData, "card">;
export type FrameFlowNode = Node<FrameNodeData, "frame">;
export type FlowNode = CardFlowNode | FrameFlowNode;
export type FlowEdge = Edge<{ kind: string; relationId: string }>;

/**
 * 線の z-index。ノードは枠が 0・1、カードが 2 (入れ子でも 2) なので、それより上に置いて、
 * 枠やカードの上を通る線もクリックで選べるようにする。React Flow は同じ z-index だとノードを後に描くため、
 * 線を上にするにはノードより大きい値が要る
 */
const EDGE_Z_INDEX = 10;

/** ノードの辺ごとのハンドル id。各辺に始点用 (source) と終点用 (target) を 1 つずつ置く */
export const sourceHandleId = (side: EdgeSide) => `source-${side}`;
export const targetHandleId = (side: EdgeSide) => `target-${side}`;

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

/** 要素 id → ラベルで出すアクター (関係の並び順)。ボードに置かれているかは問わない */
export function actorLabels(model: UntieModel): Map<string, ActorLabel[]> {
  const byId = elementMap(model);
  const result = new Map<string, ActorLabel[]>();
  for (const r of model.relations) {
    if (!isShownAsLabel(r.kind)) continue;
    const actor = byId.get(r.sourceId);
    if (!actor || (actor.kind !== "actor" && actor.kind !== "externalActor" && actor.kind !== "system")) continue;
    const list = result.get(r.targetId) ?? [];
    list.push({ name: actor.name || "(名前なし)", kind: actor.kind });
    result.set(r.targetId, list);
  }
  return result;
}

/** 情報 id → 取得元・保存先のシステム・帳票 (取得元 → 保存先、それぞれ関係の並び順) */
export function systemLabels(model: UntieModel): Map<string, SystemLabel[]> {
  const byId = elementMap(model);
  const result = new Map<string, SystemLabel[]>();
  for (const role of ["source", "store"] as const) {
    for (const r of model.relations) {
      const kind = role === "source" ? "systemInformation" : "informationSystem";
      if (r.kind !== kind) continue;
      const [sysId, infoId] = role === "source" ? [r.sourceId, r.targetId] : [r.targetId, r.sourceId];
      const sys = byId.get(sysId);
      if (!sys || (sys.kind !== "system" && sys.kind !== "ledger")) continue;
      const list = result.get(infoId) ?? [];
      list.push({ name: sys.name || "(名前なし)", kind: sys.kind, role });
      result.set(infoId, list);
    }
  }
  return result;
}

const FRAME_ORDER: Record<string, number> = { business: 0, buc: 1 };

/** ボードのノードを React Flow のノードにする。親の枠が先に来る順に並べる */
export function buildFlowNodes(model: UntieModel, boardId: string, options: BuildNodesOptions = {}): FlowNode[] {
  const board = model.boards.find((b) => b.id === boardId);
  if (!board) return [];
  const byId = elementMap(model);
  const summaries = issueSummaries(model);
  const actorsOf = actorLabels(model);
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
          ...(actorsOf.has(el.id) ? { actors: actorsOf.get(el.id) } : {}),
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
          ...(actorsOf.has(el.id) ? { actors: actorsOf.get(el.id) } : {}),
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

/** 両端がボードにある関係だけを React Flow のエッジにする。アクターの担当はラベルで出すので線にしない */
export function buildFlowEdges(model: UntieModel, boardId: string, options: BuildEdgesOptions = {}): FlowEdge[] {
  const board = model.boards.find((b) => b.id === boardId);
  if (!board) return [];
  const onBoard = new Set(board.nodes.map((n) => n.elementId));
  const byId = elementMap(model);
  const sides = new Map((board.edges ?? []).map((e) => [e.relationId, e]));
  return model.relations
    .filter((r) => !isShownAsLabel(r.kind) && onBoard.has(r.sourceId) && onBoard.has(r.targetId))
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
      // ボードごとに、どの辺から出てどの辺に入るかを変えられる
      sourceHandle: sourceHandleId(sides.get(r.id)?.sourceSide ?? DEFAULT_EDGE_SIDES.sourceSide),
      targetHandle: targetHandleId(sides.get(r.id)?.targetSide ?? DEFAULT_EDGE_SIDES.targetSide),
      label: relationLabel(r.kind),
      zIndex: EDGE_Z_INDEX,
      selected: options.selectedRelationId === r.id,
      ...(isUndirected(r.kind) ? {} : { markerEnd: { type: MarkerType.ArrowClosed } }),
      data: { kind: r.kind, relationId: r.id },
    }));
}
