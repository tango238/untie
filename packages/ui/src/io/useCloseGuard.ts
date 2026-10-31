import { useEffect } from "react";
import { getPlatform } from "../platform";
import { hasUnsavedChanges, useUntieStore } from "../store";

/** 保存していない変更があるときに、ウィンドウ (タブ) を閉じる前に確かめる。確かめ方は Platform が決める */
export function useCloseGuard() {
  useEffect(() => getPlatform().onCloseRequested(() => hasUnsavedChanges(useUntieStore.getState())), []);
}
