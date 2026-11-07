import { useMemo } from "react";
import { DESIGN_PROBLEM_ORDER, DESIGN_PROBLEM_TITLES, type DesignProblem, type DesignProblemType } from "@untie/core/model/designCheck";
import { designBoardId, type DesignBoardKind } from "@untie/core/model/design";
import { useUntieStore } from "../../store";
import { cachedCheckDesign } from "./checkCache";

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

/** 設計モードの検証パネル: 対象のシステムの設計の問題 (エラー) と警告を、種類ごとに出す。行を押すと該当へ移る */
export function DesignCheckPanel() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const result = useMemo(() => (systemId ? cachedCheckDesign(model, systemId) : { problems: [], warnings: [] }), [model, systemId]);
  const hasDesign = model.designs.some((d) => d.systemId === systemId);
  const systemName = model.elements.find((e) => e.id === systemId)?.name || "(名前なし)";
  return (
    <aside className="trace-panel" aria-label="検証">
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
      <details className="trace-rule">
        <summary>調べること</summary>
        <ul>
          <li>エラー: システムが使う情報がテーブルに対応しているか／対応のあるテーブルが DSL にあるか／DSL に解析エラーが無いか／画面の項目の対応が無い列を指していないか／使うデータベースがあるか</li>
          <li>警告: 遷移のきっかけが未定／メニューからも遷移からも辿れない画面／画面 UI がまだ無い画面／画面 UI の項目に列の対応が無い</li>
        </ul>
      </details>
    </aside>
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
