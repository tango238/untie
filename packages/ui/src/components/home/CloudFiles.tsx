import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { can, ROLE_LABELS, type FileSummary } from "@untie/api";
import { useFilesStore } from "../../cloud/files";
import { useSessionStore } from "../../cloud/session";
import { parseModel } from "../../io/document";
import { getPlatform } from "../../platform";
import { navigate } from "../../router";
import { useUntieStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { ShareDialog } from "../share/ShareDialog";
import { formatRelativeTime } from "./relativeTime";

type Tab = "mine" | "shared" | "trash";
const TAB_LABELS: Record<Tab, string> = { mine: "自分のファイル", shared: "共有されたファイル", trash: "ゴミ箱" };
const TABS = Object.keys(TAB_LABELS) as Tab[];
const EMPTY_TEXT: Record<Tab, string> = {
  mine: "まだファイルがありません。「新しいファイル」から作れます。",
  shared: "共有されたファイルはありません。",
  trash: "ゴミ箱は空です。",
};

type Pending = { kind: "trash" | "purge" | "leave"; file: FileSummary } | null;

/** ホームのクラウド欄 (ログイン済み): 新規作成・取り込み・タブ・ファイルの一覧と操作 */
export function CloudFiles() {
  const lists = useFilesStore();
  const [tab, setTab] = useState<Tab>("mine");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  // 共有ダイアログを開いているファイルの id
  const [sharing, setSharing] = useState<string | null>(null);
  const me = useSessionStore((s) => s.user);
  // 名前変更を送っている間は「決定」を押せない
  const [renameBusy, setRenameBusy] = useState(false);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const pushToast = useUntieStore((s) => s.pushToast);

  // 開いたとき (ホームに戻ってきたときも) 最新の一覧を読む
  useEffect(() => {
    void useFilesStore.getState().refresh();
  }, []);

  const files = lists[tab];
  const now = Date.now();

  const submitNew = async () => {
    const name = newName.trim();
    if (!name) {
      pushToast("ファイルの名前を入力してください", "error");
      return;
    }
    setBusy(true);
    const created = await lists.create({ name });
    setBusy(false);
    if (created) {
      setCreating(false);
      setNewName("");
      setTab("mine");
    }
  };

  const importLocal = async () => {
    setBusy(true);
    try {
      const opened = await getPlatform().openTextFile();
      if (!opened) return;
      const parsed = parseModel(opened.text);
      if (!parsed.ok) {
        const shown = parsed.errors.slice(0, 3).join(" / ");
        const more = parsed.errors.length > 3 ? ` ほか ${parsed.errors.length - 3} 件` : "";
        pushToast(`「${opened.name}」を取り込めません: ${shown}${more}`, "error");
        return;
      }
      if (await lists.create({ model: parsed.model })) setTab("mine");
    } catch (e) {
      pushToast(`開けませんでした: ${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async () => {
    if (!renaming || renameBusy) return;
    const target = files.find((f) => f.id === renaming.id);
    const name = renaming.name.trim();
    if (!name) {
      pushToast("名前を入力してください", "error");
      return;
    }
    if (target && name === target.name) {
      setRenaming(null);
      return;
    }
    setRenameBusy(true);
    try {
      if (await lists.rename(renaming.id, name)) setRenaming(null);
    } finally {
      setRenameBusy(false);
    }
  };

  const selectTab = (t: Tab) => {
    setTab(t);
    setRenaming(null);
  };

  // タブは ← → で移る (Home / End で端へ)。移った先にフォーカスも渡す
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target =
      e.key === "ArrowRight" ? (index + 1) % TABS.length : e.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (target === null) return;
    e.preventDefault();
    const next = TABS[target]!;
    selectTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="home-cloud">
      <div className="home-actions">
        {creating ? (
          <form
            className="rename-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitNew();
            }}
          >
            <input
              aria-label="新しいファイルの名前"
              placeholder="ファイルの名前"
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setCreating(false);
              }}
            />
            <button type="submit" className="primary" disabled={busy}>
              作成
            </button>
            <button type="button" onClick={() => setCreating(false)}>
              キャンセル
            </button>
          </form>
        ) : (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            新しいファイル
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void importLocal()}>
          ローカルファイルをクラウドへ
        </button>
        <span className="toolbar-spacer" />
        <button type="button" disabled={lists.loading} onClick={() => void lists.refresh()}>
          {lists.loading ? "読み込み中…" : "更新"}
        </button>
      </div>

      <div className="home-tabs" role="tablist" aria-label="クラウドのファイル">
        {TABS.map((t, i) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[t] = el;
            }}
            type="button"
            role="tab"
            id={`home-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`home-panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            className={tab === t ? "active" : ""}
            onClick={() => selectTab(t)}
            onKeyDown={(e) => onTabKeyDown(e, i)}
          >
            {TAB_LABELS[t]}
            {lists[t].length > 0 && <span className="home-tab-count">{lists[t].length}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`home-panel-${tab}`} aria-labelledby={`home-tab-${tab}`}>
        {lists.error && <p className="field-error">一覧を読めませんでした: {lists.error}</p>}
        {files.length === 0 ? (
          !lists.loaded && !lists.error ? (
            <p className="home-empty">読み込み中…</p>
          ) : (
            !lists.error && <p className="home-empty">{EMPTY_TEXT[tab]}</p>
          )
        ) : (
          <table className="home-table">
            <thead>
              <tr>
                <th scope="col">名前</th>
                <th scope="col">{tab === "trash" ? "ゴミ箱に入れた日時" : "更新日時"}</th>
                <th scope="col">役割</th>
                <th scope="col">メンバー</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <td className="home-file-name">
                    {renaming?.id === file.id ? (
                      <form
                        className="rename-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void submitRename();
                        }}
                      >
                        <input
                          aria-label="新しい名前"
                          value={renaming.name}
                          autoFocus
                          onChange={(e) => setRenaming({ id: file.id, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setRenaming(null);
                          }}
                        />
                        <button type="submit" className="primary" disabled={renameBusy}>
                          決定
                        </button>
                        <button type="button" onClick={() => setRenaming(null)}>
                          キャンセル
                        </button>
                      </form>
                    ) : (
                      <>
                        <span>{file.name}</span>
                        {file.role !== "owner" && <span className="home-owner">所有者: {file.ownerName}</span>}
                      </>
                    )}
                  </td>
                  <td>{formatRelativeTime(tab === "trash" ? (file.deletedAt ?? file.updatedAt) : file.updatedAt, now)}</td>
                  <td>{ROLE_LABELS[file.role]}</td>
                  <td>{file.memberCount} 人</td>
                  <td>
                    <div className="home-row-actions" role="group" aria-label={`${file.name} の操作`}>
                      <RowActions
                        file={file}
                        inTrash={tab === "trash"}
                        onRename={() => setRenaming({ id: file.id, name: file.name })}
                        onShare={() => setSharing(file.id)}
                        onAsk={(kind) => setPending({ kind, file })}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pending?.kind === "trash" && (
        <ConfirmDialog
          title="ゴミ箱へ"
          message={`「${pending.file.name}」をゴミ箱に入れます。ゴミ箱から戻せます。`}
          confirmLabel="ゴミ箱へ入れる"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const id = pending.file.id;
            setPending(null);
            void lists.trashFile(id);
          }}
        />
      )}
      {pending?.kind === "leave" && (
        <ConfirmDialog
          title="共有をやめる"
          message={`「${pending.file.name}」の共有をやめます。自分のファイル一覧から消え、もう一度見るには所有者に招待してもらう必要があります。`}
          confirmLabel="共有をやめる"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const id = pending.file.id;
            setPending(null);
            if (me) void lists.leave(id, me.id);
          }}
        />
      )}
      {sharing !== null && <ShareDialog fileId={sharing} onClose={() => setSharing(null)} />}
      {pending?.kind === "purge" && (
        <ConfirmDialog
          title="完全に消す"
          message={`「${pending.file.name}」を完全に消します。中身も消え、元に戻せません。`}
          confirmLabel="完全に消す"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const id = pending.file.id;
            setPending(null);
            void lists.purge(id);
          }}
        />
      )}
    </div>
  );
}

/** 行の操作。役割で出し分ける (見せ方だけで、判定の正本はサーバー) */
function RowActions({
  file,
  inTrash,
  onRename,
  onShare,
  onAsk,
}: {
  file: FileSummary;
  inTrash: boolean;
  onRename: () => void;
  onShare: () => void;
  onAsk: (kind: "trash" | "purge" | "leave") => void;
}) {
  const { duplicate, exportToFile, restore } = useFilesStore.getState();
  if (inTrash) {
    return (
      <>
        {can(file.role, "delete") && (
          <>
            <button type="button" onClick={() => void restore(file.id)}>
              戻す
            </button>
            <button type="button" className="danger-outline" onClick={() => onAsk("purge")}>
              完全に消す
            </button>
          </>
        )}
      </>
    );
  }
  return (
    <>
      {can(file.role, "read") && (
        <button type="button" className="primary" onClick={() => navigate({ name: "file", fileId: file.id })}>
          開く
        </button>
      )}
      {can(file.role, "rename") && (
        <button type="button" onClick={onRename}>
          名前を変える
        </button>
      )}
      {can(file.role, "duplicate") && (
        <button type="button" onClick={() => void duplicate(file.id)}>
          複製
        </button>
      )}
      {can(file.role, "export") && (
        <button type="button" onClick={() => void exportToFile(file.id)}>
          書き出す
        </button>
      )}
      {can(file.role, "manageMembers") && (
        <button type="button" onClick={onShare}>
          共有
        </button>
      )}
      {can(file.role, "leave") && (
        <button type="button" className="danger-outline" onClick={() => onAsk("leave")}>
          共有をやめる
        </button>
      )}
      {can(file.role, "delete") && (
        <button type="button" className="danger-outline" onClick={() => onAsk("trash")}>
          ゴミ箱へ
        </button>
      )}
    </>
  );
}
