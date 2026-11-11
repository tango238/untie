// 分析ボードで共通に使う部品
import { createContext, useContext } from "react";
import { ELEMENT_KIND_LABELS, type Element } from "@untie/core/model/types";
import { useUntieStore } from "../../store";

/**
 * 要素名を押したときの動きを差し替える。既定 (null) は、要素を選んでプロパティ欄に出す (分析ボード)。
 * 設計モードのドメインボードは、ボードの中の選択に読み替えるか、分析のボードへ移る
 */
export interface ElementClick {
  onClick: (element: Element) => void;
  /** 押すとボードの外へ移るなら、その行き先の文言 (名前に「↗」を添え、title に出す)。移らなければ null */
  leaves?: (element: Element) => string | null;
}
export const ElementClickContext = createContext<ElementClick | null>(null);

/** 要素名。クリックで選択してプロパティ欄に出す (ElementClickContext があればそれに任せる) */
export function El({ element, plain }: { element: Element | undefined; plain?: boolean }) {
  const click = useContext(ElementClickContext);
  const select = useUntieStore((s) => s.select);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const selected = useUntieStore((s) => s.ui.selection?.type === "element" && s.ui.selection.id === element?.id);
  if (!element) return null;
  const leaves = click?.leaves?.(element) ?? null;
  return (
    <button
      type="button"
      className={`an-el kind-${element.kind}${plain ? " is-plain" : ""}${selected ? " is-selected" : ""}`}
      data-analysis-el={element.id}
      title={`${ELEMENT_KIND_LABELS[element.kind]}: ${element.name}${leaves ? ` (${leaves})` : ""}`}
      onClick={() => {
        if (click) {
          click.onClick(element);
          return;
        }
        select({ type: "element", id: element.id });
        setRightPanel("properties");
      }}
    >
      {!plain && <span className="kind-dot" />}
      {element.name || "(名前なし)"}
      {leaves && (
        <span className="an-leaves" aria-hidden="true">
          ↗
        </span>
      )}
    </button>
  );
}
