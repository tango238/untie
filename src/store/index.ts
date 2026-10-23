import { create } from "zustand";
import type { CommandResult } from "../model/commands";
import type { UntieModel } from "../model/types";
import { moveNode, type Position, type Size } from "../model/commands";
import { fixedBoardId, parseFixedBoardId, type FixedLayer } from "../model/fixedBoards";
import { createHotelSample } from "../sample";

/** 履歴の上限 */
export const HISTORY_LIMIT = 100;

export type Selection = { type: "element"; id: string } | { type: "relation"; id: string } | null;
export type RightPanel = "properties" | "issues";

export interface UiState {
  /** 自由ボード (モデルのボード) の id か、固定ボードの id ("fixed:<レイヤー>") */
  currentBoardId: string;
  /** 固定ボードごとの絞り込みの文字列 (履歴に積まない) */
  fixedFilters?: Partial<Record<FixedLayer, string>>;
  /** 固定ボードの「書き方のヒント」を開いているか (未設定は閉じる。履歴に積まない) */
  guideOpen?: boolean;
  selection: Selection;
  rightPanel: RightPanel;
  /** 増えるたびにプロパティ欄の名前入力へフォーカスする */
  nameFocusNonce: number;
}

export type ToastTone = "info" | "error";
export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

export interface UntieState {
  model: UntieModel;
  history: { past: UntieModel[]; future: UntieModel[] };
  ui: UiState;
  /** ドラッグ開始時点のモデル (ドラッグ中のみ非 null) */
  dragBase: UntieModel | null;
  toasts: ToastItem[];

  /** コマンドを実行し、成功したら履歴に積む。失敗や変更なしは何もしない */
  dispatch: <T>(command: (model: UntieModel) => CommandResult<T>) => CommandResult<T>;
  undo: () => void;
  redo: () => void;
  /** ドラッグ中の一時的な座標更新 (履歴に積まない) */
  previewNode: (boardId: string, elementId: string, position: Position, size?: Size) => void;
  /** ドラッグ中の一時的な変更 (複数ノードをまとめて動かすとき)。履歴に積まない */
  previewCommand: (command: (model: UntieModel) => CommandResult) => void;
  /** ドラッグ終了。ドラッグ全体を 1 件の履歴として確定する */
  commitDrag: (command?: (model: UntieModel) => CommandResult) => void;
  /** ドラッグを取り消して開始時点に戻す */
  cancelDrag: () => void;

