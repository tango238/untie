import { useUntieStore } from "../../store";
import { cachedRelationGraph } from "./relationGraphCache";

/** 設計モードの関連ボードの左ペイン: 情報・テーブル (データベースごと)・画面の一覧。押すと図で選ぶ。問題の印も出す */
export function RelationLeftPane() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const selected = useUntieStore((s) => s.ui.designRelation);
  const select = useUntieStore((s) => s.selectDesignRelation);
  const graph = cachedRelationGraph(model, systemId);
  const multi = graph.databases.length >= 2;

  return (
    <aside className="sitemap-tree relation-left-pane" aria-label="関連の一覧">
      <h2 className="panel-title">情報</h2>
      {graph.informations.length === 0 ? (
        <p className="hint screen-list-hint">このシステムに結んだ情報がありません。</p>
      ) : (
        <section>
        <ul className="screen-pick">
          {graph.informations.map((i) => {
            const on = selected?.kind === "information" && selected.id === i.id;
            return (
              <li key={i.id} className={`screen-pick-row${on ? " is-selected" : ""}`} data-information-id={i.id}>
                <button type="button" className="screen-pick-name" aria-current={on ? "true" : undefined} onClick={() => select({ kind: "information", id: i.id })}>
                  {i.name}
                </button>
                {i.unmapped && <span className="relation-badge is-error">未対応</span>}
              </li>
            );
          })}
        </ul>
        </section>
      )}
      <h2 className="panel-title">テーブル</h2>
      {graph.databases.every((d) => d.tables.length === 0) ? (
        <p className="hint screen-list-hint">テーブルがありません。データボードで DSL を書いてください。</p>
      ) : (
        graph.databases.map((db) => (
          <section key={db.id} data-database-id={db.id}>
            {multi && <h3 className="relation-db-title">{db.name}</h3>}
            <ul className="screen-pick">
              {db.tables.map((t) => {
                const on = selected?.kind === "table" && selected.databaseId === db.id && selected.table === t.name;
                return (
                  <li key={t.name} className={`screen-pick-row${on ? " is-selected" : ""}`} data-table-name={t.name}>
                    <button type="button" className="screen-pick-name" aria-current={on ? "true" : undefined} onClick={() => select({ kind: "table", databaseId: db.id, table: t.name })}>
                      {t.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
      <h2 className="panel-title">画面</h2>
      {graph.screens.length === 0 ? (
        <p className="hint screen-list-hint">サイトマップで画面を足してください。</p>
      ) : (
        <section>
        <ul className="screen-pick">
          {graph.screens.map((s) => {
            const on = selected?.kind === "screen" && selected.id === s.id;
            return (
              <li key={s.id} className={`screen-pick-row${on ? " is-selected" : ""}`} data-screen-id={s.id}>
                <button type="button" className="screen-pick-name" aria-current={on ? "true" : undefined} onClick={() => select({ kind: "screen", id: s.id })}>
                  {s.name}
                </button>
                {s.unbound > 0 && <span className="relation-badge is-warn">未対応 {s.unbound}</span>}
                {s.hasView ? <span className="screen-badge is-ui">UI あり</span> : <span className="screen-badge is-no-ui">UI なし</span>}
              </li>
            );
          })}
        </ul>
        </section>
      )}
    </aside>
  );
}
