import { domainReferences } from "@untie/core/model/domain";
import { designReferences } from "@untie/core/model/selectors";
import type { Element, UntieModel } from "@untie/core/model/types";
import { impactLines, removalImpact } from "@untie/core/model/workflow";
import { isDevMode } from "../devMode";
import { ConfirmDialog } from "./ConfirmDialog";

/** 削除の前に確かめる内容。impact は、つながっていて一緒に巻き込まれるもの、refs は、一緒に消える設計データ */
export interface RemovalPlan {
  impact: string[];
  refs: string[];
}

/**
 * 要素を消すときに確かめる内容。確かめるものが無ければ null (そのまま消してよい)。
 * withImpact が真のとき (情報整理の画面) は、つながっているもの (子・操作の画面など) も数える。
 * 内部のドメインモデルから消える・外れるものは、開発モードでなければ 1 行にまとめる (集約などの言葉を出さない)
 */
export function planRemoval(model: UntieModel, elementId: string, withImpact: boolean): RemovalPlan | null {
  const internal = domainReferences(model, elementId);
  const refs = [...designReferences(model, elementId), ...(isDevMode() ? internal : internal.length > 0 ? ["実装のための内部の設計 (この要素を使っているところ)"] : [])];
  const impact = withImpact ? impactLines(removalImpact(model, elementId)) : [];
  return refs.length > 0 || impact.length > 0 ? { impact, refs } : null;
}

/** 削除の確認ダイアログ (プロパティの「削除」と、業務フローの「削除」で共通) */
export function RemovalConfirmDialog({ element, plan, onCancel, onConfirm }: { element: Pick<Element, "name">; plan: RemovalPlan; onCancel: () => void; onConfirm: () => void }) {
  const name = element.name || "(名前なし)";
  return (
    <ConfirmDialog
      title="削除の確認"
      message={
        plan.impact.length > 0
          ? `「${name}」を削除します。つながっているものは次のとおりです。${plan.refs.length > 0 ? "このほか、次の設計データも一緒に消えます。" : ""}`
          : `「${name}」を削除すると、次の設計データも一緒に消えます。`
      }
      details={plan.impact.length > 0 && plan.refs.length > 0 ? plan.impact : [...plan.impact, ...plan.refs]}
      detailGroups={plan.impact.length > 0 && plan.refs.length > 0 ? [{ title: "消える設計データ", items: plan.refs }] : undefined}
      confirmLabel="削除する"
      danger
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
