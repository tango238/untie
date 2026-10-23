// React Flow のノード変更 (NodeChange) をモデルへ反映する純粋関数。
import type { NodeChange } from "@xyflow/react";
import { moveNode, type CommandResult } from "../../model/commands";
import type { UntieModel } from "../../model/types";
import { moveFrameWithDescendants, nodeRect } from "./drop";
import { parentFrameElementId, toModelPosition, type Point } from "./toFlow";

/** 変更の position (親からの相対座標) をモデルの絶対座標にする。親の座標は現在のモデルから引く */
function absolutePosition(model: UntieModel, boardId: string, id: string, relative: Point): Point {
  const parentId = parentFrameElementId(model, boardId, id);
  const parent = parentId ? nodeRect(model, boardId, parentId) : null;
  return toModelPosition(relative, parent ? { x: parent.x, y: parent.y } : null);
}

/**
 * 移動・リサイズの変更をモデルに反映する。
 *
 * - NodeResizer は、左端・上端を引くと 1 回の変更に「枠の position」「枠の dimensions (setAttributes)」
 *   「直下の子の position (親の移動を打ち消す相対補正)」を一緒に入れてくる。
 *   同じ id に dimensions (setAttributes) があれば枠のリサイズとして扱い、枠だけを更新して子孫は動かさない。
 *   子の position は新しい親座標で絶対座標にすると元の位置のままなので、読み飛ばされる。
 * - それ以外の position は移動。枠なら子孫も同じ量だけ動かす。
 * - 選択・測定などモデルに関係ない変更は無視する。
 */
export function applyFlowChanges(model: UntieModel, boardId: string, changes: readonly NodeChange[]): CommandResult {
  let current = model;

  const resizes = new Map<string, { width: number; height: number }>();
  for (const ch of changes) {
    if (ch.type === "dimensions" && ch.setAttributes && ch.dimensions) {
      resizes.set(ch.id, { width: ch.dimensions.width, height: ch.dimensions.height });
    }
  }

  // 1. リサイズ (位置の変更が同じ変更の中にあれば、その位置も使う)
  for (const [id, size] of resizes) {
    const rect = nodeRect(current, boardId, id);
    if (!rect) continue;
    const posChange = changes.find((c) => c.type === "position" && c.id === id && c.position);
    const position =
      posChange && posChange.type === "position" && posChange.position
        ? absolutePosition(current, boardId, id, posChange.position)
        : { x: rect.x, y: rect.y };
    const res = moveNode(current, { boardId, elementId: id, position, size });
    if (res.ok) current = res.model;
  }

  // 2. 移動 (リサイズ中のノードの position は 1 で処理済み)
  for (const ch of changes) {
    if (ch.type !== "position" || !ch.position || resizes.has(ch.id)) continue;
    const rect = nodeRect(current, boardId, ch.id);
    if (!rect) continue;
    // 親がリサイズ中なら、この position は親の移動を打ち消す相対補正なので読み飛ばす
    const parentId = parentFrameElementId(current, boardId, ch.id);
    if (parentId && resizes.has(parentId)) continue;
    const abs = absolutePosition(current, boardId, ch.id, ch.position);
    if (abs.x === rect.x && abs.y === rect.y) continue;
    const el = current.elements.find((e) => e.id === ch.id);
    const res =
      el && (el.kind === "business" || el.kind === "buc")
        ? moveFrameWithDescendants(current, boardId, ch.id, abs)
        : moveNode(current, { boardId, elementId: ch.id, position: abs });
    if (res.ok) current = res.model;
  }

  return { ok: true, model: current };
}
