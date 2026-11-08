import { useEffect, useRef } from "react";
import { useUntieStore } from "../store";
import { analysisBoardId } from "@untie/core/model/analysis";
import { designBoardId } from "@untie/core/model/design";
import { fixedBoardId } from "@untie/core/model/fixedBoards";
import {
  ANALYSIS_ENTRIES,
  DESIGN_ENTRIES,
  FIXED_ENTRIES,
  MODE_ENTRIES,
  otherShortcuts,
  hasModKey,
  modLabel,
  isTextEntry,
  resolveChordKey,
  type ShortcutEntry,
  type ShortcutTarget,
} from "../shortcuts";
import { SystemSelectDialog } from "./design/SystemSelectDialog";
import { navigateTo, useShortcutsUi } from "../store/shortcutsUi";

/** 3 秒たっても次のキーが押されなければ、キー待ちを解く */
export const CHORD_TIMEOUT_MS = 3000;

const MODIFIER_KEYS = new Set(["Shift", "Control", "Meta", "Alt", "AltGraph", "CapsLock"]);
const isSlashKey = (key: string) => key === "/" || key === "?";

/**
 * ショートカットの一覧 (Cmd/Ctrl+/ または ?) と、ボードへ移るコード (Cmd/Ctrl+B のあとにキー)。
 * document の keydown で拾う。文字を打つ入力欄 (select は含まない)・IME 変換中・ほかのモーダルなダイアログの上では何もしない
 * (ブラウザの既定の動作もそのまま)。キー待ちで処理したキーは preventDefault と stopPropagation をして、useKeyboard に渡さない
 */
export function handleShortcutKeyDown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return;
  const ui = useShortcutsUi.getState();
  if (ui.open) {
    if (ui.waiting) {
      if (MODIFIER_KEYS.has(e.key)) return;
      // Tab・Enter・Space はキー待ちを解いて一覧として使う (キーの本来の動作はそのまま)
      if (e.key === "Tab" || e.key === "Enter" || e.key === " ") {
        ui.setWaiting(false);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // 続けて Cmd+B を押したら待ち直す (3 秒を数え直す)
      if (hasModKey(e) && !e.altKey && e.key.toLowerCase() === "b") {
        ui.setWaiting(true);
        return;
      }
      // 修飾キー付きのキー (Cmd+S など) と Esc、表に無いキーは取り消して閉じる。修飾キー付きでは移らない
      const target = e.metaKey || e.ctrlKey || e.altKey || e.key === "Escape" ? null : resolveChordKey(e.key);
      if (target) navigateTo(target);
      else ui.close();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      ui.close();
      return;
    }
    if (hasModKey(e) && !e.altKey) {
      if (isSlashKey(e.key)) {
        e.preventDefault();
        ui.close();
      } else if (e.key.toLowerCase() === "b" && !e.shiftKey) {
        e.preventDefault();
        ui.setWaiting(true);
      }
    }
    return;
  }
  if (!hasModKey(e) || e.altKey) return;
  // Shift が要る配列のために、"/" は Shift 付きでも、"?" でも開く。B は Shift なしだけ
  const isSlash = isSlashKey(e.key);
  const isB = e.key.toLowerCase() === "b" && !e.shiftKey;
  if (!isSlash && !isB) return;
  if (isTextEntry(e.target)) return;
  if (document.querySelector('[aria-modal="true"]')) return;
  e.preventDefault();
  ui.show(isB);
}

function targetBoardId(t: ShortcutTarget): string | null {
  switch (t.type) {
    case "fixed": return fixedBoardId(t.layer);
    case "analysis": return analysisBoardId(t.kind);
    case "design": return designBoardId(t.kind);
    case "free": return t.boardId;
    case "mode": return null;
  }
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd>{children}</kbd>;
}

