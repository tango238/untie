import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { buildActivityFlow, FLOW_BOARD_LABEL, type FlowCell, type FlowEventCell, type FlowRow, type FlowSystemCell } from "@untie/core/model/activityFlow";
import { selectReadOnly, useUntieStore } from "../../store";
import { simpleBoardId } from "@untie/core/model/workflow";
import { canvasApi } from "../canvas/canvasApi";
import { ActivityFlow } from "../ActivityFlow";
import { nameOf } from "./WorkflowBoard";
import { FlowEditBar } from "./FlowEditor";

const FLOW_CARDS = { selector: "[data-flow-card]", attr: "data-flow-card" };

/** 同じ行・同じ列に複数のカードがあるとき、行を縦に分けて重ならないようにする (列ごとの段) */
function stack<T>(items: T[], columnOf: (t: T) => number): { item: T; sub: number }[] {
  const seen = new Map<number, number>();
  return items.map((item) => {
    const c = columnOf(item);
    const sub = seen.get(c) ?? 0;
    seen.set(c, sub + 1);
    return { item, sub };
  });
}

/**
 * 業務フローボード (情報整理と詳細調整で共通)。1 枚の図に、
 * 上の山形が業務、横軸は業務ごとに作業を順に左から右へ、縦軸は担当の登場人物。
 * 一番上に外部の登場人物 (発生させるイベント)、一番下にシステム・帳票 (作業が使う操作の対象) の行を置く。
 * 作業の順序・担当・きっかけのイベントは、作業を選んだときの右のプロパティだけで決める (線を引く・ドラッグする操作は無い)。配置は保存せず、毎回モデルから組み立てる。
 */
