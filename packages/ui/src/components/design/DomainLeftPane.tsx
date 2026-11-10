import { cachedDomainScope } from "@untie/core/model/domainCache";
import { AGGREGATE_ROLE_LABELS } from "@untie/core/model/domainModel";
import { noticesAbout, type DesignDomainSelection, type DomainScope } from "@untie/core/model/domainScope";
import { useUntieStore } from "../../store";

const same = (a: DesignDomainSelection | undefined, b: DesignDomainSelection) => !!a && a.kind === b.kind && (a.id ?? null) === (b.id ?? null);

function QuestionBadge({ scope, id }: { scope: DomainScope; id: string | null | undefined }) {
  if (!id) return null;
  const n = noticesAbout(scope, id).filter((x) => x.level === "question" && x.elementIds[0] === id).length;
  return n > 0 ? <span className="relation-badge is-question">問い {n}</span> : null;
}

function Row({ sel, label, current, children, nested }: { sel: DesignDomainSelection; label: string; current: DesignDomainSelection | undefined; children?: React.ReactNode; nested?: boolean }) {
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

/** 設計モードのドメインボードの左ペイン: コンテキスト (と集約)・コマンド・イベントの一覧。押すとボードで選ぶ。問いの数の印も出す */
export function DomainLeftPane() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const current = useUntieStore((s) => s.ui.designDomain);
  const scope = cachedDomainScope(model, systemId);
  return (
    <aside className="sitemap-tree relation-left-pane domain-left-pane" aria-label="ドメインの一覧">
      <h2 className="panel-title">コンテキストと集約</h2>
      {scope.contexts.length === 0 ? (
        <p className="hint screen-list-hint">このシステムの操作が扱う情報がありません。</p>
      ) : (
        <ul className="screen-pick">
          {scope.contexts.map((c) => (
            <li key={c.context?.id ?? "none"} className="domain-context-group">
              <ul className="screen-pick">
                <Row sel={{ kind: "context", id: c.context?.id ?? null }} label={c.context?.name ?? "未分類"} current={current}>
                  <QuestionBadge scope={scope} id={c.context?.id} />
                </Row>
                {c.aggregates.map((a) => (
                  <Row key={a.candidate.information.id} sel={{ kind: "aggregate", id: a.candidate.information.id }} label={a.candidate.information.name} current={current} nested>
                    <span className={`an-role role-agg-${a.candidate.role}`} title={AGGREGATE_ROLE_LABELS[a.candidate.role]}>
                      {a.candidate.role === "lifecycle" ? "ルート" : a.candidate.role === "written" ? "集約" : "参照"}
                    </span>
                    {!a.writtenHere && <span className="screen-badge is-no-ui">書かない</span>}
                    <QuestionBadge scope={scope} id={a.candidate.information.id} />
                  </Row>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <h2 className="panel-title">コマンド</h2>
      {scope.commands.length === 0 ? (
        <p className="hint screen-list-hint">このシステムで情報を書く操作がありません。</p>
      ) : (
        <ul className="screen-pick">
          {scope.commands.map((c) => (
            <Row key={c.usecase.id} sel={{ kind: "command", id: c.usecase.id }} label={c.usecase.name} current={current}>
              {c.auto && <span className="an-role role-auto">自動</span>}
              {c.readOnly && <span className="an-role role-readonly">取得だけ</span>}
              <QuestionBadge scope={scope} id={c.usecase.id} />
            </Row>
          ))}
        </ul>
      )}
      <h2 className="panel-title">イベント</h2>
      {scope.events.length === 0 ? (
        <p className="hint screen-list-hint">このシステムに関わるイベントがありません。</p>
      ) : (
        <ul className="screen-pick">
          {scope.events.map((e) => (
            <Row key={e.row.event.id} sel={{ kind: "event", id: e.row.event.id }} label={e.row.event.name} current={current}>
              {e.origin === "outside" && <span className="screen-badge is-no-ui">外</span>}
              {e.row.timed && <span className="an-role role-timed">時間</span>}
            </Row>
          ))}
        </ul>
      )}
    </aside>
  );
}
