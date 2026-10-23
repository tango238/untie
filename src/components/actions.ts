// 複数のコンポーネントから使う、ストアとキャンバスをまたぐ操作。
import { addElement, DEFAULT_FRAME_SIZE, placeOnBoard, type CommandResult } from "../model/commands";
import { ELEMENT_KIND_LABELS, isFrameKind, type ElementKind } from "../model/types";
import { useUntieStore } from "../store";
import { viewCenter, canvasApi } from "./canvas/canvasApi";
import { applyDropDecision, bucIdAt, decidePlacement, frameAt } from "./canvas/drop";
import { CARD_SIZE } from "./canvas/toFlow";

/** 見えている範囲の中央に新しい要素を作る (課題はボードに置かない)。選択して名前欄にフォーカスする */
export function addElementAtCenter(kind: ElementKind): string | null {
  const st = useUntieStore.getState();
  const { model } = st;
  const boardId = st.ui.currentBoardId;
  const center = viewCenter();
  const name = `新しい${ELEMENT_KIND_LABELS[kind]}`;

  let result;
  if (kind === "issue") {
    result = st.dispatch((m) => addElement(m, { kind, name }));
  } else {
    const size = isFrameKind(kind) ? DEFAULT_FRAME_SIZE[kind] : CARD_SIZE;
    const position = { x: center.x - size.width / 2, y: center.y - size.height / 2 };
    let init: Parameters<typeof addElement>[1]["init"];
    if (kind === "buc") {
      const board = model.boards.find((b) => b.id === boardId);
      const businessOnBoard = board?.nodes.find((n) => model.elements.find((e) => e.id === n.elementId)?.kind === "business");
      const businessId =
        frameAt(model, boardId, center, { kinds: ["business"] })?.id ??
        businessOnBoard?.elementId ??
        model.elements.find((e) => e.kind === "business")?.id;
      if (!businessId) {
        st.pushToast("BUC を作るには、先に業務を作ってください", "error");
        return null;
      }
      init = { businessId };
    } else if (kind === "activity") {
      init = { bucId: bucIdAt(model, boardId, center) };
    }
    result = st.dispatch((m) => addElement(m, { kind, name, boardId, position, ...(init ? { init } : {}) }));
  }

  if (!result.ok) {
    st.pushToast(result.reason, "error");
    return null;
  }
  st.select({ type: "element", id: result.id });
  st.setRightPanel("properties");
  st.requestNameFocus();
  return result.id;
}

/**
 * 既存の要素を現在のボードの指定位置に置く。枠の上に置いたときは所属 (BUC・業務) も合わせ、
 * 配置と所属変更を 1 件の履歴にする。枠の外に置いたときは所属を変えない。
 */
export function placeElement(elementId: string, position: { x: number; y: number }): CommandResult {
  const st = useUntieStore.getState();
  const boardId = st.ui.currentBoardId;
  return st.dispatch((m) => {
    const placed = placeOnBoard(m, { boardId, elementId, position });
    if (!placed.ok) return placed;
    const followUp = applyDropDecision(placed.model, boardId, decidePlacement(placed.model, boardId, elementId));
    return followUp.ok ? followUp : placed;
  });
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
  const onBoard = st.model.boards
    .find((b) => b.id === st.ui.currentBoardId)
    ?.nodes.some((n) => n.elementId === elementId);
  if (onBoard) canvasApi.focus?.(elementId);
}
