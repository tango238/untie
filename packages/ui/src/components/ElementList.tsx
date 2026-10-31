import { useMemo, useState } from "react";
import { issueSummaries, listableElements } from "@untie/core/model/selectors";
import { ELEMENT_KINDS, ELEMENT_KIND_LABELS, type Element, type ElementKind } from "@untie/core/model/types";
import { isFixedBoard, useUntieStore } from "../store";
import { placeElementAtCenter, selectAndReveal } from "./actions";
import { ELEMENT_DRAG_TYPE } from "./canvas/canvasApi";
import { IssueBadge } from "./IssueBadge";

export function ElementList() {
  const model = useUntieStore((s) => s.model);
  const boardId = useUntieStore((s) => s.ui.currentBoardId);
  const selection = useUntieStore((s) => s.ui.selection);
  // 要素を置けるのは自由ボードだけ (固定ボードは自動で並ぶ)
  const freeBoard = !isFixedBoard(boardId);
  const [collapsed, setCollapsed] = useState<Set<ElementKind>>(new Set());

  const onBoard = useMemo(
    () => new Set(model.boards.find((b) => b.id === boardId)?.nodes.map((n) => n.elementId) ?? []),
    [model, boardId],
  );
  const summaries = useMemo(() => issueSummaries(model), [model]);
  const groups = useMemo(() => {
    const els = listableElements(model);
    return ELEMENT_KINDS.map((kind) => ({ kind, items: els.filter((e) => e.kind === kind) }));
  }, [model]);

  const toggle = (kind: ElementKind) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const subtitle = (e: Element): string | null => {
    // 所属する業務 (上位) の名前。BUC の下位に見えないよう「業務:」を付ける
    if (e.kind === "buc") {
      const biz = model.elements.find((x) => x.id === e.businessId);
      return biz ? `業務: ${biz.name}` : null;
    }
    return null;
  };

  return (
    <aside className="element-list" aria-label="要素一覧">
      <h2 className="panel-title">要素一覧</h2>
      {groups.map(({ kind, items }) => {
        const isCollapsed = collapsed.has(kind);
        return (
          <section key={kind} className={`group kind-${kind}`}>
            <button
              type="button"
              className="group-header"
              aria-expanded={!isCollapsed}
              onClick={() => toggle(kind)}
            >
              <span className="caret">{isCollapsed ? "▸" : "▾"}</span>
              <span className="kind-dot" />
              <span className="group-name">{ELEMENT_KIND_LABELS[kind]}</span>
              <span className="group-count">{items.length}</span>
            </button>
            {!isCollapsed && (
              <ul className="rows">
                {items.map((e) => {
                  const placed = onBoard.has(e.id);
                  const summary = summaries.get(e.id);
                  const placeable = freeBoard && e.kind !== "issue";
                  const selected = selection?.type === "element" && selection.id === e.id;
                  return (
                    <li
                      key={e.id}
                      className={`row${selected ? " is-selected" : ""}`}
                      data-testid={`row-${e.id}`}
                      draggable={placeable}
                      onDragStart={(ev) => {
                        ev.dataTransfer.setData(ELEMENT_DRAG_TYPE, e.id);
                        ev.dataTransfer.effectAllowed = "copy";
                      }}
                      onContextMenu={(ev) => {
                        if (!placeable) return;
                        ev.preventDefault();
                        if (!placed) placeElementAtCenter(e.id);
                      }}
                    >
                      <button
                        type="button"
                        className="row-main"
                        onClick={() => selectAndReveal(e.id, { showProperties: true })}
                      >
                        <span className="row-name">{e.name || "(名前なし)"}</span>
                        {subtitle(e) && <span className="row-sub">{subtitle(e)}</span>}
                      </button>
                      {summary && <IssueBadge count={summary.count} maxSeverity={summary.maxSeverity} />}
                      {freeBoard && placed && (
                        <span className="placed-mark" title="現在のボードにあります" aria-label="ボードにあります">
                          ●
                        </span>
                      )}
                      {placeable && !placed && (
                        <button
                          type="button"
                          className="row-place"
                          title="このボードに置く"
                          aria-label={`${e.name || "要素"}をボードに置く`}
                          onClick={() => placeElementAtCenter(e.id)}
                        >
                          置く
                        </button>
                      )}
                    </li>
                  );
                })}
                {items.length === 0 && <li className="row-empty">なし</li>}
              </ul>
            )}
          </section>
        );
      })}
    </aside>
  );
}
