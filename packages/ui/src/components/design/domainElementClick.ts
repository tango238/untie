import { useMemo } from "react";
import { fixedLayerOf, FIXED_LAYER_LABELS } from "@untie/core/model/fixedBoards";
import type { DesignDomainSelection, DomainScope } from "@untie/core/model/domainScope";
import type { Element } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { revealOnFixedBoard } from "../actions";
import type { ElementClick } from "../analysis/analysisParts";

/** しぼった範囲の中で、その要素を選ぶときの選択 (範囲の外なら null) */
export function domainSelectionOf(scope: DomainScope, element: Element): DesignDomainSelection | null {
  if (element.kind === "usecase") {
    if (scope.commands.some((c) => c.usecase.id === element.id)) return { kind: "command", id: element.id };
    if (scope.queries.some((q) => q.usecase.id === element.id)) return { kind: "query", id: element.id };
  }
  if (element.kind === "information" && scope.contexts.some((c) => c.aggregates.some((a) => a.candidate.information.id === element.id))) return { kind: "aggregate", id: element.id };
  if (element.kind === "event" && scope.events.some((e) => e.row.event.id === element.id)) return { kind: "event", id: element.id };
  if (element.kind === "context" && scope.contexts.some((c) => c.context?.id === element.id)) return { kind: "context", id: element.id };
  return null;
}

/** 分析のどの固定ボードで見られるかの文言 (「分析の操作ボードで見る」など)。固定ボードの無い種類は「分析で見る」 */
export function revealLabel(element: Pick<Element, "kind">): string {
  const layer = fixedLayerOf(element.kind);
  return layer ? `分析の${FIXED_LAYER_LABELS[layer]}ボードで見る` : "分析で見る";
}

/**
 * ドメインボードの中で要素名を押したとき: しぼった範囲にある操作・情報・イベント・コンテキストなら、ボードの中で選ぶ。
 * それ以外 (作業・アクター・状態など) は、分析のその要素の固定ボードへ移る (設計モードを出るので、名前に「↗」と行き先を添える)
 */
export function useDomainElementClick(scope: DomainScope): ElementClick {
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
