import { useEffect } from "react";
import { hasUnsavedChanges, useUntieStore } from "../store";
import { confirmDiscard, isTauri } from "./file";

/** 保存していない変更があるときに、ウィンドウを閉じる前に確かめる */
export function useCloseGuard() {
  useEffect(() => {
    if (isTauri()) {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        const off = await getCurrentWindow().onCloseRequested(async (event) => {
          if (!hasUnsavedChanges(useUntieStore.getState())) return;
          if (!(await confirmDiscard("保存していない変更があります。破棄して閉じますか？"))) event.preventDefault();
        });
        if (disposed) off();
        else unlisten = off;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges(useUntieStore.getState())) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}
