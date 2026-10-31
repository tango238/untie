import { useMemo } from "react";
import { moveToContext } from "@untie/core/model/commands";
import { contextNotices, type ContextNotice } from "@untie/core/model/contexts";
import { issuesByScope } from "@untie/core/model/selectors";
import { traceToActors, type TraceProblem } from "@untie/core/model/trace";
import { ELEMENT_KIND_LABELS, type Element } from "@untie/core/model/types";
import { selectReadOnly, useUntieStore } from "../store";
import { revealOnFixedBoard } from "./actions";

/**
 * すべての要素が担い手 (アクター / 外部アクター / システム) まで辿れるかを、途切れている箇所ごとに出す。
 * 直す場所で迷わないよう、リンクにするのは途切れ箇所の要素だけにし、その先の要素は件数だけを出す
 */
export function TracePanel() {
  const model = useUntieStore((s) => s.model);
  const result = useMemo(() => traceToActors(model), [model]);
  const notices = useMemo(() => contextNotices(model), [model]);
  const unsorted = useMemo(() => issuesByScope(model).unsorted, [model]);
  const byId = useMemo(() => new Map(model.elements.map((e) => [e.id, e])), [model]);
  const breaks = result.problems.filter((p) => p.isBreak);
  const downstreamOf = (breakId: string) =>
    result.problems.filter((p) => !p.isBreak && p.breakIds.includes(breakId)).map((p) => byId.get(p.elementId)!);

  return (
    <aside className="trace-panel" aria-label="検証">
      <h2 className="panel-title">検証: 担い手まで辿れるか</h2>
      {result.problems.length === 0 ? (
        <p className="trace-summary is-ok">すべての要素 ({result.total} 件) が担い手 (アクター／外部アクター／システム) に辿り着けます。</p>
      ) : (
        <p className="trace-summary">
          {result.total} 件中 {result.problems.length} 件が担い手 (アクター／外部アクター／システム) に辿り着けません。途切れている箇所は {breaks.length} 件です。
        </p>
      )}
      <ul className="trace-rows">
        {breaks.map((p) => (
          <BreakRow key={p.elementId} problem={p} element={byId.get(p.elementId)!} downstream={downstreamOf(p.elementId)} />
        ))}
      </ul>
      {notices.length > 0 && (
        <section className="trace-info" aria-label="情報">
          <h3 className="trace-info-title">情報: コンテキストの所属 ({notices.length})</h3>
          <ul className="trace-rows">
            {notices.map((n) => (
              <NoticeRow key={n.elementId} notice={n} element={byId.get(n.elementId)!} contextName={n.suggestedId ? byId.get(n.suggestedId)?.name ?? "" : ""} />
            ))}
          </ul>
        </section>
      )}
      {unsorted.length > 0 && (
        <section className="trace-info" aria-label="未整理の課題">
          <h3 className="trace-info-title">情報: 対象のない課題 ({unsorted.length})</h3>
          <p className="hint">対象 (登場人物か業務・作業・操作) を付けると、全体的な課題か具体的な課題に分かれます。</p>
          <ul className="trace-rows">
            {unsorted.map((i) => (
              <li key={i.id} className="trace-row is-info" data-testid={`unsorted-${i.id}`}>
                <div className="trace-head">
                  <span className="relation-kind">{ELEMENT_KIND_LABELS[i.kind]}</span>
                  <ElementLink element={i} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <details className="trace-rule">
        <summary>辿り方</summary>
        <ul>
          <li>業務 ← 主担当のアクター</li>
          <li>活動 ← 業務</li>
          <li>作業 ← 担当のアクター／外部アクター／システム (必須。業務に属していても担当が無ければ途切れ)</li>
          <li>操作 ← 使う作業</li>
          <li>情報 ← 扱う操作、または関連する情報</li>
          <li>コンテキスト ← 入っている情報・状態・条件・バリエーション</li>
          <li>システム: 担い手なので辿り着く先。ただし作業の担当にも情報の置き場所にもなっていなければ途切れ</li>
          <li>帳票 ← 取得元・保存先として結んだ情報</li>
          <li>条件 ← 判断に使う操作</li>
          <li>バリエーション ← 種別にしている情報・条件</li>
          <li>状態 ← 結んだ操作・条件</li>
        </ul>
        <p className="hint">課題は対象の要素に付くものなので、検証の対象にしません。</p>
      </details>
    </aside>
  );
}

function NoticeRow({ notice, element, contextName }: { notice: ContextNotice; element: Element; contextName: string }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const readOnly = useUntieStore(selectReadOnly);
  return (
    <li className="trace-row is-info" data-testid={`notice-${element.id}`}>
      <div className="trace-head">
        <span className="relation-kind">{ELEMENT_KIND_LABELS[element.kind]}</span>
        <ElementLink element={element} />
      </div>
      <div className="trace-notice">{notice.message}</div>
      {notice.suggestedId && !readOnly && (
        <div>
          <button
            type="button"
            className="chip-link"
            onClick={() => dispatch((m) => moveToContext(m, { elementId: element.id, contextId: notice.suggestedId }))}
          >
            「{contextName || "(名前なし)"}」に移す
          </button>
        </div>
      )}
    </li>
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
      {problem.fix && <div className="trace-fix">{problem.fix}</div>}
      {downstream.length > 0 && (
        <div className="trace-downstream hint" title={downstream.map((d) => d.name || "(名前なし)").join("、")}>
          この箇所の先で、ほかに {downstream.length} 件 ({downstreamKinds(downstream)}) も辿り着けません。
        </div>
      )}
    </li>
  );
}

/** 「作業 1・操作 2」のような種類ごとの件数 */
function downstreamKinds(elements: Element[]): string {
  const counts = new Map<string, number>();
  for (const e of elements) counts.set(ELEMENT_KIND_LABELS[e.kind], (counts.get(ELEMENT_KIND_LABELS[e.kind]) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k} ${n}`).join("・");
}
