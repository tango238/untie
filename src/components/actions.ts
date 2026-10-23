// 複数のコンポーネントから使う、ストアとキャンバスをまたぐ操作。
import { DEFAULT_FRAME_SIZE, placeOnBoard, type CommandResult } from "../model/commands";
import { fixedBoardId, fixedLayerOf } from "../model/fixedBoards";
import { isFrameKind } from "../model/types";
import { isFixedBoard, useUntieStore } from "../store";
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
    isFixedBoard(boardId) || st.model.boards.find((b) => b.id === boardId)?.nodes.some((n) => n.elementId === elementId);
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
