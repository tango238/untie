import { useEffect } from "react";
import type { CommandResult } from "@untie/core/model/commands";
import type { UntieModel } from "@untie/core/model/types";
import { selectReadOnly, useUntieStore } from "../../store";
import { canvasApi } from "../canvas/canvasApi";

/**
 * 分析（簡易）のボード (システム操作・情報と状態) に共通の部品: 選択・足したあとの動き・要素へのスクロール。
 * 足した直後は、それを選んで右のプロパティに出し、名前の入力へフォーカスする
 */
export function useBoardKit() {
  const model = useUntieStore((s) => s.model);
  const readOnly = useUntieStore(selectReadOnly);
  const dispatch = useUntieStore((s) => s.dispatch);
  const select = useUntieStore((s) => s.select);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const requestNameFocus = useUntieStore((s) => s.requestNameFocus);
  const pushToast = useUntieStore((s) => s.pushToast);
  const selectedId = useUntieStore((s) => (s.ui.selection?.type === "element" ? s.ui.selection.id : null));

  // 要素の場所へのスクロール (選択やリンクからの移動で呼ばれる)
  useEffect(() => {
    canvasApi.focus = (elementId) => {
      document.querySelector(`[data-workflow-el="${CSS.escape(elementId)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    return () => {
      canvasApi.focus = undefined;
    };
  }, []);

  const choose = (id: string) => {
    select({ type: "element", id });
    setRightPanel("properties");
  };
  /** コマンドを実行し、足したものを選んで名前の入力へ移る。失敗したら理由をトーストに出す */
  const run = (command: (m: UntieModel) => CommandResult<{ id: string }>) => {
    const r = dispatch(command);
    if (!r.ok) {
      pushToast(r.reason, "error");
      return;
    }
    choose(r.id);
    requestNameFocus();
    setTimeout(() => canvasApi.focus?.(r.id), 50);
  };
  return { model, readOnly, selectedId, choose, run };
}
