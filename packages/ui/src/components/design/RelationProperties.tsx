import { designBoardId } from "@untie/core/model/design";
import type { RelationGraph } from "@untie/core/model/designRelation";
import { unboundSlots, viewBindingSlots } from "@untie/core/model/designView";
import type { UntieModel } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { revealOnFixedBoard } from "../actions";
import { cachedRelationGraph } from "./relationGraphCache";

/** 右のペイン (設計モードの関連ボード): 選んだ情報・テーブル・画面の詳細。何も選んでいないときは全体の数 */
export function RelationProperties() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const sel = useUntieStore((s) => s.ui.designRelation);
  const graph = cachedRelationGraph(model, systemId);
  return (
    <aside className="property-panel" aria-label="プロパティ">
      <h2 className="panel-title">プロパティ</h2>
      {sel?.kind === "information" ? (
        <InformationDetail graph={graph} id={sel.id} />
      ) : sel?.kind === "table" ? (
        <TableDetail graph={graph} databaseId={sel.databaseId} table={sel.table} />
      ) : sel?.kind === "screen" ? (
        <ScreenDetail graph={graph} id={sel.id} model={model} systemId={systemId} />
      ) : (
        <Overview graph={graph} />
      )}
    </aside>
  );
}

function Overview({ graph }: { graph: RelationGraph }) {
  const tables = graph.databases.reduce((n, d) => n + d.tables.length, 0);
  return (
    <div className="editor" data-testid="relation-overview">
      <p className="hint">図の情報・テーブル・画面を選ぶと、ここに内容が出ます</p>
      <ul className="plain-list">
        <li>情報 {graph.informations.length}</li>
        <li>テーブル {tables}</li>
        <li>画面 {graph.screens.length}</li>
        <li>未対応の情報 {graph.informations.filter((i) => i.unmapped).length}</li>
        <li>未対応の項目がある画面 {graph.screens.filter((s) => s.unbound > 0).length}</li>
      </ul>
    </div>
  );
}

