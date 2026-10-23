import { useEffect, useRef, useState } from "react";
import { addBoard, clearAll, removeBoard, renameBoard } from "../model/commands";
import { ELEMENT_KINDS, ELEMENT_KIND_LABELS } from "../model/types";
import { useUntieStore } from "../store";
import { addElementAtCenter } from "./actions";
import { ConfirmDialog } from "./ConfirmDialog";

type Dialog = "removeBoard" | "clearAll" | null;

/** 既存のボード名と被らない「ボード N」 */
export function nextBoardName(existing: readonly string[]): string {
  const names = new Set(existing);
  let n = existing.length + 1;
  while (names.has(`ボード ${n}`)) n++;
  return `ボード ${n}`;
}

export function Toolbar() {
  const boards = useUntieStore((s) => s.model.boards);
  const currentBoardId = useUntieStore((s) => s.ui.currentBoardId);
  const rightPanel = useUntieStore((s) => s.ui.rightPanel);
  const canUndo = useUntieStore((s) => s.history.past.length > 0);
  const canRedo = useUntieStore((s) => s.history.future.length > 0);
  const setCurrentBoard = useUntieStore((s) => s.setCurrentBoard);
  const dispatch = useUntieStore((s) => s.dispatch);
  const undo = useUntieStore((s) => s.undo);
  const redo = useUntieStore((s) => s.redo);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const pushToast = useUntieStore((s) => s.pushToast);

  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const board = boards.find((b) => b.id === currentBoardId);

  // メニューの外をクリックしたら閉じる
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const handleAddBoard = () => {
    const result = dispatch((m) => addBoard(m, { name: nextBoardName(m.boards.map((b) => b.name)) }));
    if (result.ok) setCurrentBoard(result.id);
  };

  const commitRename = () => {
    if (renaming === null || !board) return;
    const name = renaming.trim();
    setRenaming(null);
    if (!name) {
      pushToast("ボード名を入力してください", "error");
      return;
    }
    dispatch((m) => renameBoard(m, { id: board.id, name }));
  };

  return (
    <header className="toolbar">
      <div className="toolbar-row">
        <h1 className="app-name">Untie</h1>

        <div className="toolbar-group">
          {renaming === null ? (
            <>
              <label className="toolbar-label">
                ボード
                <select
                  aria-label="ボード"
                  value={currentBoardId}
                  onChange={(e) => {
                    setCurrentBoard(e.target.value);
                    // フォーカスが残ると Cmd+Z や Delete がキャンバスに効かないため外す
                    e.target.blur();
                  }}
                >
                  {boards.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={handleAddBoard}>
                ＋ボード
              </button>
              <button type="button" onClick={() => setRenaming(board?.name ?? "")}>
                名前変更
              </button>
              <button type="button" disabled={boards.length <= 1} onClick={() => setDialog("removeBoard")}>
                ボード削除
              </button>
            </>
          ) : (
            <form
              className="rename-form"
              onSubmit={(e) => {
                e.preventDefault();
                commitRename();
              }}
            >
              <input
                aria-label="ボード名"
                value={renaming}
                autoFocus
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
              <button type="submit" className="primary">
                決定
              </button>
              <button type="button" onClick={() => setRenaming(null)}>
                キャンセル
              </button>
            </form>
          )}
        </div>

        <div className="toolbar-spacer" />

        <div className="toolbar-group">
          <div className="menu-wrap" ref={menuRef}>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              ＋追加 ▾
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                {ELEMENT_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    className={`menu-item kind-${kind}`}
                    onClick={() => {
                      setMenuOpen(false);
                      addElementAtCenter(kind);
                    }}
                  >
                    <span className="kind-dot" />
                    {ELEMENT_KIND_LABELS[kind]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" aria-label="元に戻す" title="元に戻す (Cmd/Ctrl+Z)" disabled={!canUndo} onClick={undo}>
            ↶
          </button>
          <button type="button" aria-label="やり直す" title="やり直す (Shift+Cmd/Ctrl+Z)" disabled={!canRedo} onClick={redo}>
            ↷
          </button>
          <button
            type="button"
            aria-pressed={rightPanel === "issues"}
            className={rightPanel === "issues" ? "active" : ""}
            onClick={() => setRightPanel(rightPanel === "issues" ? "properties" : "issues")}
          >
            課題一覧
          </button>
          <button type="button" className="danger-outline" onClick={() => setDialog("clearAll")}>
            空にする
          </button>
        </div>
      </div>

      <div className="notice" role="note">
        ⚠ このアプリは保存しません。起動時にサンプルが読み込まれ、終了すると消えます。
      </div>

      {dialog === "removeBoard" && board && (
        <ConfirmDialog
          title="ボードを削除"
          message={`ボード「${board.name}」を削除します。要素や線は残り、他のボードにも影響しません。`}
          confirmLabel="削除する"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            const result = dispatch((m) => removeBoard(m, { id: board.id }));
            if (!result.ok) pushToast(result.reason, "error");
          }}
        />
      )}
      {dialog === "clearAll" && (
        <ConfirmDialog
          title="すべて空にする"
          message="要素・線・ボードをすべて消して、空のボード「ボード 1」だけにします。元に戻す (Undo) で復元できます。"
          confirmLabel="空にする"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            dispatch((m) => clearAll(m));
          }}
        />
      )}
    </header>
  );
}
