import type { ReactNode } from "react";
import { cachedDomainScope } from "@untie/core/model/domainCache";
import { AGGREGATE_ROLE_LABELS } from "@untie/core/model/domainModel";
import type { DesignDomainSelection, DomainScope, ScopedAggregate, ScopedContext } from "@untie/core/model/domainScope";
import { useUntieStore } from "../../store";

const same = (a: DesignDomainSelection | undefined, b: DesignDomainSelection) => !!a && a.kind === b.kind && (a.id ?? null) === (b.id ?? null);

/** 要素が主役の問いの数 (主役の要素 id → 数) */
function questionCounts(scope: DomainScope): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of scope.notices) {
    const id = n.elementIds[0];
    if (n.level === "question" && id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function QuestionBadge({ counts, id }: { counts: Map<string, number>; id: string | null | undefined }) {
  const n = id ? (counts.get(id) ?? 0) : 0;
  return n > 0 ? (
    <span className="relation-badge is-question" title={`この要素についての問いが ${n} 件あります`}>
      問い {n}
    </span>
  ) : null;
}

function Row({ sel, label, current, children, nested }: { sel: DesignDomainSelection; label: string; current: DesignDomainSelection | undefined; children?: ReactNode; nested?: boolean }) {
  const select = useUntieStore((s) => s.selectDesignDomain);
  const on = same(current, sel);
  return (
    <li className={`screen-pick-row${on ? " is-selected" : ""}${nested ? " is-nested" : ""}`} data-domain-row={`${sel.kind}:${sel.id ?? ""}`}>
      <button type="button" className="screen-pick-name" aria-current={on ? "true" : undefined} onClick={() => select(sel)}>
        {label}
      </button>
      {children}
    </li>
  );
}

/** 集約の印: このシステムで書くなら「ルート」「集約」、書かないなら「参照」。ほかのシステムでも書くなら「ほかでも書く」 */
function AggregateBadges({ a }: { a: ScopedAggregate }) {
  const role = a.writtenHere ? (a.candidate.role === "lifecycle" ? "ルート" : "集約") : "参照";
  const title = a.writtenHere ? AGGREGATE_ROLE_LABELS[a.candidate.role] : `このシステムでは書かない${a.otherWriterSystems.length > 0 ? ` (書くシステム: ${a.otherWriterSystems.map((s) => s.name).join("・")})` : ""}`;
  return (
    <>
      <span className={`an-role role-agg-${a.writtenHere ? a.candidate.role : "reference"}`} title={title}>
        {role}
      </span>
      {a.writtenHere && a.otherWriterSystems.length > 0 && (
        <span className="an-role role-shared" title={`ほかのシステムでも書く: ${a.otherWriterSystems.map((s) => s.name).join("・")}`}>
          ほかでも書く
        </span>
      )}
    </>
  );
}

function ContextList({ contexts, current, counts }: { contexts: ScopedContext[]; current: DesignDomainSelection | undefined; counts: Map<string, number> }) {
  return (
    <ul className="screen-pick">
      {contexts.map((c) => (
        <li key={c.context?.id ?? "none"} className="domain-context-group">
          <ul className="screen-pick">
            <Row sel={{ kind: "context", id: c.context?.id ?? null }} label={c.context?.name ?? "未分類"} current={current}>
              <QuestionBadge counts={counts} id={c.context?.id} />
            </Row>
            {c.aggregates.map((a) => (
              <Row key={a.candidate.information.id} sel={{ kind: "aggregate", id: a.candidate.information.id }} label={a.candidate.information.name} current={current} nested>
                <AggregateBadges a={a} />
                <QuestionBadge counts={counts} id={a.candidate.information.id} />
              </Row>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** 設計モードのドメインボードの左ペイン: コンテキスト (と集約。自分と読むだけの上流に分ける)・コマンド・問い合わせ・イベントの一覧。押すとボードで選ぶ。問いの数の印も出す */
export function DomainLeftPane() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const current = useUntieStore((s) => s.ui.designDomain);
  const scope = cachedDomainScope(model, systemId);
  const counts = questionCounts(scope);
  const own = scope.contexts.filter((c) => c.role === "own");
  const upstream = scope.contexts.filter((c) => c.role === "upstream");
  return (
    <aside className="sitemap-tree relation-left-pane domain-left-pane" aria-label="ドメインの一覧">
      <h2 className="panel-title">コンテキストと集約</h2>
      {own.length === 0 ? <p className="hint screen-list-hint">このシステムが書く情報も、発生させるイベントもありません。</p> : <ContextList contexts={own} current={current} counts={counts} />}
      {upstream.length > 0 && (
        <>
          <h2 className="panel-title" title="このシステムは読むだけで、書くのはほかのところ">
            読むだけのコンテキスト (上流)
          </h2>
          <ContextList contexts={upstream} current={current} counts={counts} />
        </>
      )}
      <h2 className="panel-title">コマンド</h2>
      {scope.commands.length === 0 ? (
        <p className="hint screen-list-hint">このシステムで情報を書く操作がありません。</p>
      ) : (
        <ul className="screen-pick">
          {scope.commands.map((c) => (
            <Row key={c.usecase.id} sel={{ kind: "command", id: c.usecase.id }} label={c.usecase.name} current={current}>
              {c.auto && (
                <span className="an-role role-auto" title="作業に属さず、イベントをきっかけに動く">
                  自動
                </span>
              )}
              {c.readOnly && (
                <span className="an-role role-readonly" title="情報は取得するだけで、イベントを発生させるか状態を変える">
                  取得だけ
                </span>
              )}
              <QuestionBadge counts={counts} id={c.usecase.id} />
            </Row>
          ))}
        </ul>
      )}
      {scope.queries.length > 0 && (
        <>
          <h2 className="panel-title">問い合わせ</h2>
          <ul className="screen-pick">
            {scope.queries.map((q) => (
              <Row key={q.usecase.id} sel={{ kind: "query", id: q.usecase.id }} label={q.usecase.name} current={current}>
                <QuestionBadge counts={counts} id={q.usecase.id} />
              </Row>
            ))}
          </ul>
        </>
      )}
      <h2 className="panel-title">イベント</h2>
      {scope.events.length === 0 ? (
        <p className="hint screen-list-hint">このシステムに関わるイベントがありません。</p>
      ) : (
        <ul className="screen-pick">
          {scope.events.map((e) => (
            <Row key={e.row.event.id} sel={{ kind: "event", id: e.row.event.id }} label={e.row.event.name} current={current}>
              {e.origin === "outside" && (
                <span className="an-role role-outside" title={`別のところで発生し、このシステムの操作のきっかけになる (発生元: ${e.sources.map((s) => s.name).join("・") || "なし"})`}>
                  外
                </span>
              )}
              {e.row.timed && (
                <span className="an-role role-timed" title="定期の時間のイベント">
                  定期
                </span>
              )}
              <QuestionBadge counts={counts} id={e.row.event.id} />
            </Row>
          ))}
        </ul>
      )}
    </aside>
  );
}
