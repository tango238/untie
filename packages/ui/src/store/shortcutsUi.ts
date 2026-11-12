import { create } from "zustand";
import { analysisBoardId } from "@untie/core/model/analysis";
import { simpleBoardId } from "@untie/core/model/workflow";
import { designBoardId } from "@untie/core/model/design";
import { fixedBoardId } from "@untie/core/model/fixedBoards";
import { useUntieStore } from "./index";
import type { ShortcutTarget } from "../shortcuts";

interface ShortcutsUi {
  /** 一覧ダイアログを出しているか */
  open: boolean;
  /** 設計の対象システムを選ぶダイアログ。選んだあとに移るボードを持つ (設計モードのキーで未定のとき) */
  systemSelect: { boardId?: string } | null;
  show: () => void;
  close: () => void;
  closeSystemSelect: () => void;
}

export const useShortcutsUi = create<ShortcutsUi>((set) => ({
  open: false,
  systemSelect: null,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
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
    case "simple":
      st.setCurrentBoard(simpleBoardId(target.kind));
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
