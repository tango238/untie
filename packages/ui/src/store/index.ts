import { create } from "zustand";
import * as Y from "yjs";
import { can, type Role } from "@untie/api";
import { applyModelDiff, rebuildModel } from "@untie/collab";
import type { CommandResult } from "@untie/core/model/commands";
import type { UntieModel } from "@untie/core/model/types";
import { moveNode, type Position, type Size } from "@untie/core/model/commands";
import { fixedBoardId, parseFixedBoardId, type FixedLayer } from "@untie/core/model/fixedBoards";
import { analysisBoardId, parseAnalysisBoardId } from "@untie/core/model/analysis";
import { emptyModel } from "@untie/core/model/types";
import type { GlobalFilter } from "@untie/core/model/lineage";
import { createHotelSample } from "@untie/core/sample";

/** 履歴の上限 */
export const HISTORY_LIMIT = 100;

export type Selection = { type: "element"; id: string } | { type: "relation"; id: string } | null;
export type RightPanel = "properties" | "issues" | "trace";

export interface UiState {
  /** 自由ボード (モデルのボード) の id か、固定ボードの id ("fixed:<レイヤー>") */
  currentBoardId: string;
  /** 固定ボードごとの絞り込みの文字列 (履歴に積まない) */
  fixedFilters?: Partial<Record<FixedLayer, string>>;
  /** 固定ボード共通のグローバルフィルター (レイヤーごとに選んだ要素 id。保存しない・履歴に積まない) */
  globalFilter?: GlobalFilter;
  /** 固定ボードの「書き方のヒント」を開いているか (未設定は閉じる。履歴に積まない) */
  guideOpen?: boolean;
  selection: Selection;
  rightPanel: RightPanel;
  /** 右のペイン (プロパティ・課題一覧・検証) を開いているか (未設定は開く。履歴に積まない) */
  rightPanelOpen?: boolean;
  /** 自由ボードの左のペイン (要素一覧) を開いているか (未設定は開く。履歴に積まない) */
  elementListOpen?: boolean;
  /**
   * いま作ったばかりの課題 (プロパティ欄を「追加フォーム」として出す)。作ったときの対象を覚え、
   * 「次の課題を登録する」で同じ対象の課題を続けて作る。別の要素を選ぶと消える (以後は編集フォーム)
   */
  issueDraft?: { id: string; targetIds: string[] };
  /** 増えるたびにプロパティ欄の名前入力へフォーカスする */
  nameFocusNonce: number;
}

export type ToastTone = "info" | "error";
export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

/** 他の人の画面に出す、自分の選択・ボードなどの状態 (awareness) から組み立てた 1 人分 */
export interface Peer {
  /** awareness の clientId (同じ人が複数のタブでつないでいれば、その数だけ別々に出る) */
  clientId: number;
  /** ユーザー id。ゲストは null */
  userId: string | null;
  name: string;
  /** 縁やラベルの色 (#rrggbb) */
  color: string;
  /** 開いているボード (固定ボード・分析ボードも含む)。まだ分からなければ null */
  boardId: string | null;
  selection: Selection;
}

/** クラウドファイルとの接続の状態。loading は最初の同期が済むまで */
export type CloudStatus = "loading" | "connecting" | "connected" | "offline";

/** 開いているクラウドファイル (設計書 8.2)。ローカルのファイルでは null */
export interface CloudInfo {
  fileId: string;
  role: Role;
  /** 正本の写し。dispatch の結果はここへ書き、model はここから組み立てる */
  doc: Y.Doc;
  status: CloudStatus;
  /** サーバーに閉じられた (kick など)。呼び出し側がホームへ戻す */
  closed?: { code: number; reason: string };
  /** リンクで開いたときのトークン (5 段階目) */
  link?: string;
  /** 最後に同期が済んだあと、つながっていない間に自分が書いた変更があるか (閉じると失われるので、閉じる前の確認に使う) */
  dirtySinceOffline: boolean;
}

/** 自分の編集を Y.Doc に書くときの origin。観測側は、これ以外の変更だけを組み立て直す */
export const LOCAL_ORIGIN = "untie-local";

/** 閲覧専用のときに編集を断る理由 */
export const READ_ONLY_REASON = "閲覧専用です";

/** 開いているファイル。path は保存先 (ブラウザではファイルのハンドルの番号。上書きできないブラウザでは無い)、name は表示名 */
export interface DocumentFile {
  path: string | null;
  name: string;
}

