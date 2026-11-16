import { useEffect, useMemo, useRef } from "react";
import { buildActivityFlow, FLOW_BOARD_LABEL, type FlowBusiness, type FlowCell } from "@untie/core/model/activityFlow";
import { useUntieStore } from "../../store";
import { canvasApi } from "../canvas/canvasApi";
import { ActivityFlow } from "../ActivityFlow";
import { nameOf } from "./WorkflowBoard";

const FLOW_CARDS = { selector: "[data-flow-card]", attr: "data-flow-card" };

/**
 * 業務フローボード (分析（簡易）と分析（詳細）で共通)。
 * 横軸は業務の枠の中で、作業を順に左から右へつなぎ、縦軸は担当の登場人物。
 * 作業の順序と担当は、作業を選んだときの右のプロパティだけで決める (線を引く・ドラッグする操作は無い)。配置は保存せず、毎回モデルから組み立てる。
 */
export function FlowBoard() {
  const model = useUntieStore((s) => s.model);
  const select = useUntieStore((s) => s.select);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const selectedId = useUntieStore((s) => (s.ui.selection?.type === "element" ? s.ui.selection.id : null));
  const flow = useMemo(() => buildActivityFlow(model), [model]);
  const boardRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => flow.businesses.flatMap((b) => b.links), [flow]);

  useEffect(() => {
    canvasApi.focus = (elementId) => {
      document.querySelector(`[data-flow-card="${CSS.escape(elementId)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    return () => {
      canvasApi.focus = undefined;
    };
  }, []);

  const choose = (id: string) => {
    select({ type: "element", id });
    setRightPanel("properties");
  };
  const empty = flow.businesses.every((b) => b.rows.length === 0) && flow.orphans.length === 0;

  return (
    <div className="fixed-board flow-board" data-testid="flow-board" ref={boardRef}>
      <div className="fixed-head">
        <h2 className="fixed-title">{FLOW_BOARD_LABEL}</h2>
        <span className="fixed-hint">業務ごとの枠に、作業を順に左から右へ並べます。縦は担当の登場人物です。作業を選ぶと、右のプロパティで「担当」と「前の作業」を決められます (作業の順序は、このボードでだけ決めます)。</span>
      </div>
      {empty && <p className="hint">作業がまだありません。業務一覧で業務と作業を書くと、ここに並びます。</p>}
      {flow.businesses.filter((b) => b.rows.length > 0).map((b) => (
        <BusinessFlow key={b.business.id} box={b} selectedId={selectedId} choose={choose} />
      ))}
      {flow.orphans.length > 0 && (
        <section className="flow-business" aria-label="業務に属さない作業">
          <h3 className="flow-business-title">業務に属さない作業</h3>
          <p className="fixed-hint">作業を選び、プロパティの「業務」「活動」で所属を決めると、業務の枠に移ります。</p>
          <ul className="flow-orphans">
            {flow.orphans.map((a) => (
              <li key={a.id}>
                <button type="button" className={`flow-card${selectedId === a.id ? " is-selected" : ""}`} onClick={() => choose(a.id)}>
                  {nameOf(a)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ActivityFlow boardRef={boardRef} cards={FLOW_CARDS} lines={lines} />
    </div>
  );
}

function BusinessFlow({ box, selectedId, choose }: { box: FlowBusiness; selectedId: string | null; choose: (id: string) => void }) {
  // 同じ行・同じ列に複数の作業があるときは、その行を縦に分けて重ならないようにする
  let gridRow = 1;
  const placed = box.rows.map((row) => {
    const seen = new Map<number, number>();
    const items = row.cells.map((c) => {
      const sub = seen.get(c.column) ?? 0;
      seen.set(c.column, sub + 1);
      return { cell: c, sub };
    });
    const span = Math.max(1, ...items.map((i) => i.sub + 1));
    const start = gridRow;
    gridRow += span;
    return { row, items, start, span };
  });
  return (
    <section className="flow-business" aria-label={`業務 ${nameOf(box.business)}`}>
      <h3 className="flow-business-title">
        <button type="button" className="flow-business-name" onClick={() => choose(box.business.id)}>
          <span className="wf-kind">業務</span> {nameOf(box.business)}
        </button>
      </h3>
      <div className="flow-grid" style={{ gridTemplateColumns: `max-content repeat(${box.columns}, minmax(150px, 1fr))` }}>
        {placed.map(({ row, start, span }) => (
          <div key={row.actor?.id ?? "none"} className={`flow-actor${row.actor ? "" : " is-none"}`} style={{ gridRow: `${start} / span ${span}`, gridColumn: 1 }}>
            {row.actor ? nameOf(row.actor) : "担当なし"}
          </div>
        ))}
        {placed.flatMap(({ items, start }) => items.map(({ cell, sub }) => <Card key={cell.activity.id} cell={cell} row={start + sub} selected={selectedId === cell.activity.id} choose={choose} />))}
      </div>
    </section>
  );
}

function Card({ cell, row, selected, choose }: { cell: FlowCell; row: number; selected: boolean; choose: (id: string) => void }) {
  const { activity } = cell;
  const names = cell.assignees.map(nameOf);
  return (
    <div className="flow-cell" style={{ gridRow: row, gridColumn: cell.column + 2 }}>
      <button
        type="button"
        data-flow-card={activity.id}
        className={`flow-card${selected ? " is-selected" : ""}${cell.unordered ? " is-unordered" : ""}`}
        aria-current={selected ? "true" : undefined}
        aria-label={`作業 ${nameOf(activity)} (${names.length > 0 ? `担当: ${names.join("、")}` : "担当なし"}${cell.triggerEvents.length > 0 ? `、きっかけ: ${cell.triggerEvents.map(nameOf).join("、")}` : ""}${cell.unordered ? "、順序は未設定" : ""})`}
        onClick={() => choose(activity.id)}
      >
        <span className="wf-name">{nameOf(activity)}</span>
        {names.length > 1 && <span className="wf-assignees">担当: {names.join("、")}</span>}
        {cell.triggerEvents.length > 0 && <span className="flow-trigger">きっかけ: {cell.triggerEvents.map(nameOf).join("、")}</span>}
        {cell.unordered && <span className="flow-unordered">順序は未設定</span>}
      </button>
    </div>
  );
}
