// 分析ボードで共通に使う部品
import { ELEMENT_KIND_LABELS, type Element } from "@untie/core/model/types";
import { useUntieStore } from "../../store";

/** 要素名。クリックで選択してプロパティ欄に出す */
export function El({ element, plain }: { element: Element | undefined; plain?: boolean }) {
  const select = useUntieStore((s) => s.select);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const selected = useUntieStore((s) => s.ui.selection?.type === "element" && s.ui.selection.id === element?.id);
  if (!element) return null;
  return (
    <button
      type="button"
      className={`an-el kind-${element.kind}${plain ? " is-plain" : ""}${selected ? " is-selected" : ""}`}
      data-analysis-el={element.id}
      title={`${ELEMENT_KIND_LABELS[element.kind]}: ${element.name}`}
      onClick={() => {
        select({ type: "element", id: element.id });
        setRightPanel("properties");
      }}
    >
      {!plain && <span className="kind-dot" />}
      {element.name || "(名前なし)"}
    </button>
  );
}
