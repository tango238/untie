import { useEffect, useMemo, useRef, useState } from "react";
import { addBoard, removeBoard, renameBoard } from "../model/commands";
import { FIXED_BOARD_MENU_ORDER, FIXED_LAYER_LABELS, fixedBoardId } from "../model/fixedBoards";
import { traceToActors } from "../model/trace";
import { newEmptyDocument, openDocument, saveDocument } from "../io/document";
import { ANALYSIS_KINDS, ANALYSIS_LABELS, analysisBoardId } from "../model/analysis";
import { hasUnsavedChanges, isBuiltinBoard, useUntieStore } from "../store";
import { useAgentStore } from "../ai/agentStore";
import { AiSettingsDialog } from "./ai/AiSettingsDialog";
import { CreateFromPromptDialog } from "./ai/CreateFromPromptDialog";
import { AboutDialog } from "./AboutDialog";
import { ConfirmDialog } from "./ConfirmDialog";

type Dialog = "removeBoard" | "newDocument" | "createFromPrompt" | "about" | null;

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
  const model = useUntieStore((s) => s.model);
  const traceCount = useMemo(() => traceToActors(model).problems.length, [model]);
  const file = useUntieStore((s) => s.file);
  const agentOpen = useAgentStore((s) => s.open);
  const setAgentOpen = useAgentStore((s) => s.setOpen);
  const aiSettingsOpen = useAgentStore((s) => s.settingsOpen);
  const modelName = useUntieStore((s) => s.model.meta.name);
  const dirty = useUntieStore(hasUnsavedChanges);
  const canUndo = useUntieStore((s) => s.history.past.length > 0);
  const canRedo = useUntieStore((s) => s.history.future.length > 0);
  const setCurrentBoard = useUntieStore((s) => s.setCurrentBoard);
  const dispatch = useUntieStore((s) => s.dispatch);
  const undo = useUntieStore((s) => s.undo);
  const redo = useUntieStore((s) => s.redo);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const pushToast = useUntieStore((s) => s.pushToast);

  const [renaming, setRenaming] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  // 固定ボードでは board は undefined (名前変更・削除はできない)
  const board = boards.find((b) => b.id === currentBoardId);
  // 固定ボード・分析ボードはアプリが組み立てるので、名前変更・削除はできない
  const fixed = isBuiltinBoard(currentBoardId);

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
        <h1 className="app-name">
          <button type="button" title="Untie について" onClick={() => setDialog("about")}>
            Untie
          </button>
        </h1>

        <div className="toolbar-group">
          <FileMenu
            onNew={() => (dirty ? setDialog("newDocument") : newEmptyDocument())}
            onCreateFromPrompt={() => setDialog("createFromPrompt")}
          />
        </div>

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
                  <optgroup label="固定ボード">
                    {FIXED_BOARD_MENU_ORDER.map((layer) => (
                      <option key={layer} value={fixedBoardId(layer)}>
                        {FIXED_LAYER_LABELS[layer]}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="分析ボード">
                    {ANALYSIS_KINDS.map((kind) => (
                      <option key={kind} value={analysisBoardId(kind)}>
                        {ANALYSIS_LABELS[kind]}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="自由ボード">
                    {boards.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              <button type="button" title="自由ボードを追加" onClick={handleAddBoard}>
                ＋ボード
              </button>
              <button type="button" disabled={fixed} onClick={() => setRenaming(board?.name ?? "")}>
                名前変更
              </button>
              <button type="button" disabled={fixed || boards.length <= 1} onClick={() => setDialog("removeBoard")}>
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
          <button type="button" aria-label="元に戻す" title="元に戻す (Cmd/Ctrl+Z)" disabled={!canUndo} onClick={undo}>
            ↶
          </button>
          <button type="button" aria-label="やり直す" title="やり直す (Shift+Cmd/Ctrl+Z)" disabled={!canRedo} onClick={redo}>
            ↷
          </button>
          <button
            type="button"
            aria-pressed={rightPanel === "trace"}
            className={rightPanel === "trace" ? "active" : ""}
            title="すべての要素が担い手 (アクター／外部アクター／システム) まで辿れるかを調べる"
            onClick={() => setRightPanel(rightPanel === "trace" ? "properties" : "trace")}
          >
            検証{traceCount > 0 && <span className="toolbar-count">{traceCount}</span>}
          </button>
          <button
            type="button"
            aria-pressed={rightPanel === "issues"}
            className={rightPanel === "issues" ? "active" : ""}
            onClick={() => setRightPanel(rightPanel === "issues" ? "properties" : "issues")}
          >
            課題一覧
          </button>
          <button
            type="button"
            aria-pressed={agentOpen}
            className={agentOpen ? "active" : ""}
            title="AI エージェントと会話して、モデルを直す"
            onClick={() => setAgentOpen(!agentOpen)}
          >
            AI
          </button>
        </div>
      </div>

      <div className={`notice${dirty ? " is-dirty" : ""}`} role="status" aria-label="ファイルの状態">
        {file ? `ファイル: ${file.name}` : `${modelName} (まだ保存していません)`}
        {dirty && <span className="notice-dirty">● 保存していない変更があります</span>}
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
      {dialog === "createFromPrompt" && <CreateFromPromptDialog onClose={() => setDialog(null)} />}
      {dialog === "about" && <AboutDialog onClose={() => setDialog(null)} />}
      {aiSettingsOpen && <AiSettingsDialog />}
      {dialog === "newDocument" && (
        <ConfirmDialog
          title="新規作成"
          message={`「${file?.name ?? modelName}」に保存していない変更があります。新しく作る前に保存しますか？`}
          confirmLabel="保存して新規作成"
          alternateLabel="保存せずに新規作成"
          onCancel={() => setDialog(null)}
          onAlternate={() => {
            setDialog(null);
            newEmptyDocument();
          }}
          onConfirm={async () => {
            setDialog(null);
            // 保存先の選択を取り消したり保存に失敗したりしたら、今のモデルを残す
            if (await saveDocument()) newEmptyDocument();
          }}
        />
      )}
    </header>
  );
}

/** ファイルのメニュー: 新規作成・開く・保存・別名で保存・プロンプトから作成 */
function FileMenu({ onNew, onCreateFromPrompt }: { onNew: () => void; onCreateFromPrompt: () => void }) {
  const [open, setOpen] = useState(false);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const item = (label: string, shortcut: string, action: () => void) => (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      onClick={() => {
        setOpen(false);
        action();
      }}
    >
      <span>{label}</span>
      <span className="menu-shortcut">{shortcut}</span>
    </button>
  );
  return (
    <div className="menu" ref={ref} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        ファイル ▾
      </button>
      {open && (
        <div className="menu-list" role="menu" aria-label="ファイル">
          {item("新規作成", "", onNew)}
          {item("開く…", "⌘O", () => void openDocument())}
          {item("保存", "⌘S", () => void saveDocument())}
          {item("別名で保存…", "⇧⌘S", () => void saveDocument(true))}
          <div className="menu-sep" role="separator" />
          {item("プロンプトから作成…", "", onCreateFromPrompt)}
          {item("AI の設定…", "", () => setSettingsOpen(true))}
        </div>
      )}
    </div>
  );
}
