import { create } from "zustand";
import { analysisBoardId } from "@untie/core/model/analysis";
import { designBoardId } from "@untie/core/model/design";
import { fixedBoardId } from "@untie/core/model/fixedBoards";
import { useUntieStore } from "./index";
import type { ShortcutTarget } from "../shortcuts";

interface ShortcutsUi {
  /** 一覧ダイアログを出しているか */
  open: boolean;
  /** ボードのキー待ち (Cmd+B のあと) */
  waiting: boolean;
  /** キー待ちを (再) 開始した回数。3 秒を数え直すための印 */
  waitingSince: number;
  /** 設計の対象システムを選ぶダイアログ。選んだあとに移るボードを持つ (設計モードのキーで未定のとき) */
  systemSelect: { boardId?: string } | null;
  show: (waiting?: boolean) => void;
  close: () => void;
  setWaiting: (waiting: boolean) => void;
  closeSystemSelect: () => void;
}

export const useShortcutsUi = create<ShortcutsUi>((set) => ({
  open: false,
  waiting: false,
  waitingSince: 0,
  systemSelect: null,
  show: (waiting = false) => set((s) => ({ open: true, waiting, waitingSince: s.waitingSince + 1 })),
  close: () => set({ open: false, waiting: false }),
  setWaiting: (waiting) => set((s) => ({ waiting, waitingSince: s.waitingSince + 1 })),
  closeSystemSelect: () => set({ systemSelect: null }),
}));

/** 移り先へ移って一覧を閉じる。閲覧専用でも移れる */
export function navigateTo(target: ShortcutTarget): void {
  useShortcutsUi.getState().close();
  const st = useUntieStore.getState();
  switch (target.type) {
    case "mode":
      if (target.mode === "design" && st.ui.designSystemId === undefined) useShortcutsUi.setState({ systemSelect: {} });
      else st.setMode(target.mode);
      return;
    case "fixed":
      st.setCurrentBoard(fixedBoardId(target.layer));
      return;
    case "analysis":
      st.setCurrentBoard(analysisBoardId(target.kind));
      return;
    case "design": {
      const boardId = designBoardId(target.kind);
      if (st.ui.designSystemId === undefined) useShortcutsUi.setState({ systemSelect: { boardId } });
      else st.setCurrentBoard(boardId);
      return;
    }
    case "free":
      st.setCurrentBoard(target.boardId);
      return;
  }
}
