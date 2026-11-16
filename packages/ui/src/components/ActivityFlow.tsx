import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { linkShape, type Box } from "./activityFlowGeometry";

/** 線でつなぐ 1 本: 前の作業 → 次の作業 */
export interface FlowLine {
  id: string;
  /** 線の種類 (作業の順序・イベントから作業・作業からシステム)。色分けに使う */
  kind?: string;
  sourceId: string;
  targetId: string;
}

/** 作業のカードの探し方: セレクターと、作業の id を持つ属性の名前 */
export interface FlowCards {
  selector: string;
  attr: string;
}

function sameBoxes(a: Map<string, Box>, b: Map<string, Box>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, x] of a) {
    const y = b.get(id);
    if (!y || x.x !== y.x || x.y !== y.y || x.w !== y.w || x.h !== y.h) return false;
  }
  return true;
}

/**
 * 業務フローボードの上に重ねる、作業の順序の線 (読み取りだけ。順序はプロパティで決める)。
 * 前の作業から次の作業への矢印を、カードの位置から毎回測って描く。位置は保存しない。
 */
export function ActivityFlow({ boardRef, cards, lines }: { boardRef: RefObject<HTMLDivElement | null>; cards: FlowCards; lines: FlowLine[] }) {
  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map());
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;

  const measure = useCallback(() => {
    const board = boardRef.current;
    if (!board) return;
    const origin = board.getBoundingClientRect();
    const next = new Map<string, Box>();
    for (const el of board.querySelectorAll<HTMLElement>(cards.selector)) {
      const id = el.getAttribute(cards.attr);
      if (!id || next.has(id)) continue;
      const r = el.getBoundingClientRect();
      next.set(id, { x: r.left - origin.left + board.scrollLeft, y: r.top - origin.top + board.scrollTop, w: r.width, h: r.height });
    }
    if (!sameBoxes(boxesRef.current, next)) setBoxes(next);
  }, [boardRef, cards.selector, cards.attr]);

  // 描画のたびに測る (結果が同じなら更新しないので、繰り返しにならない)
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    // 最初の描画では、親の ref がまだ付いておらず測れないので、ここで測り直す
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    ro?.observe(board);
    window.addEventListener("resize", measure);
    board.addEventListener("scroll", measure, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      board.removeEventListener("scroll", measure, true);
    };
  }, [boardRef, measure]);

  const shapes = lines.flatMap((l) => {
    const a = boxes.get(l.sourceId);
    const b = boxes.get(l.targetId);
    return a && b ? [{ id: l.id, kind: l.kind, shape: linkShape(a, b) }] : [];
  });

  return (
    <svg className="activity-flow" width={1} height={1} aria-hidden="true" data-testid="activity-flow">
      <defs>
        <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="flow-arrow-head" />
        </marker>
      </defs>
      {shapes.map(({ id, kind, shape }) => (
        <path key={id} d={shape.d} className={`flow-line${kind ? ` is-${kind}` : ""}`} data-flow-link={id} markerEnd="url(#flow-arrow)" />
      ))}
    </svg>
  );
}
