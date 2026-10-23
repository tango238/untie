import { useEffect } from "react";
import { removeFromBoard } from "../model/commands";
import { openDocument, saveDocument } from "../io/document";
import { isFixedBoard, useUntieStore } from "../store";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target instanceof HTMLElement && target.isContentEditable);
}

/** Cmd/Ctrl+S (保存)、Shift+Cmd/Ctrl+S (別名で保存)、Cmd/Ctrl+O (開く)、Cmd/Ctrl+Z (Undo)、Shift+Cmd/Ctrl+Z (Redo)、Delete/Backspace (自由ボードから外す) */
export function handleKeyDown(e: KeyboardEvent) {
  // 保存・開くは入力欄の中でも効かせる
  if ((e.metaKey || e.ctrlKey) && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      void saveDocument(e.shiftKey);
      return;
    }
    if (key === "o" && !e.shiftKey) {
      e.preventDefault();
      void openDocument();
      return;
    }
  }
  // 入力欄・ダイアログの中では扱わない
  if (isEditable(e.target)) return;
  if (e.target instanceof Element && e.target.closest('[role="dialog"]')) return;
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
    const inCanvas = t === document.body || (t instanceof Element && t.closest(".react-flow") !== null);
    if (!inCanvas) return;
    // 関係は自由ボードでは消せない。固定ボードには「ボードから外す」が無い
    const sel = st.ui.selection;
    if (!sel || sel.type !== "element" || isFixedBoard(st.ui.currentBoardId)) return;
    const onBoard = st.model.boards
      .find((b) => b.id === st.ui.currentBoardId)
      ?.nodes.some((n) => n.elementId === sel.id);
    if (!onBoard) return;
    e.preventDefault();
    st.dispatch((m) => removeFromBoard(m, { boardId: st.ui.currentBoardId, elementId: sel.id }));
  }
}

export function useKeyboard() {
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
