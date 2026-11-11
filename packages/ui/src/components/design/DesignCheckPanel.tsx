import { useMemo } from "react";
import { DESIGN_PROBLEM_ORDER, DESIGN_PROBLEM_TITLES, type DesignProblem, type DesignProblemType } from "@untie/core/model/designCheck";
import { designBoardId, type DesignBoardKind } from "@untie/core/model/design";
import { cachedDomainCheck } from "@untie/core/model/domainCache";
import { readinessRemaining, type Readiness, type ReadinessItem } from "@untie/core/model/readiness";
import { sequenceGaps } from "@untie/core/model/sequence";
import { DOMAIN_CHECK_ORDER, DOMAIN_CHECK_TITLES, type DomainCheckProblem } from "@untie/core/model/domainCheck";
import { isDevMode } from "../../devMode";
import { useUntieStore } from "../../store";
import { revealOnFixedBoard } from "../actions";
import { cachedCheckDesign, cachedReadiness } from "./checkCache";
import { revealDomainSelection } from "./domainElementClick";

/** 検証パネルで、ドメインモデルの問題の行を押したときの移動先 */
export function revealDomainProblem(problem: DomainCheckProblem): void {
  const target = problem.target;
  if (!target) return;
  const st = useUntieStore.getState();
  if (target.board === "contextmap") st.setCurrentBoard(designBoardId("contextmap"));
  else revealDomainSelection(target.selection, target.systemId);
  useUntieStore.getState().setRightPanel("properties");
}

/** 検証パネルで、設計の問題の行を押したときの移動先 */
export function revealDesignProblem(problem: DesignProblem): void {
  const target = problem.target;
  if (!target) return;
  const st = useUntieStore.getState();
  if (target.kind === "board") {
    st.setCurrentBoard(designBoardId(target.id as DesignBoardKind));
    st.setRightPanel("properties");
    return;
  }
  if (target.kind === "database" || target.kind === "table" || target.kind === "information") {
    st.setCurrentBoard(designBoardId("data"));
    // データベースを選び、テーブルを選ぶ (情報は何も選ばない概要)。右のペインはプロパティに戻す
    st.selectDesignDatabase(target.kind === "information" ? undefined : target.id);
    st.setRightPanel("properties");
    if (target.kind === "table") st.selectDesignTable(target.table);
    return;
  }
  // 画面の項目の対応に関わる問題は、画面ボードでその画面を選ぶ
  if (target.kind === "screen" && (problem.type === "bindingInvalid" || problem.type === "bindingUnmapped")) {
    st.setCurrentBoard(designBoardId("screen"));
    st.selectDesignScreen(target.id);
    st.setRightPanel("properties");
    return;
  }
  st.setCurrentBoard(designBoardId("sitemap"));
  if (target.kind === "screen") st.selectDesignScreen(target.id);
  else {
    const t = st.model.designs.find((d) => d.systemId === st.ui.designSystemId)?.transitions.find((x) => x.id === target.id);
    st.selectDesignScreen(t?.from, t?.id);
  }
  st.setRightPanel("properties");
}

/** シーケンス図で、その業務を開く */
function revealSequence(sequenceId: string): void {
  try {
    localStorage.setItem("untie.design.sequenceBusiness", sequenceId);
  } catch {
    // 覚えられなくても、ボードへは移る
  }
  useUntieStore.getState().setCurrentBoard(designBoardId("sequence"));
}

/** 「実装を始める準備」の行を押したときの移動先 */
export function revealReadinessItem(item: ReadinessItem): void {
  const target = item.target;
  if (!target) return;
  if (target.kind === "element") revealOnFixedBoard(target.id);
  else if (target.kind === "sequence") revealSequence(target.id);
  else if (target.kind === "design") revealDesignProblem(target.problem);
  else {
    const st = useUntieStore.getState();
    st.setCurrentBoard(designBoardId(target.id));
    st.setRightPanel("properties");
  }
}

