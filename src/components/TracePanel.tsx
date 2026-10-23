import { useMemo } from "react";
import { traceToActors, type TraceProblem } from "../model/trace";
import { ELEMENT_KIND_LABELS, type Element } from "../model/types";
import { useUntieStore } from "../store";
import { revealOnFixedBoard } from "./actions";

/** すべての要素がアクター / 外部アクターまで辿れるかを、途切れている箇所ごとに出す */
export function TracePanel() {
  const model = useUntieStore((s) => s.model);
  const result = useMemo(() => traceToActors(model), [model]);
  const byId = useMemo(() => new Map(model.elements.map((e) => [e.id, e])), [model]);
  const breaks = result.problems.filter((p) => p.isBreak);
  const downstreamOf = (breakId: string) =>
    result.problems.filter((p) => !p.isBreak && p.breakIds.includes(breakId)).map((p) => byId.get(p.elementId)!);

  return (
    <aside className="trace-panel" aria-label="検証">
      <h2 className="panel-title">検証: アクターまで辿れるか</h2>
      {result.problems.length === 0 ? (
        <p className="trace-summary is-ok">すべての要素 ({result.total} 件) がアクター／外部アクターに辿り着けます。</p>
      ) : (
        <p className="trace-summary">
          {result.total} 件中 {result.problems.length} 件がアクター／外部アクターに辿り着けません。途切れている箇所は {breaks.length} 件です。
        </p>
      )}
      <ul className="trace-rows">
        {breaks.map((p) => (
          <BreakRow key={p.elementId} problem={p} element={byId.get(p.elementId)!} downstream={downstreamOf(p.elementId)} />
        ))}
      </ul>
      <details className="trace-rule">
        <summary>辿り方</summary>
        <ul>
          <li>業務 ← 主担当のアクター</li>
          <li>活動 ← 業務</li>
          <li>作業 ← 担当のアクター／外部アクター、または活動・業務</li>
          <li>操作 ← 使う作業</li>
          <li>情報 ← 扱う操作、または関連する情報</li>
          <li>コンテキスト ← 入っている情報</li>
          <li>システム ← 取得元・保存先として結んだ情報</li>
          <li>条件 ← 判断に使う操作</li>
          <li>バリエーション ← 種別にしている情報・条件</li>
          <li>状態 ← 結んだ操作・条件</li>
        </ul>
        <p className="hint">課題は対象の要素に付くものなので、検証の対象にしません。</p>
      </details>
    </aside>
  );
}

function ElementLink({ element }: { element: Element }) {
  return (
    <button
      type="button"
      className={`chip-link kind-${element.kind}`}
      title="この要素を編集できる固定ボードへ移る"
      onClick={() => revealOnFixedBoard(element.id)}
    >
      <span className="kind-dot" />
      {element.name || "(名前なし)"}
    </button>
  );
}

function BreakRow({ problem, element, downstream }: { problem: TraceProblem; element: Element; downstream: Element[] }) {
  return (
    <li className="trace-row" data-testid={`trace-${element.id}`}>
      <div className="trace-head">
        <span className="relation-kind">{ELEMENT_KIND_LABELS[element.kind]}</span>
        <ElementLink element={element} />
      </div>
      <div className="trace-reason">{problem.reason}</div>
      {downstream.length > 0 && (
        <div className="trace-downstream">
          <span className="hint">この先で辿り着けない要素 ({downstream.length}):</span>
          {downstream.map((d) => (
            <ElementLink key={d.id} element={d} />
          ))}
        </div>
      )}
    </li>
  );
}
