// 複数のコンポーネントから使う、ストアとキャンバスをまたぐ操作。
import { DEFAULT_FRAME_SIZE, placeOnBoard, type CommandResult } from "../model/commands";
import { fixedBoardId, fixedLayerOf, type FixedLayer } from "../model/fixedBoards";
import { isFrameKind, type UntieModel } from "../model/types";
import { isBuiltinBoard, useUntieStore } from "../store";
import { viewCenter, canvasApi } from "./canvas/canvasApi";
import { CARD_SIZE } from "./canvas/toFlow";

/**
 * 既存の要素を現在の自由ボードの指定位置に置く。
 * 自由ボードでは所属・関係を変えないので、枠の上に置いても所属は変わらない。
 */
export function placeElement(elementId: string, position: { x: number; y: number }): CommandResult {
  const st = useUntieStore.getState();
  const boardId = st.ui.currentBoardId;
  return st.dispatch((m) => placeOnBoard(m, { boardId, elementId, position }));
}

/** 既存の要素を現在のボードの見えている範囲の中央に置く */
export function placeElementAtCenter(elementId: string): void {
  const st = useUntieStore.getState();
  const el = st.model.elements.find((e) => e.id === elementId);
  if (!el) return;
  const c = viewCenter();
  const size = isFrameKind(el.kind) ? DEFAULT_FRAME_SIZE[el.kind] : CARD_SIZE;
  const position = { x: c.x - size.width / 2, y: c.y - size.height / 2 };
  const result = placeElement(elementId, position);
  if (!result.ok) {
    st.pushToast(result.reason, "info");
    return;
  }
  st.select({ type: "element", id: elementId });
  // 描画後にスクロール
  setTimeout(() => canvasApi.focus?.(elementId), 50);
}

/** 要素を選択し、現在のボードにあればそこへスクロールする */
export function selectAndReveal(elementId: string, options: { showProperties?: boolean } = {}): void {
  const st = useUntieStore.getState();
  st.select({ type: "element", id: elementId });
  if (options.showProperties) st.setRightPanel("properties");
  const boardId = st.ui.currentBoardId;
  const onBoard =
    isBuiltinBoard(boardId) || st.model.boards.find((b) => b.id === boardId)?.nodes.some((n) => n.elementId === elementId);
  if (onBoard) canvasApi.focus?.(elementId);
}

/** 要素を編集できる固定ボードへ移り、選択してプロパティ欄に出す */
export function revealOnFixedBoard(elementId: string): void {
  const st = useUntieStore.getState();
  const el = st.model.elements.find((e) => e.id === elementId);
  const layer = el ? fixedLayerOf(el.kind) : null;
  if (!el || !layer) return;
  st.setCurrentBoard(fixedBoardId(layer));
  st.select({ type: "element", id: elementId });
  st.setRightPanel("properties");
  // 描画後にスクロール
  setTimeout(() => canvasApi.focus?.(elementId), 50);
}

/** 隣のボードでスクロールする先の候補: 要素自身、所属先、関係で結ばれた要素の順 */
function relatedIds(model: UntieModel, elementId: string): string[] {
  const el = model.elements.find((e) => e.id === elementId);
  if (!el) return [];
  const ids = [el.id];
  if (el.kind === "buc") ids.push(el.businessId);
  if (el.kind === "activity" && el.bucId) {
    ids.push(el.bucId);
    const buc = model.elements.find((e) => e.id === el.bucId);
    if (buc && buc.kind === "buc") ids.push(buc.businessId);
  }
  if ("contextId" in el && el.contextId) ids.push(el.contextId);
  for (const r of model.relations) {
    if (r.sourceId === el.id) ids.push(r.targetId);
    if (r.targetId === el.id) ids.push(r.sourceId);
  }
  return [...new Set(ids)];
}

/**
 * 要素を選んだまま、指定した固定ボードへ移る。移った先では、その要素 (無ければ所属先や関係で結ばれた要素) の
 * カードか枠までスクロールする
 */
export function goToLayer(layer: FixedLayer, elementId: string): void {
  const st = useUntieStore.getState();
  st.setCurrentBoard(fixedBoardId(layer));
  st.select({ type: "element", id: elementId });
  st.setRightPanel("properties");
  const ids = relatedIds(st.model, elementId);
  // 描画後にスクロール
  setTimeout(() => {
    for (const id of ids) {
      const target =
        document.querySelector(`[data-fixed-card="${CSS.escape(id)}"]`) ??
        document.querySelector(`[data-fixed-group="${CSS.escape(id)}"]`);
      if (target) {
        target.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
    }
  }, 50);
}