/** 設計モードの検証パネル: 対象のシステムの設計の問題 (エラー) と警告を、種類ごとに出す。行を押すと該当へ移る */
export function DesignCheckPanel() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const result = useMemo(() => (systemId ? cachedCheckDesign(model, systemId) : { problems: [], warnings: [] }), [model, systemId]);
  // ドメインモデルの検証は、内部のモデルの言葉 (集約・コンテキスト) で出るので、開発モードのときだけ見せる
  const domain = isDevMode() ? cachedDomainCheck(model) : [];
  const domainErrors = domain.filter((p) => p.level === "error");
  const domainWarnings = domain.filter((p) => p.level === "warning");
  // 業務の流れ (シーケンス図) で、開発を始める前に決めておくこと: 分岐のときにどうなるか・担当や対象の抜け
  const flowGaps = useMemo(() => (systemId ? sequenceGaps(model, systemId) : []), [model, systemId]);
  // 実装を始める準備: 始める前に決まっているべきことを、条件ごとに
  const readiness = useMemo(() => (systemId ? cachedReadiness(model, systemId) : null), [model, systemId]);
  const hasDesign = model.designs.some((d) => d.systemId === systemId);
  const systemName = model.elements.find((e) => e.id === systemId)?.name || "(名前なし)";
  return (
    <aside className="trace-panel" aria-label="検証">
      {readiness && <ReadinessSection readiness={readiness} systemName={systemName} />}
      <h2 className="panel-title">検証: 設計</h2>
      {!hasDesign ? (
        <p className="trace-summary">「{systemName}」の設計はまだありません。</p>
      ) : result.problems.length === 0 ? (
        <p className="trace-summary is-ok">「{systemName}」の設計に、エラーはありません。</p>
      ) : (
        <p className="trace-summary">「{systemName}」の設計に、エラーが {result.problems.length} 件あります。</p>
      )}
      {result.warnings.length > 0 && <p className="hint">警告が {result.warnings.length} 件あります (エラーではありません)。</p>}
      <Groups list={result.problems} warning={false} />
      <Groups list={result.warnings} warning />
      {flowGaps.length > 0 && (
        <section className="trace-warnings" aria-label="警告: 業務の流れで決まっていないこと" data-testid="sequence-gaps">
          <h3 className="trace-warning-title">警告: 業務の流れで決まっていないこと ({flowGaps.length})</h3>
          <ul className="trace-rows">
            {flowGaps.map(({ sequence, gap }, i) => (
              <li key={i} className="trace-row is-warning">
                <button
                  type="button"
                  className="chip-link design-problem-link"
                  onClick={() => revealSequence(sequence.id)}
                >
                  {sequence.name}: {gap.message}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {domain.length > 0 && (
        <>
          <h2 className="panel-title">検証: ドメインモデル</h2>
          {domainErrors.length === 0 ? <p className="trace-summary is-ok">ドメインモデルに、エラーはありません。</p> : <p className="trace-summary">ドメインモデルに、エラーが {domainErrors.length} 件あります。</p>}
          {domainWarnings.length > 0 && <p className="hint">警告が {domainWarnings.length} 件あります (まだ決めていないこと)。</p>}
          <DomainGroups list={domainErrors} warning={false} />
          <DomainGroups list={domainWarnings} warning />
        </>
      )}
      <details className="trace-rule">
        <summary>調べること</summary>
        <ul>
          <li>実装を始める準備: 途中まで決まった設計から作り始めると、足りないところが勝手に埋まってしまう。条件がすべてそろうまで、実装は始めない。設計の検証の警告も、ここでは残りに数える</li>
          <li>エラー: システムが使う情報がテーブルに対応しているか／対応のあるテーブルが DSL にあるか／DSL に解析エラーが無いか／画面の項目の対応が無い列を指していないか／使うデータベースがあるか</li>
          <li>警告 (業務の流れ): このシステムを使う業務で、条件のときにどうなるか (分岐) が決まっていない／作業の担当や操作の対象が決まっていない。シーケンス図で決める</li>
          <li>警告: 遷移のきっかけが未定／メニューからも遷移からも辿れない画面／画面 UI がまだ無い画面／画面 UI の項目に列の対応が無い</li>
          {isDevMode() && <li>ドメインモデル (保存した判断があるとき。すべてのシステムの分): 同じコンテキストの 2 つの集約に同じ情報が入っていないか (エラー)／集約に入っていない情報・関係を決めていないコンテキストの組・実装するシステムや分類が未定のコンテキスト・不変条件の無い集約・英語名の無いもの (警告)</li>}
        </ul>
      </details>
    </aside>
  );
}

/** 実装を始める準備: 条件ごとに、そろったか・残りが何件か。残りのある条件は開いて、行を押すと該当へ移る */
function ReadinessSection({ readiness, systemName }: { readiness: Readiness; systemName: string }) {
  const total = readiness.conditions.length;
  const remaining = readinessRemaining(readiness);
  return (
    <section className="readiness" aria-label="実装を始める準備" data-testid="readiness">
      <h2 className="panel-title">実装を始める準備</h2>
      {readiness.ready ? (
        <p className="trace-summary is-ok">「{systemName}」は、実装を始められます (条件 {total} / {total})。</p>
      ) : (
        <p className="trace-summary">
          「{systemName}」は、まだ実装を始められません (条件 {readiness.doneCount} / {total}。決めることが残り {remaining} 件)。
        </p>
      )}
      <div className="readiness-bar" role="progressbar" aria-label="そろった条件" aria-valuemin={0} aria-valuemax={total} aria-valuenow={readiness.doneCount}>
        <span style={{ width: `${(readiness.doneCount / total) * 100}%` }} />
      </div>
      <ul className="readiness-list">
        {readiness.conditions.map((c) =>
          c.done ? (
            <li key={c.id} className="readiness-row is-done" data-condition={c.id}>
              <span className="readiness-mark" aria-hidden="true">✓</span>
              <span className="readiness-title">{c.title}</span>
            </li>
          ) : (
            <li key={c.id} className="readiness-row" data-condition={c.id}>
              <details>
                <summary>
                  <span className="readiness-mark" aria-hidden="true">○</span>
                  <span className="readiness-title">{c.title}</span>
                  <span className="readiness-count">残り {c.items.length} 件</span>
                </summary>
                <p className="readiness-hint">{c.hint}</p>
                <ul className="readiness-items">
                  {c.items.map((item, i) => (
                    <li key={i}>
                      {item.target ? (
                        <button type="button" className="chip-link design-problem-link" onClick={() => revealReadinessItem(item)}>
                          {item.message}
                        </button>
                      ) : (
                        <div className="trace-reason">{item.message}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

function Groups({ list, warning }: { list: DesignProblem[]; warning: boolean }) {
  return (
    <>
      {DESIGN_PROBLEM_ORDER.map((type: DesignProblemType) => {
        const rows = list.filter((p) => p.type === type);
        if (rows.length === 0) return null;
        return (
          <section key={type} className={warning ? "trace-warnings" : undefined} aria-label={`${warning ? "警告" : "エラー"}: ${DESIGN_PROBLEM_TITLES[type]}`} data-testid={`design-${warning ? "warnings" : "problems"}-${type}`}>
            <h3 className={warning ? "trace-warning-title" : "trace-info-title"}>
              {warning ? "警告" : "エラー"}: {DESIGN_PROBLEM_TITLES[type]} ({rows.length})
            </h3>
            <ul className="trace-rows">
              {rows.map((p, i) => (
                <li key={`${type}:${i}`} className={`trace-row${warning ? " is-warning" : ""}`}>
                  {p.target ? (
                    <button type="button" className="chip-link design-problem-link" onClick={() => revealDesignProblem(p)}>
                      {p.message}
                    </button>
                  ) : (
                    <div className="trace-reason">{p.message}</div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function DomainGroups({ list, warning }: { list: DomainCheckProblem[]; warning: boolean }) {
  return (
    <>
      {DOMAIN_CHECK_ORDER.map((type) => {
        const rows = list.filter((p) => p.type === type);
        if (rows.length === 0) return null;
        return (
          <section key={type} className={warning ? "trace-warnings" : undefined} aria-label={`${warning ? "警告" : "エラー"}: ${DOMAIN_CHECK_TITLES[type]}`} data-testid={`domain-${warning ? "warnings" : "problems"}-${type}`}>
            <h3 className={warning ? "trace-warning-title" : "trace-info-title"}>
              {warning ? "警告" : "エラー"}: {DOMAIN_CHECK_TITLES[type]} ({rows.length})
            </h3>
            <ul className="trace-rows">
              {rows.map((p, i) => (
                <li key={`${type}:${i}`} className={`trace-row${warning ? " is-warning" : ""}`}>
                  {p.target ? (
                    <button type="button" className="chip-link design-problem-link" onClick={() => revealDomainProblem(p)}>
                      {p.message}
                    </button>
                  ) : (
                    <div className="trace-reason">{p.message}</div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