function Group({ title, entries, current, chord }: { title: string; entries: readonly ShortcutEntry[]; current: (t: ShortcutTarget) => boolean; chord: string }) {
  return (
    <section className="shortcuts-group">
      <h3>{title}</h3>
      <ul>
        {entries.map((e) => (
          <li key={e.label}>
            <button type="button" className={current(e.target) ? "current" : undefined} aria-current={current(e.target) ? "true" : undefined} onClick={() => navigateTo(e.target)}>
              <span className="shortcuts-keys">
                <Kbd>{chord}</Kbd> <Kbd>{e.key.toUpperCase()}</Kbd>
              </span>
              <span>{e.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Tab をパネルの中で折り返す */
function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "Tab") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)"));
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === e.currentTarget)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function ShortcutsPanel() {
  const waiting = useShortcutsUi((s) => s.waiting);
  const waitingSince = useShortcutsUi((s) => s.waitingSince);
  const cloud = useUntieStore((s) => s.cloud !== null);
  const close = useShortcutsUi((s) => s.close);
  const mode = useUntieStore((s) => s.ui.mode ?? "analysis");
  const currentBoardId = useUntieStore((s) => s.ui.currentBoardId);
  const boards = useUntieStore((s) => s.model.boards);
  const panelRef = useRef<HTMLDivElement>(null);
  const mod = modLabel();
  const chord = `${mod}B`;

  // 開いた直後はパネルへ focus を移し、閉じたら元に戻す
  useEffect(() => {
    const active = document.activeElement;
    const prev = active instanceof HTMLElement && active !== document.body ? active : null;
    panelRef.current?.focus();
    return () => {
      if (prev?.isConnected) {
        prev.focus();
        return;
      }
      // 戻り先が無い (ファイルメニューの項目から開いたなど) ときは「ファイル」のメニューボタンへ
      const fileMenu = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')).find((b) => b.textContent?.startsWith("ファイル"));
      fileMenu?.focus();
    };
  }, []);
  // キー待ちは 3 秒で解く (一覧は開いたまま)
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => useShortcutsUi.getState().setWaiting(false), CHORD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [waiting, waitingSince]);

  const current = (t: ShortcutTarget) => (t.type === "mode" ? t.mode === mode : targetBoardId(t) === currentBoardId);
  const freeEntries: ShortcutEntry[] = boards.map((b) => ({ key: "", label: b.name, target: { type: "free", boardId: b.id } }));

  return (
    <div className="shortcuts-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="shortcuts-panel" role="dialog" aria-modal="true" aria-label="ショートカット" tabIndex={-1} ref={panelRef} onKeyDown={trapTab}>
        <h2>ショートカット</h2>
        <p className="shortcuts-waiting" role="status">{waiting ? "移りたいボードのキーを押してください" : ""}</p>
        <div className="shortcuts-groups">
          <Group title="モード" entries={MODE_ENTRIES} current={current} chord={chord} />
          <Group title="固定ボード (分析)" entries={FIXED_ENTRIES} current={current} chord={chord} />
          <Group title="分析ボード" entries={ANALYSIS_ENTRIES} current={current} chord={chord} />
          <Group title="設計ボード" entries={DESIGN_ENTRIES} current={current} chord={chord} />
          <section className="shortcuts-group">
            <h3>自由ボード</h3>
            {freeEntries.length === 0 ? (
              <p className="shortcuts-empty">自由ボードはありません</p>
            ) : (
              <ul>
                {freeEntries.map((e) => (
                  <li key={e.target.type === "free" ? e.target.boardId : e.label}>
                    <button type="button" className={current(e.target) ? "current" : undefined} aria-current={current(e.target) ? "true" : undefined} onClick={() => navigateTo(e.target)}>
                      <span>{e.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="shortcuts-group">
            <h3>そのほか</h3>
            <ul>
              {otherShortcuts(cloud).map((o) => (
                <li key={o.keys + o.label} className="shortcuts-static">
                  <span className="shortcuts-keys"><Kbd>{o.keys}</Kbd></span>
                  <span>{o.label}</span>
                </li>
              ))}
              <li className="shortcuts-static">
                <span className="shortcuts-keys"><Kbd>{`${mod}/`}</Kbd></span>
                <span>この一覧</span>
              </li>
              <li>
                <button type="button" onClick={() => useShortcutsUi.getState().setWaiting(true)}>
                  <span className="shortcuts-keys"><Kbd>{chord}</Kbd></span>
                  <span>ボードへ移る (次のキーを押す)</span>
                </button>
              </li>
              <li className="shortcuts-static">
                <span className="shortcuts-keys"><Kbd>Esc</Kbd></span>
                <span>閉じる</span>
              </li>
            </ul>
          </section>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={close}>閉じる</button>
        </div>
      </div>
    </div>
  );
}

/** App に 1 つ置く。キーを拾い、一覧と (設計の対象が未定のときの) システムの選択を出す */
export function ShortcutsHost() {
  const open = useShortcutsUi((s) => s.open);
  const systemSelect = useShortcutsUi((s) => s.systemSelect);
  useEffect(() => {
    document.addEventListener("keydown", handleShortcutKeyDown);
    return () => document.removeEventListener("keydown", handleShortcutKeyDown);
  }, []);
  return (
    <>
      {open && <ShortcutsPanel />}
      {systemSelect && <SystemSelectDialog boardId={systemSelect.boardId} onClose={() => useShortcutsUi.getState().closeSystemSelect()} />}
    </>
  );
}
