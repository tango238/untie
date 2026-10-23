import { useEffect } from "react";
import { removeFromBoard, removeRelation } from "../model/commands";
import { useUntieStore } from "../store";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/** Cmd/Ctrl+Z (Undo)、Shift+Cmd/Ctrl+Z (Redo)、Delete/Backspace (ボードから外す・線を消す) */
export function handleKeyDown(e: KeyboardEvent) {
  // 入力欄・ダイアログの中では扱わない
  if (isEditable(e.target)) return;
  if (e.target instanceof HTMLElement && e.target.closest('[role="dialog"]')) return;
  const st = useUntieStore.getState();

  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) st.redo();
    else st.undo();
    return;
  }
  if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "y") {
    e.preventDefault();
    st.redo();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    // 一覧やボタンにフォーカスがあるときの誤操作を避け、キャンバス上かフォーカスなしのときだけ扱う
    const t = e.target;
    const inCanvas = t === document.body || (t instanceof HTMLElement && t.closest(".react-flow") !== null);
    if (!inCanvas) return;
    const sel = st.ui.selection;
    if (!sel) return;
    if (sel.type === "relation") {
      e.preventDefault();
      st.dispatch((m) => removeRelation(m, { id: sel.id }));
    } else {
      const onBoard = st.model.boards
        .find((b) => b.id === st.ui.currentBoardId)
        ?.nodes.some((n) => n.elementId === sel.id);
      if (!onBoard) return;
      e.preventDefault();
      st.dispatch((m) => removeFromBoard(m, { boardId: st.ui.currentBoardId, elementId: sel.id }));
    }
  }
}

export function useKeyboard() {
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
