import { useMemo } from "react";
import { designBoardId } from "@untie/core/model/design";
import { fixedLayerOf, FIXED_LAYER_LABELS } from "@untie/core/model/fixedBoards";
import type { ResolvedDomain } from "@untie/core/model/domainResolve";
import type { DesignDomainSelection } from "@untie/core/model/domainScope";
import type { CommandResult } from "@untie/core/model/commands";
import type { Element, UntieModel } from "@untie/core/model/types";
import { selectReadOnly, useUntieStore } from "../../store";
import { revealOnFixedBoard } from "../actions";
import type { ElementClick } from "../analysis/analysisParts";

/** このボードに出ているものの中で、その要素を選ぶときの選択 (出ていなければ null) */
export function domainSelectionOf(r: ResolvedDomain, element: Element): DesignDomainSelection | null {
  if (element.kind === "usecase") {
    const command = r.commands.find((c) => c.candidate?.usecase.id === element.id);
    if (command) return { kind: "command", id: command.key };
    if (r.scope.queries.some((q) => q.usecase.id === element.id)) return { kind: "query", id: element.id };
  }
  if (element.kind === "information") {
    const aggregate = r.aggregates.find((a) => a.root.id === element.id || a.members.some((m) => m.id === element.id));
    if (aggregate) return { kind: "aggregate", id: aggregate.key };
  }
  if (element.kind === "event") {
    const event = r.events.find((e) => e.scoped?.row.event.id === element.id);
    if (event) return { kind: "event", id: event.key };
  }
  if (element.kind === "context") {
    const context = r.contexts.find((c) => c.key === element.id) ?? r.contexts.find((c) => c.saved?.contextIds.includes(element.id));
    if (context) return { kind: "context", id: context.key };
  }
  return null;
}

/** 分析のどの固定ボードで見られるかの文言 (「分析の操作ボードで見る」など)。固定ボードの無い種類は「分析で見る」 */
export function revealLabel(element: Pick<Element, "kind">): string {
  const layer = fixedLayerOf(element.kind);
  return layer ? `分析の${FIXED_LAYER_LABELS[layer]}ボードで見る` : "分析で見る";
}

/**
 * ドメインボードの中で要素名を押したとき: このボードに出ている操作・情報・イベント・コンテキストなら、ボードの中で選ぶ。
 * それ以外 (作業・アクター・状態など) は、分析のその要素の固定ボードへ移る (設計モードを出るので、名前に「↗」と行き先を添える)
 */
export function useDomainElementClick(scope: ResolvedDomain): ElementClick {
  const select = useUntieStore((s) => s.selectDesignDomain);
  return useMemo(
    () => ({
      onClick: (element: Element) => {
        const sel = domainSelectionOf(scope, element);
        if (sel) select(sel);
        else revealOnFixedBoard(element.id);
      },
      leaves: (element: Element) => (domainSelectionOf(scope, element) ? null : revealLabel(element)),
    }),
    [scope, select],
  );
}

/** ドメインモデルを変える: 閲覧専用かと、コマンドを当てる関数 (失敗したら理由をトーストに出す。成功なら結果を返す) */
export function useDomainEdit(): { readOnly: boolean; run: <T>(command: (model: UntieModel) => CommandResult<T>) => (CommandResult<T> & { ok: true }) | null } {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const readOnly = useUntieStore(selectReadOnly);
  return {
    readOnly,
    run: (command) => {
      const r = dispatch(command);
      if (!r.ok) {
        pushToast(r.reason, "error");
        return null;
      }
      return r;
    },
  };
}

/** ドメインボードへ移って選ぶ (検証の行・コンテキストマップから)。別のシステムのものなら、そのシステムの設計へ切り替える */
export function revealDomainSelection(selection: DesignDomainSelection, systemId?: string): void {
  const st = useUntieStore.getState();
  if (systemId !== undefined && systemId !== st.ui.designSystemId) st.enterDesign(systemId, designBoardId("domain"));
  else st.setCurrentBoard(designBoardId("domain"));
  useUntieStore.getState().selectDesignDomain(selection);
}
