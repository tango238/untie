// 自由ボードのノードの矩形と、枠の移動。純粋関数。
// 自由ボードでは所属・関係を変えないので、枠に入れたり出したりしても所属は変わらない。
import { DEFAULT_FRAME_SIZE, moveNode, type CommandResult } from "@untie/core/model/commands";
import { isFrameKind, type UntieModel } from "@untie/core/model/types";
import { CARD_SIZE, descendantElementIds, type Point } from "./toFlow";

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