export function FlowBoard() {
  const model = useUntieStore((s) => s.model);
  const select = useUntieStore((s) => s.select);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const selectedId = useUntieStore((s) => (s.ui.selection?.type === "element" ? s.ui.selection.id : null));
  const readOnly = useUntieStore(selectReadOnly);
  // 業務と作業を足す・直す・消すボタンは、情報整理の業務フローにだけ出す (詳細調整の業務フローは今までどおり、選ぶだけ)
  const editable = useUntieStore((s) => s.ui.currentBoardId === simpleBoardId("flow")) && !readOnly;
  const flow = useMemo(() => buildActivityFlow(model), [model]);
  const boardRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    canvasApi.focus = (elementId) => {
      document.querySelector(`[data-flow-el="${CSS.escape(elementId)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    return () => {
      canvasApi.focus = undefined;
    };
  }, []);

  const choose = (id: string) => {
    select({ type: "element", id });
    setRightPanel("properties");
  };

  // 行の段組み: 外部の登場人物・登場人物の行 → システムの行
  let gridRow = 2; // 1 行目は業務の山形
  const placed = flow.rows.map((row) => {
    const items = stack<{ cell?: FlowCell; ev?: FlowEventCell; actorId: string }>(
      [...row.cells.map((cell) => ({ cell, actorId: "" })), ...row.events.map((ev) => ({ ev, actorId: row.actor?.id ?? "" }))],
      (x) => (x.cell ?? x.ev!).column,
    );
    const span = Math.max(1, ...items.map((i) => i.sub + 1));
    const start = gridRow;
    gridRow += span;
    return { row: row as FlowRow, items, start, span };
  });
  const sysItems = stack(flow.systems, (s) => s.column);
  const sysSpan = Math.max(1, ...sysItems.map((i) => i.sub + 1));
  const sysStart = gridRow;
  const hasSystems = flow.systems.length > 0;
  // 業務が 1 つでもあれば図 (山形) を出す。案内は、業務も作業も無いときだけ
  const empty = flow.bands.length === 0 && flow.orphans.length === 0;
  const gridStyle: CSSProperties = { gridTemplateColumns: `max-content repeat(${flow.columns}, minmax(170px, 1fr))` };

  return (
    <div className="fixed-board flow-board" data-testid="flow-board" ref={boardRef}>
      <div className="fixed-head">
        <h2 className="fixed-title">{FLOW_BOARD_LABEL}</h2>
        <span className="fixed-hint">上の山形が業務です。業務ごとに、作業を順に左から右へ並べ、縦は担当の登場人物です。一番上は外部の登場人物が起こすイベント、一番下は作業が使うシステム・帳票です。作業を選ぶと、右のプロパティで「担当」「前の作業」「きっかけのイベント」を決められます (作業の順序は、このボードでだけ決めます)。{editable && "業務と作業は、右上の「＋追加」「削除」で足す・消せます。業務は「← 前へ」「後ろへ →」で並び順 (山形の左右の順) も変えられます (名前・担当・作業の順序などは、選んだときの右のプロパティで直します)。"}</span>
        {editable && <FlowEditBar />}
      </div>
      {empty && <p className="hint">{editable ? "業務も作業もまだありません。右上の「＋追加」から業務と作業を足すと、ここに並びます。" : "業務も作業もまだありません。業務と作業を足すと、ここに並びます。"}</p>}
      {!empty && (
        <div className="flow-diagram" ref={diagramRef}>
          <div className="flow-grid" style={gridStyle}>
            {flow.bands.map((b) => (
              <button key={b.business.id} type="button" data-flow-el={b.business.id} className={`flow-band${selectedId === b.business.id ? " is-selected" : ""}`} style={{ gridRow: 1, gridColumn: `${b.start + 2} / span ${b.columns}` }} onClick={() => choose(b.business.id)} aria-label={`業務 ${nameOf(b.business)}`}>
                {nameOf(b.business)}
              </button>
            ))}
            {/* 作業の無い業務は、山形の下 (最初の行) に薄い注記を出す。行の高さは変えない */}
            {flow.bands.filter((b) => b.empty).map((b) => (
              <div key={`empty:${b.business.id}`} className="flow-band-empty" style={{ gridRow: 2, gridColumn: `${b.start + 2} / span ${b.columns}` }}>
                作業はまだありません
              </div>
            ))}
            {placed.map(({ row, start, span }) => (
              <div key={`bg:${row.actor?.id ?? "none"}`} className={`flow-lane${row.external ? " is-external" : ""}`} style={{ gridRow: `${start} / span ${span}`, gridColumn: "1 / -1" }} />
            ))}
            {hasSystems && <div className="flow-lane is-system" style={{ gridRow: `${sysStart} / span ${sysSpan}`, gridColumn: "1 / -1" }} />}
            {placed.map(({ row, start, span }) => (
              <div key={`label:${row.actor?.id ?? "none"}`} className={`flow-actor${row.actor ? "" : " is-none"}${row.external ? " is-external" : ""}`} style={{ gridRow: `${start} / span ${span}`, gridColumn: 1 }}>
                {row.actor ? (
                  <button type="button" className="flow-actor-name" onClick={() => choose(row.actor!.id)} aria-label={`${row.external ? "外部の登場人物" : "登場人物"} ${nameOf(row.actor)}`}>
                    {nameOf(row.actor)}
                  </button>
                ) : (
                  "担当なし"
                )}
              </div>
            ))}
            {hasSystems && (
              <div className="flow-actor is-system" style={{ gridRow: `${sysStart} / span ${sysSpan}`, gridColumn: 1 }}>
                システム
              </div>
            )}
            {placed.flatMap(({ items, start }) =>
              items.map(({ item, sub }) =>
                item.cell ? (
                  <Card key={item.cell.activity.id} cell={item.cell} row={start + sub} selected={selectedId === item.cell.activity.id} choose={choose} />
                ) : (
                  <EventCard key={`${item.actorId}:${item.ev!.event.id}`} ev={item.ev!} actorId={item.actorId} row={start + sub} selected={selectedId === item.ev!.event.id} choose={choose} />
                ),
              ),
            )}
            {sysItems.map(({ item, sub }) => (
              <SystemCard key={item.key} cell={item} row={sysStart + sub} selected={selectedId === item.element.id} choose={choose} />
            ))}
          </div>
          <ActivityFlow boardRef={diagramRef} cards={FLOW_CARDS} lines={flow.links} />
        </div>
      )}
      {flow.hiddenEvents > 0 && <p className="fixed-hint">起点にする作業が無い外部の登場人物のイベントが {flow.hiddenEvents} 件あります (作業のプロパティの「きっかけのイベント」で結ぶと、ここに出ます)。</p>}
      {flow.orphans.length > 0 && (
        <section className="flow-orphan" aria-label="業務に属さない作業">
          <h3 className="flow-business-title">業務に属さない作業</h3>
          <p className="fixed-hint">作業を選び、プロパティの「業務」「活動」で所属を決めると、業務の帯に移ります。</p>
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
    </div>
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
        data-flow-el={activity.id}
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

function EventCard({ ev, actorId, row, selected, choose }: { ev: FlowEventCell; actorId: string; row: number; selected: boolean; choose: (id: string) => void }) {
  return (
    <div className="flow-cell" style={{ gridRow: row, gridColumn: ev.column + 2 }}>
      <button type="button" data-flow-card={`${actorId}:${ev.event.id}`} data-flow-el={ev.event.id} className={`flow-card is-event${selected ? " is-selected" : ""}`} aria-current={selected ? "true" : undefined} aria-label={`イベント ${nameOf(ev.event)}`} onClick={() => choose(ev.event.id)}>
        <span className="flow-kind">イベント</span>
        <span className="wf-name">{nameOf(ev.event)}</span>
      </button>
    </div>
  );
}

function SystemCard({ cell, row, selected, choose }: { cell: FlowSystemCell; row: number; selected: boolean; choose: (id: string) => void }) {
  const label = cell.element.kind === "system" ? "システム" : "帳票";
  return (
    <div className="flow-cell" style={{ gridRow: row, gridColumn: cell.column + 2 }}>
      <button type="button" data-flow-card={cell.key} data-flow-el={cell.element.id} className={`flow-card is-system${selected ? " is-selected" : ""}`} aria-current={selected ? "true" : undefined} aria-label={`${label} ${nameOf(cell.element)}`} onClick={() => choose(cell.element.id)}>
        <span className="flow-kind">{label}</span>
        <span className="wf-name">{nameOf(cell.element)}</span>
      </button>
    </div>
  );
}
