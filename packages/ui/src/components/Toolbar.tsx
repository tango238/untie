import { useEffect, useMemo, useRef, useState } from "react";
import { addBoard, removeBoard, renameBoard } from "@untie/core/model/commands";
import { FIXED_BOARD_MENU_ORDER, FIXED_LAYER_LABELS, fixedBoardId } from "@untie/core/model/fixedBoards";
import { NAME_MAX_LENGTH } from "@untie/core/model/limits";
import { traceToActors, traceWarnings } from "@untie/core/model/trace";
import { cachedCheckDesign } from "./design/checkCache";
import { createHotelSample } from "@untie/core/sample";
import { can, ROLE_LABELS, type Role } from "@untie/api";
import { saveLocalToCloud } from "../cloud/files";
import { useSessionStore } from "../cloud/session";
import { confirmDiscardIfDirty, exportModelToFile, newEmptyDocument, openDocument, openRecentDocument, saveDocument } from "../io/document";
import { navigate } from "../router";
import { baseName, getPlatform, type RecentFile } from "../platform";
import { ANALYSIS_KINDS, ANALYSIS_LABELS, analysisBoardId } from "@untie/core/model/analysis";
import { DESIGN_BOARD_KINDS, DESIGN_BOARD_LABELS, designBoardId } from "@untie/core/model/design";
import { hasUnsavedChanges, isBuiltinBoard, selectReadOnly, useUntieStore, type CloudStatus, type Mode } from "../store";
import { useAgentStore } from "../ai/agentStore";
import { AiSettingsDialog } from "./ai/AiSettingsDialog";
import { CreateFromPromptDialog } from "./ai/CreateFromPromptDialog";
import { AboutDialog } from "./AboutDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { SystemSelectDialog } from "./design/SystemSelectDialog";
import { comboLabel, modLabel } from "../shortcuts";
import { useShortcutsUi } from "../store/shortcutsUi";
import { ShareDialog } from "./share/ShareDialog";