function InformationDetail({ graph, id }: { graph: RelationGraph; id: string }) {
  const select = useUntieStore((s) => s.selectDesignRelation);
  const selectTable = useUntieStore((s) => s.selectDesignTable);
  const setCurrentBoard = useUntieStore((s) => s.setCurrentBoard);
  const info = graph.informations.find((i) => i.id === id);
  if (!info) return <p className="hint">図に出ていない情報です</p>;
  const tables = graph.databases.flatMap((d) => graph.edges.filter((e) => e.kind === "informationTable" && e.informationId === id && e.databaseId === d.id).map((e) => ({ db: d, table: (e as { table: string }).table })));
  const missing = graph.databases.flatMap((d) => d.missingTables.filter((t) => t.informationIds.includes(id)).map((t) => ({ db: d, table: t.name })));
  const multi = graph.databases.length >= 2;
  const openData = () => {
    const first = tables[0];
    if (first) selectTable(first.table, first.db.id);
    setCurrentBoard(designBoardId("data"));
  };
  return (
    <div className="editor" data-testid="relation-information">
      <div className="kind-line">情報</div>
      <div className="field">
        <span className="field-label">名前</span>
        <div className="static-value">{info.name}</div>
      </div>
      <div className="field">
        <span className="field-label">説明</span>
        <div className="static-value sitemap-description">{info.description || "—"}</div>
      </div>
      <div className="field">
        <span className="field-label">対応するテーブル</span>
        {info.unmapped && <div className="unmapped">テーブルに対応していません</div>}
        {tables.length === 0 && missing.length === 0 ? (
          info.unmapped ? null : <div className="hint-inline">なし</div>
        ) : (
          <ul className="plain-list">
            {tables.map((t) => (
              <li key={`${t.db.id}:${t.table}`}>
                <button type="button" className="chip-link" onClick={() => select({ kind: "table", databaseId: t.db.id, table: t.table })}>
                  {t.table}
                </button>
                {multi && <small className="hint-inline"> ({t.db.name})</small>}
              </li>
            ))}
            {missing.map((t) => (
              <li key={`${t.db.id}:${t.table}`} data-missing-table={t.table}>
                <span className="hint-inline">{t.table} (DSL にありません){multi ? ` (${t.db.name})` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sitemap-actions">
        <button type="button" onClick={() => revealOnFixedBoard(id)}>分析の情報ボードで見る</button>
        <button type="button" onClick={openData}>データボードで開く</button>
      </div>
    </div>
  );
}

function TableDetail({ graph, databaseId, table }: { graph: RelationGraph; databaseId: string; table: string }) {
  const select = useUntieStore((s) => s.selectDesignRelation);
  const selectTable = useUntieStore((s) => s.selectDesignTable);
  const setCurrentBoard = useUntieStore((s) => s.setCurrentBoard);
  const db = graph.databases.find((d) => d.id === databaseId);
  const t = db?.tables.find((x) => x.name === table);
  if (!db || !t) return <p className="hint">図に出ていないテーブルです</p>;
  const screenName = (id: string) => graph.screens.find((s) => s.id === id)?.name ?? id;
  const infos = t.informationIds.map((id) => graph.informations.find((i) => i.id === id)).filter((i): i is NonNullable<typeof i> => !!i);
  return (
    <div className="editor" data-testid="relation-table">
      <div className="kind-line">テーブル</div>
      <div className="field">
        <span className="field-label">名前</span>
        <div className="static-value">{t.name}</div>
      </div>
      <div className="field">
        <span className="field-label">データベース</span>
        <div className="static-value">{db.name}</div>
      </div>
      <div className="field">
        <span className="field-label">対応する情報</span>
        {infos.length === 0 ? (
          <div className="hint-inline">なし</div>
        ) : (
          <ul className="plain-list">
            {infos.map((i) => (
              <li key={i.id}>
                <button type="button" className="chip-link" onClick={() => select({ kind: "information", id: i.id })}>
                  {i.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="field">
        <span className="field-label">項目と使う画面</span>
        {t.columns.length === 0 ? (
          <div className="hint-inline">項目がありません</div>
        ) : (
          <ul className="column-list">
            {t.columns.map((c) => (
              <li key={c.name} data-column={c.name}>
                <span className="column-name">{c.name}</span>
                <span className="relation-used-by">{c.usedBy.length === 0 ? "—" : c.usedBy.map(screenName).join("、")}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sitemap-actions">
        <button
          type="button"
          onClick={() => {
            selectTable(t.name, db.id);
            setCurrentBoard(designBoardId("data"));
          }}
        >
          データボードで開く
        </button>
      </div>
    </div>
  );
}

function ScreenDetail({ graph, id, model, systemId }: { graph: RelationGraph; id: string; model: UntieModel; systemId: string | undefined }) {
  const selectScreen = useUntieStore((s) => s.selectDesignScreen);
  const setCurrentBoard = useUntieStore((s) => s.setCurrentBoard);
  const screenInfo = graph.screens.find((s) => s.id === id);
  const design = model.designs.find((d) => d.systemId === systemId);
  const screen = design?.screens.find((s) => s.id === id);
  if (!screenInfo || !screen) return <p className="hint">図に出ていない画面です</p>;
  const multi = graph.databases.length >= 2;
  const dbName = (dbId: string) => graph.databases.find((d) => d.id === dbId)?.name ?? dbId;
  const slots = viewBindingSlots(screen.view);
  const bindings = new Map((screen.bindings ?? []).map((b) => [b.item, b]));
  const unbound = new Set(unboundSlots(screen).map((x) => x.key));
  const columnExists = (b: { databaseId: string; table: string; column: string }) =>
    !!graph.databases.find((d) => d.id === b.databaseId)?.tables.find((t) => t.name === b.table)?.columns.some((c) => c.name === b.column);
  return (
    <div className="editor" data-testid="relation-screen">
      <div className="kind-line">画面</div>
      <div className="field">
        <span className="field-label">名前</span>
        <div className="static-value">{screenInfo.name}</div>
      </div>
      <div className="field">
        <span className="field-label">画面 UI</span>
        <div className="static-value">{screenInfo.hasView ? "UI あり" : "UI なし"}</div>
      </div>
      <div className="field">
        <span className="field-label">項目と列の対応</span>
        {slots.length === 0 ? (
          <div className="hint-inline">対応を付ける項目がありません</div>
        ) : (
          <ul className="column-list">
            {slots.map((slot) => {
              const b = bindings.get(slot.key);
              return (
                <li key={slot.key} data-item={slot.key}>
                  <span className="column-name">{slot.label}</span>
                  {b ? (
                    <code className="column-type">{`${multi ? `${dbName(b.databaseId)} / ` : ""}${b.table}.${b.column}${columnExists(b) ? "" : " (無い列)"}`}</code>
                  ) : unbound.has(slot.key) ? (
                    <span className="unmapped">未対応</span>
                  ) : (
                    <span className="hint-inline">— (計算した値)</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="sitemap-actions">
        <button
          type="button"
          onClick={() => {
            selectScreen(id);
            setCurrentBoard(designBoardId("screen"));
          }}
        >
          画面ボードで開く
        </button>
        <button
          type="button"
          onClick={() => {
            setCurrentBoard(designBoardId("sitemap"));
            selectScreen(id);
          }}
        >
          サイトマップで見る
        </button>
      </div>
    </div>
  );
}