export interface UntieState {
  model: UntieModel;
  /** 開いているファイル (サンプルや新規なら null) */
  file: DocumentFile | null;
  /** 最後に保存・読み込みしたときのモデル。model と同じ参照なら未保存の変更は無い */
  savedModel: UntieModel | null;
  history: { past: UntieModel[]; future: UntieModel[] };
  ui: UiState;
  /** ドラッグ開始時点のモデル (ドラッグ中のみ非 null) */
  dragBase: UntieModel | null;
  /** AI エージェントが編集を始めた時点のモデル (エージェントの 1 回の応答の間だけ非 null) */
  agentBase: UntieModel | null;
  toasts: ToastItem[];
  /** 開いているクラウドファイル (ローカルなら null)。あるときは Y.Doc が正本で、Undo / Redo と履歴は使わない */
  cloud: CloudInfo | null;
  /** 同じファイルを開いている他の人 (自分を除く) */
  peers: Peer[];
  /** ドラッグ中に届いたリモートの変更を後回しにしているか (確定・取り消しのあとで組み立て直す) */
  pendingRemote: boolean;

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

  /** AI エージェントの編集を始める。終わるまでの編集は 1 件の履歴にまとめる */
  beginAgentEdit: () => void;
  /** AI エージェントの編集を 1 つ当てる (履歴には積まない) */
  agentApply: <T>(command: (model: UntieModel) => CommandResult<T>) => CommandResult<T>;
  /** AI エージェントの編集を終え、変わっていれば 1 件の履歴として確定する */
  endAgentEdit: () => void;
  /**
   * 新しい (まだ保存していない) モデルにする。履歴と選択は捨てる。
   * pristine なら手を付けていないモデルとして、保存していない変更なしで始める
   */
  newDocument: (model: UntieModel, options?: { pristine?: boolean }) => void;
  /** 読み込んだモデルに置き換える。履歴と選択は捨てる */
  loadDocument: (model: UntieModel, file: DocumentFile) => void;
  /** model を保存したことを記録する (保存中に編集が進んでいれば、その分は未保存のまま) */
  markSaved: (file: DocumentFile, model: UntieModel) => void;
  /**
   * クラウドファイルを開いた状態にする。model は Y.Doc から組み立てたもの。
   * 履歴・選択・ドラッグは捨てる (ローカルの編集中のモデルはここで置き換わる)
   */
  loadCloudDocument: (model: UntieModel, cloud: Omit<CloudInfo, "status" | "closed" | "dirtySinceOffline"> & { status?: CloudStatus }) => void;
  setCloudStatus: (status: CloudStatus) => void;
  setCloudRole: (role: Role) => void;
  /** サーバーに閉じられたことを記録する */
  setCloudClosed: (closed: { code: number; reason: string }) => void;
  setPeers: (peers: Peer[]) => void;
  /**
   * 他の人の変更を Y.Doc から組み立て直したモデルを反映する。ドラッグ中は後回しにして、
   * commitDrag / cancelDrag のあとで組み立て直す
   */
  applyRemoteModel: (model: UntieModel) => void;
  /** クラウドファイルを閉じて、起動時のサンプル (未変更) に戻す。クラウドを開いていなければ何もしない */
  closeCloud: () => void;
  setCurrentBoard: (boardId: string) => void;
  setFixedFilter: (layer: FixedLayer, query: string) => void;
  setGuideOpen: (open: boolean) => void;
  setGlobalFilter: (layer: FixedLayer, ids: string[]) => void;
  resetGlobalFilter: () => void;
  select: (selection: Selection) => void;
  /** 右のペインの中身を切り替える。閉じていれば開く */
  setRightPanel: (panel: RightPanel) => void;
  setRightPanelOpen: (open: boolean) => void;
  setElementListOpen: (open: boolean) => void;
  requestNameFocus: () => void;
  pushToast: (message: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

/**
 * 起動時・新規作成・ファイルを開いたときに最初に出す画面。課題から紐解くので、
 * 分析ボード「課題の分布」と、右ペインの課題一覧を開いておく
 */
export const START_BOARD_ID = analysisBoardId("issues");
const START_UI = { currentBoardId: START_BOARD_ID, rightPanel: "issues" as const, rightPanelOpen: true };

/** モデルが変わったあと、UI の参照先 (ボード・選択) が実在するよう整える */
function reconcileUi(ui: UiState, model: UntieModel): UiState {
  let { currentBoardId, selection } = ui;
  if (!isBuiltinBoard(currentBoardId) && !model.boards.some((b) => b.id === currentBoardId)) {
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

/** 閲覧専用か (クラウドファイルを、編集できない役割で開いている) */
export function selectReadOnly(state: Pick<UntieState, "cloud">): boolean {
  return !!state.cloud && !can(state.cloud.role, "edit");
}

/**
 * クラウドファイルで、手元の変更を Y.Doc に書き、Doc から組み立て直したモデルを返す。
 * Doc が正本なので、同時に届いていた他の人の変更 (消した側が勝つ規則を含む) がここで揃う
 */
function writeThrough(cloud: CloudInfo, before: UntieModel, after: UntieModel): UntieModel {
  applyModelDiff(cloud.doc, before, after, LOCAL_ORIGIN);
  return rebuildModel(cloud.doc, after);
}

/** 自分の編集を書いたとき、つながっていなければ「つながっていない間の変更あり」を立てる */
function markDirtyIfOffline(cloud: CloudInfo): { cloud?: CloudInfo } {
  return cloud.status !== "connected" && !cloud.dirtySinceOffline ? { cloud: { ...cloud, dirtySinceOffline: true } } : {};
}

function pushPast(past: UntieModel[], snapshot: UntieModel): UntieModel[] {
  const next = [...past, snapshot];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** 固定ボードを開いているか */
export function isFixedBoard(boardId: string): boolean {
  return parseFixedBoardId(boardId) !== null;
}

/** 分析ボードを開いているか */
export function isAnalysisBoard(boardId: string): boolean {
  return parseAnalysisBoardId(boardId) !== null;
}

/** モデルに保存しない、アプリが組み立てるボード (固定ボード・分析ボード) か */
export function isBuiltinBoard(boardId: string): boolean {
  return isFixedBoard(boardId) || isAnalysisBoard(boardId);
}

/** ストアを作る (テストでは初期モデルを渡す)。開くボードの既定は最初の自由ボード */
export function createUntieStore(
  initial: UntieModel = createHotelSample(),
  startBoardId = initial.boards[0]?.id ?? "",
  startPanel: RightPanel = "properties",
) {
  return create<UntieState>()((set, get) => ({
    model: initial,
    file: null,
    savedModel: null,
    history: { past: [], future: [] },
    ui: { currentBoardId: startBoardId, selection: null, rightPanel: startPanel, nameFocusNonce: 0 },
    dragBase: null,
    agentBase: null,
    toasts: [],
    cloud: null,
    peers: [],
    pendingRemote: false,

    dispatch: (command) => {
      if (selectReadOnly(get())) return { ok: false, reason: READ_ONLY_REASON };
      // ドラッグ途中ならそれを先に確定する (クラウドでは、後回しにしていたリモートの変更もここで揃う)
      if (get().dragBase) get().commitDrag();
      const { model, history, ui, cloud } = get();
      const result = command(model);
      if (!result.ok || result.model === model) return result;
      if (cloud) {
        // 履歴には積まない。Doc に書いてから組み立て直したモデルを表示に出す
        const next = writeThrough(cloud, model, result.model);
        set({ model: next, ui: reconcileUi(ui, next), ...markDirtyIfOffline(cloud) });
        return result;
      }
      set({
        model: result.model,
        history: { past: pushPast(history.past, model), future: [] },
        ui: reconcileUi(ui, result.model),
      });
      return result;
    },

    undo: () => {
      // クラウドファイルでは使えない (他の人の変更と絡むと結果が読めない)
      if (get().cloud) return;
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
      if (get().cloud || get().dragBase) return;
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
      if (selectReadOnly(get())) return;
      const { model, dragBase } = get();
      const result = moveNode(model, { boardId, elementId, position, size });
      if (!result.ok) return;
      set({ model: result.model, dragBase: dragBase ?? model });
    },

    previewCommand: (command) => {
      if (selectReadOnly(get())) return;
      const { model, dragBase } = get();
      const result = command(model);
      if (!result.ok || result.model === model) return;
      set({ model: result.model, dragBase: dragBase ?? model });
    },

    commitDrag: (command) => {
      // 役割が変わって閲覧専用になっていたら、書かずにドラッグを捨てる
      if (selectReadOnly(get())) {
        get().cancelDrag();
        return;
      }
      const { model, dragBase, history, ui, cloud, pendingRemote } = get();
      // ドラッグ終了時に所属変更などを同じ 1 件の履歴にまとめる
      let finalModel = model;
      if (command) {
        const result = command(model);
        if (result.ok) finalModel = result.model;
      }
      const base = dragBase ?? model;
      if (cloud) {
        // ドラッグ中に届いて後回しにしていた変更は、Doc から組み立て直すときに揃う。
        // 書くのはドラッグで変えた分 (base と finalModel の差) だけなので、他の人の変更は消さない
        if (base === finalModel && !pendingRemote) {
          set({ dragBase: null });
          return;
        }
        const next = base === finalModel ? rebuildModel(cloud.doc, finalModel) : writeThrough(cloud, base, finalModel);
        set({ model: next, dragBase: null, pendingRemote: false, ui: reconcileUi(ui, next), ...(base === finalModel ? {} : markDirtyIfOffline(cloud)) });
        return;
      }
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
      const { dragBase, ui, cloud } = get();
      if (!dragBase) return;
      // クラウドでは、後回しにしていたリモートの変更を含めて Doc から組み立て直す
      const restored = cloud ? rebuildModel(cloud.doc, dragBase) : dragBase;
      set({ model: restored, dragBase: null, pendingRemote: false, ui: reconcileUi(ui, restored) });
    },

    beginAgentEdit: () => {
      if (selectReadOnly(get())) return;
      if (get().dragBase) get().commitDrag();
      if (!get().agentBase) set({ agentBase: get().model });
    },
    agentApply: (command) => {
      if (selectReadOnly(get())) return { ok: false, reason: READ_ONLY_REASON };
      // クラウドでは、AI の編集中 (beginAgentEdit 〜 endAgentEdit) だけ書ける。
      // ファイルを開く前から走っていたローカルのエージェントが、開いたクラウドファイルに書き込まないための守り
      if (get().cloud && !get().agentBase) return { ok: false, reason: "AI エージェントの編集中ではありません" };
      // ドラッグ途中ならそれを先に確定する (後回しにしているリモートの変更を、自分の変更として書き直さないため)
      if (get().dragBase) get().commitDrag();
      const { model, ui, cloud } = get();
      const result = command(model);
      if (result.ok && result.model !== model) {
        // クラウドでは dispatch と同じ経路で Doc に書く (他の人にも見える)
        if (cloud) {
          const next = writeThrough(cloud, model, result.model);
          set({ model: next, ui: reconcileUi(ui, next), ...markDirtyIfOffline(cloud) });
        } else {
          set({ model: result.model, ui: reconcileUi(ui, result.model) });
        }
      }
      return result;
    },
    endAgentEdit: () => {
      const { model, agentBase, history, cloud } = get();
      if (!agentBase) return;
      // クラウドでは履歴を持たない
      if (cloud) {
        set({ agentBase: null });
        return;
      }
      if (agentBase === model) {
        set({ agentBase: null });
        return;
      }
      set({ agentBase: null, history: { past: pushPast(history.past, agentBase), future: [] } });
    },
    newDocument: (model, options) =>
      set((s) => ({
        model,
        file: null,
        // まだ一度も保存していないので、保存していない変更ありとして扱う (pristine なら変更なし)
        savedModel: options?.pristine ? model : emptyModel(),
        history: { past: [], future: [] },
        dragBase: null,
        agentBase: null,
        cloud: null,
        peers: [],
        pendingRemote: false,
        ui: { ...s.ui, ...START_UI, selection: null, issueDraft: undefined, globalFilter: {} },
      })),

    loadDocument: (model, file) =>
      set((s) => ({
        model,
        file,
        savedModel: model,
        history: { past: [], future: [] },
        dragBase: null,
        cloud: null,
        peers: [],
        pendingRemote: false,
        ui: { ...s.ui, ...START_UI, selection: null, issueDraft: undefined, globalFilter: {} },
      })),
    markSaved: (file, model) => set({ file, savedModel: model }),

    loadCloudDocument: (model, cloud) =>
      set((s) => ({
        model,
        file: null,
        savedModel: null,
        history: { past: [], future: [] },
        dragBase: null,
        agentBase: null,
        cloud: { ...cloud, status: cloud.status ?? "loading", dirtySinceOffline: false },
        peers: [],
        pendingRemote: false,
        ui: { ...s.ui, ...START_UI, selection: null, issueDraft: undefined, globalFilter: {} },
      })),
    // connected は同期が済んだときだけ。溜まっていた変更はこのとき送られるので、「つながっていない間の変更」は解く
    setCloudStatus: (status) =>
      set((s) => {
        if (!s.cloud) return s;
        const dirtySinceOffline = status === "connected" ? false : s.cloud.dirtySinceOffline;
        return s.cloud.status === status && s.cloud.dirtySinceOffline === dirtySinceOffline ? s : { cloud: { ...s.cloud, status, dirtySinceOffline } };
      }),
    setCloudRole: (role) => {
      const { cloud } = get();
      if (!cloud || cloud.role === role) return;
      set({ cloud: { ...cloud, role } });
      // 閲覧専用になったら、途中のドラッグと AI の編集は捨てる
      if (selectReadOnly(get())) {
        if (get().dragBase) get().cancelDrag();
        set({ agentBase: null });
      }
    },
    setCloudClosed: (closed) => set((s) => (s.cloud ? { cloud: { ...s.cloud, closed } } : s)),
    setPeers: (peers) => set({ peers }),
    applyRemoteModel: (model) => {
      const { cloud, dragBase, ui } = get();
      if (!cloud) return;
      // ドラッグ中は手元の座標を動かしているので、確定・取り消しのあとで組み立て直す
      if (dragBase) {
        set({ pendingRemote: true });
        return;
      }
      set({ model, ui: reconcileUi(ui, model) });
    },
    closeCloud: () => {
      if (!get().cloud) return;
      const sample = createHotelSample();
      set((s) => ({
        model: sample,
        file: null,
        savedModel: sample,
        history: { past: [], future: [] },
        dragBase: null,
        agentBase: null,
        cloud: null,
        peers: [],
        pendingRemote: false,
        ui: { ...s.ui, ...START_UI, selection: null, issueDraft: undefined, globalFilter: {} },
      }));
    },

    setCurrentBoard: (boardId) => {
      if (!isBuiltinBoard(boardId) && !get().model.boards.some((b) => b.id === boardId)) return;
      set((s) => ({ ui: { ...s.ui, currentBoardId: boardId, selection: null } }));
    },
    setFixedFilter: (layer, query) =>
      set((s) => ({ ui: { ...s.ui, fixedFilters: { ...s.ui.fixedFilters, [layer]: query } } })),
    setGuideOpen: (guideOpen) => set((s) => ({ ui: { ...s.ui, guideOpen } })),
    setGlobalFilter: (layer, ids) =>
      set((s) => ({ ui: { ...s.ui, globalFilter: { ...s.ui.globalFilter, [layer]: [...new Set(ids)] } } })),
    resetGlobalFilter: () => set((s) => ({ ui: { ...s.ui, globalFilter: {} } })),
    select: (selection) =>
      set((s) => {
        const keepDraft = s.ui.issueDraft && selection?.type === "element" && selection.id === s.ui.issueDraft.id;
        return { ui: { ...s.ui, selection, issueDraft: keepDraft ? s.ui.issueDraft : undefined } };
      }),
    setRightPanel: (rightPanel) => set((s) => ({ ui: { ...s.ui, rightPanel, rightPanelOpen: true } })),
    setRightPanelOpen: (rightPanelOpen) => set((s) => ({ ui: { ...s.ui, rightPanelOpen } })),
    setElementListOpen: (elementListOpen) => set((s) => ({ ui: { ...s.ui, elementListOpen } })),
    requestNameFocus: () => set((s) => ({ ui: { ...s.ui, nameFocusNonce: s.ui.nameFocusNonce + 1 } })),
    pushToast: (message, tone = "info") =>
      set((s) => ({ toasts: [...s.toasts.slice(-4), { id: ++toastSeq, message, tone }] })),
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  }));
}

/** アプリ全体で使う単一ストア。起動時にサンプルを読み込み、アクティビティの固定ボードを開く */
export const useUntieStore = createUntieStore(createHotelSample(), START_BOARD_ID, "issues");

/** 保存していない変更があるか (サンプルや新規は、一度も保存していなければ変更ありとみなさない) */
export function hasUnsavedChanges(state: Pick<UntieState, "model" | "savedModel" | "file" | "history"> & Partial<Pick<UntieState, "cloud">>): boolean {
  // クラウドファイルはサーバーが正本なので、つながっている間は未保存の概念が無い。
  // つながっていない間に書いた変更は、つながるまで手元の Doc にしか無い
  if (state.cloud) return state.cloud.status !== "connected" && state.cloud.dirtySinceOffline;
  if (state.savedModel) return state.model !== state.savedModel;
  return state.history.past.length > 0;
}