type Dialog = "removeBoard" | "newDocument" | "createFromPrompt" | "about" | "selectSystem" | null;

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
  const mode = useUntieStore((s) => s.ui.mode ?? "analysis");
  const designSystemId = useUntieStore((s) => s.ui.designSystemId);
  // 設計モードの検証は設計の検証 (checkDesign)、分析モードは担い手まで辿れるか
  const designResult = useMemo(() => (mode === "design" && designSystemId ? cachedCheckDesign(model, designSystemId) : null), [model, mode, designSystemId]);
  const traceCount = useMemo(() => {
    if (designResult) return designResult.problems.length;
    const r = traceToActors(model);
    return r.problems.length + r.errors.length;
  }, [model, designResult]);
  // 設計の検証のバッジはエラーだけ数える (警告はパネルの見出しの件数で見せる)
  const warningCount = useMemo(() => (designResult ? 0 : traceWarnings(model).length), [model, designResult]);
  const file = useUntieStore((s) => s.file);
  const agentOpen = useAgentStore((s) => s.open);
  const setAgentOpen = useAgentStore((s) => s.setOpen);
  const aiSettingsOpen = useAgentStore((s) => s.settingsOpen);
  const modelName = useUntieStore((s) => s.model.meta.name);
  const dirty = useUntieStore(hasUnsavedChanges);
  // クラウドファイル: 履歴を持たず (Undo / Redo は使えない)、閲覧専用の役割もある
  const cloud = useUntieStore((s) => s.cloud);
  const readOnly = useUntieStore(selectReadOnly);
  const canUndo = useUntieStore((s) => s.history.past.length > 0);
  const canRedo = useUntieStore((s) => s.history.future.length > 0);
  const setCurrentBoard = useUntieStore((s) => s.setCurrentBoard);
  const designSystemName = useUntieStore((s) => (s.ui.designSystemId === undefined ? undefined : s.model.elements.find((e) => e.id === s.ui.designSystemId)?.name));
  const setMode = useUntieStore((s) => s.setMode);
  const dispatch = useUntieStore((s) => s.dispatch);
  const undo = useUntieStore((s) => s.undo);
  const redo = useUntieStore((s) => s.redo);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const rightPanelOpen = useUntieStore((s) => s.ui.rightPanelOpen ?? true);
  const setRightPanelOpen = useUntieStore((s) => s.setRightPanelOpen);
  const elementListOpen = useUntieStore((s) => s.ui.elementListOpen ?? true);
  const setElementListOpen = useUntieStore((s) => s.setElementListOpen);
  const pushToast = useUntieStore((s) => s.pushToast);

  const [renaming, setRenaming] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const canShare = cloud !== null && can(cloud.role, "manageMembers");
  // 所有者でなくなった (譲った・役割が変わった) ら、ダイアログを閉じて開いた状態も戻す
  // (戻さないと、あとで所有者に戻ったときに勝手に開く)
  useEffect(() => {
    if (!canShare) setShareOpen(false);
  }, [canShare]);

  // 固定ボードでは board は undefined (名前変更・削除はできない)
  const board = boards.find((b) => b.id === currentBoardId);
  // 固定ボード・分析ボードはアプリが組み立てるので、名前変更・削除はできない
  const fixed = isBuiltinBoard(currentBoardId);

  // 未保存の変更があれば確かめてからホームへ戻る。捨てると決めたら編集中のモデルも初期のサンプルに戻す
  // (ホームで次に開くときに、同じ確認をもう一度聞かないため)
  const goHome = async () => {
    if (dirty) {
      // クラウドファイルで未保存と数えるのは、つながっていない間の変更だけ (つながるまで手元にしか無い)
      const message = cloud
        ? "つながっていない間の変更はまだ送れていません。ホームへ戻ると失われます。破棄してホームへ戻りますか？"
        : "保存していない変更があります。破棄してホームへ戻りますか？";
      if (!(await confirmDiscardIfDirty(message, "破棄してホームへ"))) return;
      // クラウドファイルは、画面を離れるときに閉じてサンプルへ戻す (CloudEditor)。ここでは触らない
      if (!cloud) useUntieStore.getState().newDocument(createHotelSample(), { pristine: true });
    }
    // 走っている AI エージェントはモデルを書き換え続けてしまうので、ホームへ出る前に止める
    useAgentStore.getState().cancel();
    navigate({ name: "home" });
  };

  // 設計へは、対象のシステムが決まっていればそのまま移り、未定ならシステムの選択を出す
  const changeMode = (next: Mode) => {
    if (next === "design" && designSystemId === undefined) setDialog("selectSystem");
    else setMode(next);
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
    const result = dispatch((m) => renameBoard(m, { id: board.id, name }));
    if (!result.ok) pushToast(result.reason, "error");
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
        {cloud && <CloudBadges name={modelName} status={cloud.status} role={cloud.role} />}
        {canShare && (
          <button type="button" title="メンバーの招待とリンク閲覧の設定" onClick={() => setShareOpen(true)}>
            共有
          </button>
        )}

        <div className="toolbar-group">
          <FileMenu
            cloud={cloud !== null}
            // ゲストの複製は、帯の「複製して自分のファイルにする」に一本化する (ここからだと手元のモデルを別のファイルにしてしまう)
            guest={cloud?.role === "guest"}
            readOnly={readOnly}
            mode={mode}
            onModeChange={changeMode}
            onHome={() => void goHome()}
            onNew={() => (dirty ? setDialog("newDocument") : newEmptyDocument())}
            onCreateFromPrompt={() => setDialog("createFromPrompt")}
          />
        </div>

        <div className="toolbar-group toolbar-board">
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
                  {mode === "design" ? (
                    <optgroup label="設計ボード">
                      {DESIGN_BOARD_KINDS.map((kind) => (
                        <option key={kind} value={designBoardId(kind)}>
                          {DESIGN_BOARD_LABELS[kind]}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    <>
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
                    </>
                  )}
                  <optgroup label="自由ボード">
                    {boards.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              {mode === "design" && (
                <button type="button" className="design-system-button" title="設計するシステムを切り替える" onClick={() => setDialog("selectSystem")}>
                  設計: {designSystemName || "(名前なし)"}
                </button>
              )}
              {!readOnly && (
                <>
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
              )}
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
                maxLength={NAME_MAX_LENGTH}
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

        <div className="toolbar-group toolbar-actions">
          {/* 狭い画面では左右のペインが閉じているので、ここから開く (広い画面では隠す) */}
          {!fixed && (
            <button
              type="button"
              className={`mobile-only${elementListOpen ? " active" : ""}`}
              aria-label={elementListOpen ? "要素一覧を隠す" : "要素一覧を表示"}
              onClick={() => setElementListOpen(!elementListOpen)}
            >
              要素一覧
            </button>
          )}
          <button
            type="button"
            className={`mobile-only${rightPanelOpen && rightPanel === "properties" ? " active" : ""}`}
            aria-label={rightPanelOpen && rightPanel === "properties" ? "プロパティを隠す" : "プロパティを表示"}
            onClick={() => (rightPanelOpen && rightPanel === "properties" ? setRightPanelOpen(false) : setRightPanel("properties"))}
          >
            プロパティ
          </button>
          <button
            type="button"
            aria-label="元に戻す"
            title={cloud ? SHARED_NO_UNDO : "元に戻す (Cmd/Ctrl+Z)"}
            disabled={cloud !== null || !canUndo}
            onClick={undo}
          >
            ↶
          </button>
          <button
            type="button"
            aria-label="やり直す"
            title={cloud ? SHARED_NO_UNDO : "やり直す (Shift+Cmd/Ctrl+Z)"}
            disabled={cloud !== null || !canRedo}
            onClick={redo}
          >
            ↷
          </button>
          <button
            type="button"
            aria-pressed={rightPanelOpen && rightPanel === "trace"}
            className={rightPanelOpen && rightPanel === "trace" ? "active" : ""}
            title={mode === "design" ? "設計 (データベースとの対応・サイトマップ・画面) を調べる" : "すべての要素が担い手 (アクター／外部アクター／システム) まで辿れるかを調べる"}
            onClick={() => setRightPanel(rightPanelOpen && rightPanel === "trace" ? "properties" : "trace")}
          >
            検証
            {traceCount > 0 && <span className="toolbar-count">{traceCount}</span>}
            {warningCount > 0 && (
              <span className="toolbar-count is-warning" title="警告 (エラーではありません)">
                {warningCount}
              </span>
            )}
          </button>
          {/* 課題は分析のためのものなので、設計モードでは出さない */}
          {mode !== "design" && (
            <button
              type="button"
              aria-pressed={rightPanelOpen && rightPanel === "issues"}
              className={rightPanelOpen && rightPanel === "issues" ? "active" : ""}
              onClick={() => setRightPanel(rightPanelOpen && rightPanel === "issues" ? "properties" : "issues")}
            >
              課題一覧
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              aria-pressed={agentOpen}
              className={agentOpen ? "active" : ""}
              title="AI エージェントと会話して、モデルを直す"
              onClick={() => setAgentOpen(!agentOpen)}
            >
              AI
            </button>
          )}
        </div>
      </div>

      {/* クラウドファイルの名前と状態は、上の名前の横に出している */}
      {!cloud && (
        <div className={`notice${dirty ? " is-dirty" : ""}`} role="status" aria-label="ファイルの状態">
          {file ? `ファイル: ${file.name}` : `${modelName} (まだ保存していません)`}
          {dirty && <span className="notice-dirty">● 保存していない変更があります</span>}
        </div>
      )}

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
      {dialog === "selectSystem" && <SystemSelectDialog onClose={() => setDialog(null)} />}
      {dialog === "about" && <AboutDialog onClose={() => setDialog(null)} />}
      {/* 所有者でなくなった (譲った) ら、ダイアログも閉じる */}
      {shareOpen && cloud && canShare && <ShareDialog fileId={cloud.fileId} onClose={() => setShareOpen(false)} />}
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

const SHARED_NO_UNDO = "共有中は取り消せません";

const CONNECTION_LABELS: Record<CloudStatus, string> = {
  loading: "接続しています…",
  connecting: "接続しています…",
  connected: "接続中",
  offline: "切断。再接続します",
};

/** クラウドファイルの名前の横: 接続の状態・自分の役割・一緒に開いている人の色玉 (title に名前) */
function CloudBadges({ name, status, role }: { name: string; status: CloudStatus; role: Role }) {
  const peers = useUntieStore((s) => s.peers);
  // 同じ人が複数のタブで開いていても 1 つにまとめる
  const people = useMemo(() => {
    const seen = new Map<string, (typeof peers)[number]>();
    for (const p of peers) {
      const key = p.userId ?? `guest:${p.clientId}`;
      if (!seen.has(key)) seen.set(key, p);
    }
    return [...seen.values()];
  }, [peers]);
  const SHOWN = 8;
  return (
    <div className="toolbar-group cloud-badges">
      <span className="cloud-name" title={name}>
        {name || "名前なし"}
      </span>
      <span className={`cloud-status is-${status}`} role="status" aria-label="接続の状態">
        {CONNECTION_LABELS[status]}
      </span>
      <span className="cloud-role">{ROLE_LABELS[role]}</span>
      <span className="peer-dots" role="group" aria-label="一緒に開いている人">
        {people.slice(0, SHOWN).map((p) => (
          <span key={p.clientId} className="peer-dot" style={{ background: p.color }} title={p.name} data-testid="peer-dot">
            <span className="visually-hidden">{p.name}</span>
          </span>
        ))}
        {people.length > SHOWN && <span className="peer-more">+{people.length - SHOWN}</span>}
      </span>
    </div>
  );
}

/**
 * ファイルのメニュー: 新規作成・開く・最近開いたファイル・モード・保存・別名で保存・クラウドへ保存・プロンプトから作成。
 * クラウドファイルを開いているときは、ホーム・JSON に書き出す・クラウドへ保存 (複製)・モードだけ
 */
function FileMenu({
  cloud,
  guest,
  readOnly,
  mode,
  onModeChange,
  onHome,
  onNew,
  onCreateFromPrompt,
}: {
  cloud: boolean;
  guest: boolean;
  readOnly: boolean;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  onHome: () => void;
  onNew: () => void;
  onCreateFromPrompt: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  // 読み込むまでは null (前に開いたときの一覧を出すと、読み込み後に並びが変わってフォーカスが外れる)
  const [recent, setRecent] = useState<RecentFile[] | null>(null);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const signedIn = useSessionStore((s) => s.status === "signedIn");
  // クラウドへ保存している間は押せない (二重に作らない)
  const [savingToCloud, setSavingToCloud] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const recentRef = useRef<HTMLButtonElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLButtonElement>(null);
  const modeSubRef = useRef<HTMLDivElement>(null);
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
      setModeOpen(false);
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
    setModeOpen(false);
  };
  const item = (label: string, shortcut: string, action: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      disabled={disabled}
      // 別の項目に移ったら、サブメニュー (最近開いたファイル・モード) を閉じる
      onFocus={() => {
        setRecentOpen(false);
        setModeOpen(false);
      }}
      onMouseEnter={() => {
        setRecentOpen(false);
        setModeOpen(false);
      }}
      onClick={() => {
        close();
        action();
      }}
    >
      <span>{label}</span>
      <span className="menu-shortcut">{shortcut}</span>
    </button>
  );
  // 「モード」のサブメニュー (最近開いたファイルと同じ作り)。今のモードに ✓ を付ける
  const modeMenu = (
    <div className="menu-sub">
      <button
        ref={modeRef}
        type="button"
        role="menuitem"
        className="menu-item"
        aria-haspopup="menu"
        aria-expanded={modeOpen}
        onFocus={() => {
          setModeOpen(true);
          setRecentOpen(false);
        }}
        onMouseEnter={() => {
          setModeOpen(true);
          setRecentOpen(false);
        }}
        onClick={() => setModeOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            setModeOpen(true);
            // サブメニューが描かれてから先頭へ移る
            // 今のモード (✓) の項目へ
            setTimeout(() => modeSubRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(), 0);
          }
        }}
      >
        <span>モード</span>
        <span className="menu-shortcut">▸</span>
      </button>
      {modeOpen && (
        <div
          ref={modeSubRef}
          className="menu-list menu-sublist"
          role="menu"
          aria-label="モード"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              modeRef.current?.focus();
            }
          }}
        >
          {(
            [
              ["analysis", "分析"],
              ["design", "設計"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={mode === value}
              className="menu-item"
              onClick={() => {
                close();
                onModeChange(value);
              }}
            >
              <span>{label}</span>
              <span className="menu-shortcut">{mode === value ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
  const reopenable = getPlatform().canReopenFiles();
  const saveCopyToCloud = () => {
    setSavingToCloud(true);
    void saveLocalToCloud().finally(() => setSavingToCloud(false));
  };
  return (
    <div className="menu" ref={ref} onKeyDown={(e) => e.key === "Escape" && close()}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        ファイル ▾
      </button>
      {open && cloud && (
        <div className="menu-list" role="menu" aria-label="ファイル">
          {item("ホーム", "", onHome)}
          {item("JSON に書き出す…", comboLabel("S"), () => void exportModelToFile())}
          {signedIn && !guest && item("クラウドへ保存 (複製)", "", saveCopyToCloud, savingToCloud)}
          {modeMenu}
          {item("ショートカット一覧", `${modLabel()}/`, () => useShortcutsUi.getState().show())}
          {!readOnly && (
            <>
              <div className="menu-sep" role="separator" />
              {item("AI の設定…", "", () => setSettingsOpen(true))}
            </>
          )}
        </div>
      )}
      {open && !cloud && (
        <div className="menu-list" role="menu" aria-label="ファイル">
          {item("新規作成", "", onNew)}
          {item("開く…", comboLabel("O"), () => void openDocument())}
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
              onFocus={() => { setRecentOpen(true); setModeOpen(false); }}
              onMouseEnter={() => { setRecentOpen(true); setModeOpen(false); }}
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
          {modeMenu}
          {item("ショートカット一覧", `${modLabel()}/`, () => useShortcutsUi.getState().show())}
          {item("保存", comboLabel("S"), () => void saveDocument())}
          {item("別名で保存…", comboLabel("S", { shift: true }), () => void saveDocument(true))}
          {signedIn && item("クラウドへ保存", "", saveCopyToCloud, savingToCloud)}
          <div className="menu-sep" role="separator" />
          {item("プロンプトから作成…", "", onCreateFromPrompt)}
          {item("AI の設定…", "", () => setSettingsOpen(true))}
        </div>
      )}
    </div>
  );
}
