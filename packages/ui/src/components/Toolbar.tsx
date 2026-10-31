import { useEffect, useMemo, useRef, useState } from "react";
import { addBoard, removeBoard, renameBoard } from "@untie/core/model/commands";
import { FIXED_BOARD_MENU_ORDER, FIXED_LAYER_LABELS, fixedBoardId } from "@untie/core/model/fixedBoards";
import { traceToActors } from "@untie/core/model/trace";
import { createHotelSample } from "@untie/core/sample";
import { saveLocalToCloud } from "../cloud/files";
import { useSessionStore } from "../cloud/session";
import { confirmDiscardIfDirty, newEmptyDocument, openDocument, openRecentDocument, saveDocument } from "../io/document";
import { navigate } from "../router";
import { baseName, getPlatform, type RecentFile } from "../platform";
import { ANALYSIS_KINDS, ANALYSIS_LABELS, analysisBoardId } from "@untie/core/model/analysis";
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

  // 未保存の変更があれば確かめてからホームへ戻る。捨てると決めたら編集中のモデルも初期のサンプルに戻す
  // (ホームで次に開くときに、同じ確認をもう一度聞かないため)
  const goHome = async () => {
    if (dirty) {
      if (!(await confirmDiscardIfDirty("保存していない変更があります。破棄してホームへ戻りますか？", "破棄してホームへ"))) return;
      useUntieStore.getState().newDocument(createHotelSample(), { pristine: true });
    }
    // 走っている AI エージェントはモデルを書き換え続けてしまうので、ホームへ出る前に止める
    useAgentStore.getState().cancel();
    navigate({ name: "home" });
  };

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
        <button type="button" className="toolbar-home" title="ホーム (ファイルの一覧) へ戻る" onClick={() => void goHome()}>
          ホーム
        </button>
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

/** ファイルのメニュー: 新規作成・開く・最近開いたファイル・保存・別名で保存・クラウドへ保存・プロンプトから作成 */
function FileMenu({ onNew, onCreateFromPrompt }: { onNew: () => void; onCreateFromPrompt: () => void }) {
  const [open, setOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  // 読み込むまでは null (前に開いたときの一覧を出すと、読み込み後に並びが変わってフォーカスが外れる)
  const [recent, setRecent] = useState<RecentFile[] | null>(null);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const signedIn = useSessionStore((s) => s.status === "signedIn");
  // クラウドへ保存している間は押せない (二重に作らない)
  const [savingToCloud, setSavingToCloud] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const recentRef = useRef<HTMLButtonElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  // → で開いたら、サブメニューの先頭へ移る (一覧の読み込みが済んでから)
  const focusFirstRecent = useRef(false);
  useEffect(() => {
    if (!recentOpen || recent === null || !focusFirstRecent.current) return;
    focusFirstRecent.current = false;
    subRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [recentOpen, recent]);
  useEffect(() => {
    if (!open) {
      setRecentOpen(false);
      setRecent(null);
      focusFirstRecent.current = false;
      return;
    }
    let alive = true;
    void getPlatform().recentFiles.load().then((list) => alive && setRecent(list));
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => {
      alive = false;
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    setRecentOpen(false);
  };
  const item = (label: string, shortcut: string, action: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      disabled={disabled}
      // 別の項目に移ったら、最近開いたファイルのサブメニューを閉じる
      onFocus={() => setRecentOpen(false)}
      onMouseEnter={() => setRecentOpen(false)}
      onClick={() => {
        close();
        action();
      }}
    >
      <span>{label}</span>
      <span className="menu-shortcut">{shortcut}</span>
    </button>
  );
  const reopenable = getPlatform().canReopenFiles();
  return (
    <div className="menu" ref={ref} onKeyDown={(e) => e.key === "Escape" && close()}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        ファイル ▾
      </button>
      {open && (
        <div className="menu-list" role="menu" aria-label="ファイル">
          {item("新規作成", "", onNew)}
          {item("開く…", "⌘O", () => void openDocument())}
          <div className="menu-sub">
            <button
              ref={recentRef}
              type="button"
              role="menuitem"
              className="menu-item"
              aria-haspopup="menu"
              aria-expanded={recentOpen}
              disabled={!reopenable}
              title={reopenable ? undefined : "このブラウザでは、開いたファイルを開き直せません"}
              onFocus={() => setRecentOpen(true)}
              onMouseEnter={() => setRecentOpen(true)}
              onClick={() => setRecentOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") {
                  e.preventDefault();
                  focusFirstRecent.current = true;
                  // すでに開いて読み込み済みなら、ここで移る
                  if (recentOpen && recent !== null) {
                    focusFirstRecent.current = false;
                    subRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
                  }
                  setRecentOpen(true);
                }
              }}
            >
              <span>最近開いたファイル</span>
              <span className="menu-shortcut">▸</span>
            </button>
            {recentOpen && (
              <div
                ref={subRef}
                className="menu-list menu-sublist"
                role="menu"
                aria-label="最近開いたファイル"
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    recentRef.current?.focus();
                  }
                }}
              >
                {recent?.length === 0 && <span className="menu-empty">(ありません)</span>}
                {recent?.map((f, i) => (
                  <button
                    key={`${i}:${f.path ?? f.name}`}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    title={f.path ?? f.name}
                    onClick={() => {
                      close();
                      void openRecentDocument(f);
                    }}
                  >
                    <span className="menu-recent-name">{f.name}</span>
                    {f.path && <span className="menu-shortcut menu-recent-dir">{baseName(f.path.slice(0, f.path.length - baseName(f.path).length - 1))}</span>}
                  </button>
                ))}
                {!!recent?.length && (
                  <>
                    <div className="menu-sep" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        void getPlatform().recentFiles.clear();
                      }}
                    >
                      <span>一覧を消去</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {item("保存", "⌘S", () => void saveDocument())}
          {item("別名で保存…", "⇧⌘S", () => void saveDocument(true))}
          {signedIn &&
            item(
              "クラウドへ保存",
              "",
              () => {
                setSavingToCloud(true);
                void saveLocalToCloud().finally(() => setSavingToCloud(false));
              },
              savingToCloud,
            )}
          <div className="menu-sep" role="separator" />
          {item("プロンプトから作成…", "", onCreateFromPrompt)}
          {item("AI の設定…", "", () => setSettingsOpen(true))}
        </div>
      )}
    </div>
  );
}