  setCurrentBoard: (boardId: string) => void;
  setFixedFilter: (layer: FixedLayer, query: string) => void;
  setGuideOpen: (open: boolean) => void;
  select: (selection: Selection) => void;
  setRightPanel: (panel: RightPanel) => void;
  requestNameFocus: () => void;
  pushToast: (message: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

/** モデルが変わったあと、UI の参照先 (ボード・選択) が実在するよう整える */
function reconcileUi(ui: UiState, model: UntieModel): UiState {
  let { currentBoardId, selection } = ui;
  if (!parseFixedBoardId(currentBoardId) && !model.boards.some((b) => b.id === currentBoardId)) {
    currentBoardId = model.boards[0]?.id ?? fixedBoardId("activity");
  }
  if (selection) {
    const exists =
      selection.type === "element"
        ? model.elements.some((e) => e.id === selection!.id)
        : model.relations.some((r) => r.id === selection!.id);
    if (!exists) selection = null;
  }
  if (currentBoardId === ui.currentBoardId && selection === ui.selection) return ui;
  return { ...ui, currentBoardId, selection };
}

function pushPast(past: UntieModel[], snapshot: UntieModel): UntieModel[] {
  const next = [...past, snapshot];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** 固定ボードを開いているか */
export function isFixedBoard(boardId: string): boolean {
  return parseFixedBoardId(boardId) !== null;
}

/** ストアを作る (テストでは初期モデルを渡す)。開くボードの既定は最初の自由ボード */
export function createUntieStore(initial: UntieModel = createHotelSample(), startBoardId = initial.boards[0]?.id ?? "") {
  return create<UntieState>()((set, get) => ({
    model: initial,
    history: { past: [], future: [] },
    ui: { currentBoardId: startBoardId, selection: null, rightPanel: "properties", nameFocusNonce: 0 },
    dragBase: null,
    toasts: [],

    dispatch: (command) => {
      // ドラッグ途中ならそれを先に確定する
      if (get().dragBase) get().commitDrag();
      const { model, history, ui } = get();
      const result = command(model);
      if (!result.ok || result.model === model) return result;
      set({
        model: result.model,
        history: { past: pushPast(history.past, model), future: [] },
        ui: reconcileUi(ui, result.model),
      });
      return result;
    },

    undo: () => {
      // ドラッグ中は無視する (確定して直後に取り消すと、ドラッグが丸ごと消えてしまう)
      if (get().dragBase) return;
      const { model, history, ui } = get();
      const prev = history.past[history.past.length - 1];
      if (!prev) return;
      set({
        model: prev,
        history: { past: history.past.slice(0, -1), future: [model, ...history.future] },
        ui: reconcileUi(ui, prev),
      });
    },

    redo: () => {
      if (get().dragBase) return;
      const { model, history, ui } = get();
      const next = history.future[0];
      if (!next) return;
      set({
        model: next,
        history: { past: pushPast(history.past, model), future: history.future.slice(1) },
        ui: reconcileUi(ui, next),
      });
    },

    previewNode: (boardId, elementId, position, size) => {
      const { model, dragBase } = get();
      const result = moveNode(model, { boardId, elementId, position, size });
      if (!result.ok) return;
      set({ model: result.model, dragBase: dragBase ?? model });
    },

    previewCommand: (command) => {
      const { model, dragBase } = get();
      const result = command(model);
      if (!result.ok || result.model === model) return;
      set({ model: result.model, dragBase: dragBase ?? model });
    },

    commitDrag: (command) => {
      const { model, dragBase, history, ui } = get();
      // ドラッグ終了時に所属変更などを同じ 1 件の履歴にまとめる
      let finalModel = model;
      if (command) {
        const result = command(model);
        if (result.ok) finalModel = result.model;
      }
      const base = dragBase ?? model;
      if (base === finalModel) {
        set({ dragBase: null });
        return;
      }
      set({
        model: finalModel,
        dragBase: null,
        history: { past: pushPast(history.past, base), future: [] },
        ui: reconcileUi(ui, finalModel),
      });
    },

    cancelDrag: () => {
      const { dragBase, ui } = get();
      if (!dragBase) return;
      set({ model: dragBase, dragBase: null, ui: reconcileUi(ui, dragBase) });
    },

    setCurrentBoard: (boardId) => {
      if (!isFixedBoard(boardId) && !get().model.boards.some((b) => b.id === boardId)) return;
      set((s) => ({ ui: { ...s.ui, currentBoardId: boardId, selection: null } }));
    },
    setFixedFilter: (layer, query) =>
      set((s) => ({ ui: { ...s.ui, fixedFilters: { ...s.ui.fixedFilters, [layer]: query } } })),
    setGuideOpen: (guideOpen) => set((s) => ({ ui: { ...s.ui, guideOpen } })),
    select: (selection) => set((s) => ({ ui: { ...s.ui, selection } })),
    setRightPanel: (rightPanel) => set((s) => ({ ui: { ...s.ui, rightPanel } })),
    requestNameFocus: () => set((s) => ({ ui: { ...s.ui, nameFocusNonce: s.ui.nameFocusNonce + 1 } })),
    pushToast: (message, tone = "info") =>
      set((s) => ({ toasts: [...s.toasts.slice(-4), { id: ++toastSeq, message, tone }] })),
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  }));
}

/** アプリ全体で使う単一ストア。起動時にサンプルを読み込み、アクティビティの固定ボードを開く */
export const useUntieStore = createUntieStore(createHotelSample(), fixedBoardId("activity"));
