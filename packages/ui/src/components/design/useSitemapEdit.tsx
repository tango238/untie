import { useState, type ReactNode } from "react";
import { addSitemapScreens, designScreenName, removeSitemapScreens, screensWithDesign } from "@untie/core/model/sitemap";
import type { DesignScreen } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * サイトマップの画面の追加・削除。左の木のチェックと、プロパティの「サイトマップから外す」が同じ規則で使う。
 * 追加は画面と導いた遷移を 1 回の変更で足す。削除は、画面 UI・項目の対応 (view / bindings) を持つ画面が含まれるとき確認ダイアログを出す
 * (dialog を画面のどこかに置く)。画面が消えると、それを指す遷移・ナビの項目も消える
 */
export function useSitemapEdit(): { add: (sources: DesignScreen["source"][]) => void; remove: (ids: string[]) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<{ ids: string[]; names: string[] } | null>(null);

  const add = (sources: DesignScreen["source"][]) => {
    const st = useUntieStore.getState();
    const systemId = st.ui.designSystemId;
    if (!systemId || sources.length === 0) return;
    const r = st.dispatch((m) => addSitemapScreens(m, systemId, sources));
    if (!r.ok) st.pushToast(r.reason, "error");
  };

  const doRemove = (ids: string[]) => {
    const st = useUntieStore.getState();
    const systemId = st.ui.designSystemId;
    // 確認のあいだに他の人が外した画面は除く
    const present = new Set(st.model.designs.find((d) => d.systemId === systemId)?.screens.map((x) => x.id));
    const live = ids.filter((id) => present.has(id));
    if (!systemId || live.length === 0) return;
    const r = st.dispatch((m) => removeSitemapScreens(m, systemId, live));
    if (!r.ok) st.pushToast(r.reason, "error");
  };

  const remove = (ids: string[]) => {
    const { model, ui } = useUntieStore.getState();
    const design = model.designs.find((d) => d.systemId === ui.designSystemId);
    const targets = (design?.screens ?? []).filter((s) => ids.includes(s.id));
    if (targets.length === 0) return;
    const designed = screensWithDesign(targets);
    if (designed.length === 0) doRemove(targets.map((s) => s.id));
    else setPending({ ids: targets.map((s) => s.id), names: designed.map((s) => designScreenName(model, s)) });
  };

  const dialog = pending ? (
    <ConfirmDialog
      title="画面をサイトマップから外す"
      message="次の画面の設計も一緒に消えます。"
      details={pending.names}
      confirmLabel="外す"
      danger
      onConfirm={() => {
        doRemove(pending.ids);
        setPending(null);
      }}
      onCancel={() => setPending(null)}
    />
  ) : null;

  return { add, remove, dialog };
}
