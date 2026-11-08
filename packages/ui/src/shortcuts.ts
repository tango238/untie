// キーボードショートカットの表 (純粋なデータと関数だけ。画面・ストアには触れない)。
// ボードの並びと名前は @untie/core の定義から取り、ここには「どのキーでどこへ移るか」だけを置く。
import { ANALYSIS_KINDS, ANALYSIS_LABELS, type AnalysisKind } from "@untie/core/model/analysis";
import { DESIGN_BOARD_KINDS, DESIGN_BOARD_LABELS, type DesignBoardKind } from "@untie/core/model/design";
import { FIXED_BOARD_MENU_ORDER, FIXED_LAYER_LABELS, type FixedLayer } from "@untie/core/model/fixedBoards";

/** macOS か (修飾キーの表示と判定を ⌘ / Ctrl で分ける) */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || "") || (!navigator.platform && /Mac OS X/.test(navigator.userAgent));
}

/** 修飾キーの表示。macOS は「⌘」、それ以外は「Ctrl+」 (続けてキーを書く) */
export function modLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl+";
}

/** イベントが「修飾キー」を押しているか。macOS は Cmd (Ctrl は含めない)、それ以外は Ctrl (Windows キーは使わない) */
export function hasModKey(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">): boolean {
  return isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** 移り先 */
export type ShortcutTarget =
  | { type: "mode"; mode: "analysis" | "design" }
  | { type: "fixed"; layer: FixedLayer }
  | { type: "analysis"; kind: AnalysisKind }
  | { type: "design"; kind: DesignBoardKind }
  | { type: "free"; boardId: string };

/** モード: Cmd+B のあとに押すキー */
export const MODE_KEYS = { analysis: "a", design: "d" } as const;

/** 固定ボード (分析): Cmd+B のあとに押すキー。並びは FIXED_BOARD_MENU_ORDER のとおり (1〜9、0、C、N) */
export const FIXED_KEYS: Record<FixedLayer, string> = {
  actor: "1",
  business: "2",
  buc: "3",
  activity: "4",
  usecase: "5",
  screen: "6",
  information: "7",
  condition: "8",
  state: "9",
  variation: "0",
  context: "c",
  nfr: "n",
};

export const ANALYSIS_KEYS: Record<AnalysisKind, string> = { issues: "i", people: "w", informationLocation: "l" };

export const DESIGN_KEYS: Record<DesignBoardKind, string> = { sitemap: "s", navigation: "v", screen: "g", data: "t", relation: "r" };

export interface ShortcutEntry {
  /** 押すキー (Cmd+B のあと)。大文字で表示する */
  key: string;
  label: string;
  target: ShortcutTarget;
}

export const MODE_ENTRIES: readonly ShortcutEntry[] = [
  { key: MODE_KEYS.analysis, label: "分析", target: { type: "mode", mode: "analysis" } },
  { key: MODE_KEYS.design, label: "設計", target: { type: "mode", mode: "design" } },
];
export const FIXED_ENTRIES: readonly ShortcutEntry[] = FIXED_BOARD_MENU_ORDER.map((layer) => ({
  key: FIXED_KEYS[layer],
  label: FIXED_LAYER_LABELS[layer],
  target: { type: "fixed", layer },
}));
export const ANALYSIS_ENTRIES: readonly ShortcutEntry[] = ANALYSIS_KINDS.map((kind) => ({
  key: ANALYSIS_KEYS[kind],
  label: ANALYSIS_LABELS[kind],
  target: { type: "analysis", kind },
}));
export const DESIGN_ENTRIES: readonly ShortcutEntry[] = DESIGN_BOARD_KINDS.map((kind) => ({
  key: DESIGN_KEYS[kind],
  label: DESIGN_BOARD_LABELS[kind],
  target: { type: "design", kind },
}));

/** Cmd+B のあとに押したキーの移り先。表に無ければ null */
export function resolveChordKey(key: string): ShortcutTarget | null {
  const k = key.toLowerCase();
  const all = [...MODE_ENTRIES, ...FIXED_ENTRIES, ...ANALYSIS_ENTRIES, ...DESIGN_ENTRIES];
  return all.find((e) => e.key === k)?.target ?? null;
}

/** 修飾キー付きの表示。macOS は「⇧⌘S」、それ以外は「Ctrl+Shift+S」 */
export function comboLabel(key: string, opts: { shift?: boolean } = {}): string {
  return isMacPlatform() ? `${opts.shift ? "⇧" : ""}⌘${key}` : `Ctrl+${opts.shift ? "Shift+" : ""}${key}`;
}

/** 一覧の「そのほか」に出す、既存のショートカット。クラウドファイルは useKeyboard の挙動に合わせる (開く・Undo・Redo は無く、保存は JSON の書き出し) */
export function otherShortcuts(cloud: boolean): { keys: string; label: string }[] {
  const list = cloud
    ? [{ keys: comboLabel("S"), label: "JSON に書き出す" }]
    : [
        { keys: comboLabel("O"), label: "開く" },
        { keys: comboLabel("S"), label: "保存" },
        { keys: comboLabel("S", { shift: true }), label: "別名で保存" },
        { keys: comboLabel("Z"), label: "元に戻す" },
        { keys: comboLabel("Z", { shift: true }), label: "やり直す" },
        ...(isMacPlatform() ? [] : [{ keys: "Ctrl+Y", label: "やり直す" }]),
      ];
  return [...list, { keys: "Delete / Backspace", label: "自由ボードから外す (選択中の要素)" }];
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "week", "time"]);

/** 文字を打つ入力か (textarea・contenteditable・文字や数を入れる input)。select・チェックボックス・ボタンは含めない */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type.toLowerCase());
}
