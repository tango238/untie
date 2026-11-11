import type { ReactNode } from "react";
import { cachedResolvedDomain } from "@untie/core/model/domainCache";
import { addBoundedContext, setCandidateExcluded } from "@untie/core/model/domainCommands";
import { AGGREGATE_ROLE_LABELS } from "@untie/core/model/domainModel";
import { normalizeDomainSelection, type ResolvedAggregate, type ResolvedContext, type ResolvedDomain } from "@untie/core/model/domainResolve";
import type { DesignDomainSelection } from "@untie/core/model/domainScope";
import { useUntieStore } from "../../store";
import { useDomainEdit } from "./domainElementClick";

const same = (a: DesignDomainSelection | undefined, b: DesignDomainSelection) => !!a && a.kind === b.kind && (a.id ?? null) === (b.id ?? null);

/** 要素が主役の問いの数 (主役の要素 id → 数) */
function questionCounts(r: ResolvedDomain): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of r.scope.notices) {
    const id = n.elementIds[0];
    if (n.level === "question" && id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function QuestionBadge({ n }: { n: number }) {
  return n > 0 ? (
    <span className="relation-badge is-question" title={`この要素についての問いが ${n} 件あります`}>
      問い {n}
    </span>
  ) : null;
}

/** まだ保存していない候補の印 */
function CandidateBadge({ saved }: { saved: boolean }) {
  return saved ? null : (
    <span className="an-role role-candidate" title="分析から導いた候補です (まだ保存していません)">
      候補
    </span>
  );
}

function Row({ sel, label, current, children, nested }: { sel: DesignDomainSelection; label: string; current: DesignDomainSelection | undefined; children?: ReactNode; nested?: boolean }) {
  const select = useUntieStore((s) => s.selectDesignDomain);
  const on = same(current, sel);
  return (
    <li className={`screen-pick-row${on ? " is-selected" : ""}${nested ? " is-nested" : ""}`} data-domain-row={`${sel.kind}:${sel.id ?? ""}`}>
      <button type="button" className="screen-pick-name" aria-current={on ? "true" : undefined} onClick={() => select(sel)}>
        {label || "(名前なし)"}
      </button>
      {children}
    </li>
  );
}

/** 集約の印: このシステムで書くなら「ルート」「集約」、書かないなら「参照」。ほかのシステムでも書くなら「ほかでも書く」 */
function AggregateBadges({ a }: { a: ResolvedAggregate }) {
  const role = a.writtenHere ? (a.role === "lifecycle" ? "ルート" : "集約") : "参照";
  const title = a.writtenHere ? AGGREGATE_ROLE_LABELS[a.role] : `このシステムでは書かない${a.otherWriterSystems.length > 0 ? ` (書くシステム: ${a.otherWriterSystems.map((s) => s.name).join("・")})` : ""}`;
  return (
    <>
      <span className={`an-role role-agg-${a.writtenHere ? a.role : "reference"}`} title={title}>
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

function ContextList({ contexts, current, counts }: { contexts: ResolvedContext[]; current: DesignDomainSelection | undefined; counts: Map<string, number> }) {
  return (
    <ul className="screen-pick">
      {contexts.map((c) => (
        <li key={c.key ?? "none"} className="domain-context-group">
          <ul className="screen-pick">
            <Row sel={{ kind: "context", id: c.key }} label={c.name} current={current}>
              {c.unassigned && (
                <span className="an-role role-outside" title="実装するシステムが決まっていません">
                  未割り当て
                </span>
              )}
              <CandidateBadge saved={!!c.saved} />
              <QuestionBadge n={c.candidates.reduce((n, sc) => n + (sc.context ? (counts.get(sc.context.id) ?? 0) : 0), 0)} />
            </Row>
            {c.aggregates.map((a) => (
              <Row key={a.key} sel={{ kind: "aggregate", id: a.key }} label={a.name} current={current} nested>
                <AggregateBadges a={a} />
                <CandidateBadge saved={!!a.saved} />
                <QuestionBadge n={[a.root, ...a.members].reduce((n, i) => n + (counts.get(i.id) ?? 0), 0)} />
              </Row>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * 設計モードのドメインボードの左ペイン: コンテキスト (と集約。自分と読むだけの上流に分ける)・コマンド・問い合わせ・イベント・外した候補の一覧。
 * 保存したものと、分析から導いた候補 (「候補」の印) が並ぶ。押すとボードで選ぶ。問いの数の印も出す
 */
export function DomainLeftPane() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const stored = useUntieStore((s) => s.ui.designDomain);
  const select = useUntieStore((s) => s.selectDesignDomain);
  const { readOnly, run } = useDomainEdit();
  const r = cachedResolvedDomain(model, systemId);
  const current = normalizeDomainSelection(r, stored);
  const counts = questionCounts(r);
  const own = r.contexts.filter((c) => c.role === "own");
  const upstream = r.contexts.filter((c) => c.role === "upstream");
  const addContext = () => {
    if (!systemId) return;
    const added = run((m) => addBoundedContext(m, { name: "新しいコンテキスト", systemIds: [systemId] }));
    if (added) select({ kind: "context", id: added.id });
  };
  return (
    <aside className="sitemap-tree relation-left-pane domain-left-pane" aria-label="ドメインの一覧">
      <h2 className="panel-title">
        コンテキストと集約
        {!readOnly && (
          <button type="button" className="domain-add" title="境界づけられたコンテキストを足す (実装先はこのシステム)" onClick={addContext}>
            ＋コンテキスト
          </button>
        )}
      </h2>
      {own.length === 0 ? <p className="hint screen-list-hint">このシステムが書く情報も、発生させるイベントもありません。</p> : <ContextList contexts={own} current={current} counts={counts} />}
      {upstream.length > 0 && (
        <>
          <h2 className="panel-title" title="ほかのシステムが実装するコンテキスト (このシステムは情報を読むだけか、そこで発生するイベントをきっかけにする)">
            上流のコンテキスト
          </h2>
          <ContextList contexts={upstream} current={current} counts={counts} />
        </>
      )}
      <h2 className="panel-title">コマンド</h2>
      {r.commands.length === 0 ? (
        <p className="hint screen-list-hint">このシステムで情報を書く操作がありません。</p>
      ) : (
        <ul className="screen-pick">
          {r.commands.map((c) => (
            <Row key={c.key} sel={{ kind: "command", id: c.key }} label={c.name} current={current}>
              {!c.candidate && (
                <span className="an-role role-tobe" title="分析に無い、あるべき姿のコマンド">
                  あるべき姿
                </span>
              )}
              {c.candidate?.auto && (
                <span className="an-role role-auto" title="作業に属さず、イベントをきっかけに動く">
                  自動
                </span>
              )}
              {c.candidate?.readOnly && (
                <span className="an-role role-readonly" title="情報は取得するだけで、イベントを発生させるか状態を変える">
                  取得だけ
                </span>
              )}
              <CandidateBadge saved={!!c.saved} />
              <QuestionBadge n={c.candidate ? (counts.get(c.candidate.usecase.id) ?? 0) : 0} />
            </Row>
          ))}
        </ul>
      )}
      {r.scope.queries.length > 0 && (
        <>
          <h2 className="panel-title">問い合わせ</h2>
          <ul className="screen-pick">
            {r.scope.queries.map((q) => (
              <Row key={q.usecase.id} sel={{ kind: "query", id: q.usecase.id }} label={q.usecase.name} current={current}>
                <QuestionBadge n={counts.get(q.usecase.id) ?? 0} />
              </Row>
            ))}
          </ul>
        </>
      )}
      <h2 className="panel-title">イベント</h2>
      {r.events.length === 0 ? (
        <p className="hint screen-list-hint">このシステムに関わるイベントがありません。</p>
      ) : (
        <ul className="screen-pick">
          {r.events.map((e) => (
            <Row key={e.key} sel={{ kind: "event", id: e.key }} label={e.name} current={current}>
              {!e.scoped && (
                <span className="an-role role-tobe" title="分析に無い、あるべき姿のイベント">
                  あるべき姿
                </span>
              )}
              {e.origin === "outside" && (
                <span className="an-role role-outside" title="別のところで発生し、このシステムの操作のきっかけになる">
                  外
                </span>
              )}
              {e.scoped?.row.timed && (
                <span className="an-role role-timed" title="定期の時間のイベント">
                  定期
                </span>
              )}
              <CandidateBadge saved={!!e.saved} />
              <QuestionBadge n={e.scoped ? (counts.get(e.scoped.row.event.id) ?? 0) : 0} />
            </Row>
          ))}
        </ul>
      )}
      {r.excluded.length > 0 && (
        <>
          <h2 className="panel-title" title="分析から導いた候補のうち、あるべき姿から外したもの">
            外した候補
          </h2>
          <ul className="screen-pick">
            {r.excluded.map((x) => (
              <li key={x.key} className="screen-pick-row" data-domain-excluded={x.key}>
                <span className="screen-pick-name is-static">
                  {x.kind === "command" ? "コマンド" : x.kind === "event" ? "イベント" : "ポリシー"}: {x.label}
                </span>
                {!readOnly && (
                  <button type="button" className="link" onClick={() => run((m) => setCandidateExcluded(m, { key: x.key, excluded: false }))}>
                    戻す
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
