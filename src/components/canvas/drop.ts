// ドラッグ終了時の「どの枠に入ったか」の判定。純粋関数。
import { DEFAULT_FRAME_SIZE, moveNode, type CommandResult } from "../../model/commands";
import { defaultBucOf } from "../../model/selectors";
import { isFrameKind, type UntieModel } from "../../model/types";
import { CARD_SIZE, descendantElementIds, parentFrameElementId, type Point } from "./toFlow";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ボード上のノードの矩形 (モデルの絶対座標)。カードは既定サイズ */
export function nodeRect(model: UntieModel, boardId: string, elementId: string): Rect | null {
  const board = model.boards.find((b) => b.id === boardId);
  const bn = board?.nodes.find((n) => n.elementId === elementId);
  const el = model.elements.find((e) => e.id === elementId);
  if (!bn || !el) return null;
  const size = isFrameKind(el.kind) ? DEFAULT_FRAME_SIZE[el.kind] : CARD_SIZE;
  return { x: bn.x, y: bn.y, width: bn.width ?? size.width, height: bn.height ?? size.height };
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

export interface FrameHit {
  id: string;
  kind: "business" | "buc";
}

/**
 * 点を含む枠を返す。BUC の小枠を優先し (小さい順)、なければ業務の枠。
 * kinds で対象を絞れる (BUC の判定では業務の枠だけを見る)。
 */
export function frameAt(
  model: UntieModel,
  boardId: string,
  point: Point,
  options: { kinds?: readonly ("business" | "buc")[]; excludeId?: string } = {},
): FrameHit | null {
  const board = model.boards.find((b) => b.id === boardId);
  if (!board) return null;
  const kinds = options.kinds ?? ["buc", "business"];
  const hits: { hit: FrameHit; area: number }[] = [];
  for (const bn of board.nodes) {
    if (bn.elementId === options.excludeId) continue;
    const el = model.elements.find((e) => e.id === bn.elementId);
    if (!el || (el.kind !== "business" && el.kind !== "buc")) continue;
    if (!kinds.includes(el.kind)) continue;
    const rect = nodeRect(model, boardId, el.id)!;
    if (contains(rect, point)) hits.push({ hit: { id: el.id, kind: el.kind }, area: rect.width * rect.height });
  }
  // BUC を先に、同じ種類なら面積の小さい方
  hits.sort((a, b) => (a.hit.kind === b.hit.kind ? a.area - b.area : a.hit.kind === "buc" ? -1 : 1));
  return hits[0]?.hit ?? null;
}

export type DropDecision =
  | { type: "none" }
  | { type: "moveActivity"; activityId: string; bucId: string | null }
  | { type: "moveBuc"; bucId: string; businessId: string }
  /** BUC の小枠が業務の枠の外に出たので、元の業務の枠の中へ戻す */
  | { type: "clamp"; elementId: string; position: Point };

/** 枠に入っている位置から、その点の所属先 BUC の id (枠が無ければ null) を決める */
export function bucIdAt(model: UntieModel, boardId: string, point: Point): string | null {
  const hit = frameAt(model, boardId, point);
  if (!hit) return null;
  if (hit.kind === "buc") return hit.id;
  return defaultBucOf(model, hit.id)?.id ?? null;
}

/** ドラッグ終了時の所属変更を判定する (設計書 4.1) */
export function decideDrop(model: UntieModel, boardId: string, elementId: string): DropDecision {
  const el = model.elements.find((e) => e.id === elementId);
  const rect = nodeRect(model, boardId, elementId);
  if (!el || !rect) return { type: "none" };
  const center = rectCenter(rect);

  if (el.kind === "activity") {
    const hit = frameAt(model, boardId, center);
    const currentParent = parentFrameElementId(model, boardId, el.id);
    // 見た目の親が変わらないなら所属は触らない (BUC の枠が無いボードでの誤変更を避ける)
    if ((hit?.id ?? null) === currentParent) return { type: "none" };
    const bucId = bucIdAt(model, boardId, center);
    if (bucId === el.bucId) return { type: "none" };
    return { type: "moveActivity", activityId: el.id, bucId };
  }

  if (el.kind === "buc" && !el.isDefault) {
    const hit = frameAt(model, boardId, center, { kinds: ["business"] });
    if (hit) {
      return hit.id === el.businessId ? { type: "none" } : { type: "moveBuc", bucId: el.id, businessId: hit.id };
    }
    // 業務の枠の外: 元の業務の枠がこのボードにあれば中へ戻す
    const own = nodeRect(model, boardId, el.businessId);
    if (!own) return { type: "none" };
    const x = Math.min(Math.max(rect.x, own.x), own.x + Math.max(0, own.width - rect.width));
    const y = Math.min(Math.max(rect.y, own.y), own.y + Math.max(0, own.height - rect.height));
    return { type: "clamp", elementId: el.id, position: { x, y } };
  }

  return { type: "none" };
}

/** 枠を動かすとき、ぶら下がる要素も同じ量だけ動かす (モデルの座標は絶対座標のため) */
export function moveFrameWithDescendants(
  model: UntieModel,
  boardId: string,
  frameId: string,
  position: Point,
): CommandResult {
  const rect = nodeRect(model, boardId, frameId);
  if (!rect) return { ok: false, reason: "この要素はこのボードにありません" };
  const dx = position.x - rect.x;
  const dy = position.y - rect.y;
  let current = model;
  const children = descendantElementIds(model, boardId, frameId);
  for (const id of [frameId, ...children]) {
    const r = nodeRect(current, boardId, id);
    if (!r) continue;
    const res = moveNode(current, { boardId, elementId: id, position: { x: r.x + dx, y: r.y + dy } });
    if (!res.ok) return res;
    current = res.model;
  }
  return { ok: true, model: current };
}
