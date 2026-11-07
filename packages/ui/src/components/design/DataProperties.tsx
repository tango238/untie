import { useMemo } from "react";
import { setTableInformation } from "@untie/core/model/commands";
import { designsUsingDatabase, systemInformationIds, tableInformationIds, tablesOfInformation } from "@untie/core/model/designData";
import { describePrismaField } from "@untie/core/model/prisma";
import { parsePrismaDslCached } from "@untie/core/model/prismaCache";
import type { Database, Element, UntieModel } from "@untie/core/model/types";
import { selectReadOnly, useUntieStore } from "../../store";
import { revealOnFixedBoard } from "../actions";
import { useDataSelection } from "./dataSelection";

const nameOf = (e: { name: string } | undefined) => e?.name || "(名前なし)";

/** 右のペイン (設計モードのデータボード): 選んだテーブルの列と表す情報。何も選んでいないときはデータベースの概要 */
export function DataProperties() {
  const { model, systemId, database, tableName } = useDataSelection();
  return (
    <aside className="property-panel" aria-label="プロパティ">
      <h2 className="panel-title">プロパティ</h2>
      {!database || !systemId ? (
        <p className="hint">データベースを選ぶと、ここに内容が出ます</p>
      ) : tableName !== undefined ? (
        <TableEditor key={`${database.id}:${tableName}`} model={model} systemId={systemId} database={database} table={tableName} />
      ) : (
        <Overview model={model} systemId={systemId} database={database} />
      )}
    </aside>
  );
}

function Overview({ model, systemId, database }: { model: UntieModel; systemId: string; database: Database }) {
  const selectTable = useUntieStore((s) => s.selectDesignTable);
  const schema = parsePrismaDslCached(database.dsl);
  const users = designsUsingDatabase(model, database.id);
  const infoIds = useMemo(() => systemInformationIds(model, systemId), [model, systemId]);
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  return (
    <div className="editor" data-testid="data-overview">
      <div className="kind-line">データベース</div>
      <div className="field">
        <span className="field-label">名前</span>
        <div className="static-value">{database.name || "(名前なし)"}</div>
      </div>
      <div className="field">
        <span className="field-label">テーブル</span>
        <div className="static-value">{schema.models.length} 個 (enum {schema.enums.length} 個)</div>
      </div>
      <div className="field">
        <span className="field-label">使っている設計</span>
        {users.length === 0 ? (
          <div className="hint-inline">なし</div>
        ) : (
          <ul className="plain-list">
            {users.map((u) => (
              <li key={u.systemId}>
                {nameOf(byId.get(u.systemId))}
                {!u.explicit && <small className="hint-inline"> (既定)</small>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="field">
        <span className="field-label">システムが使う情報</span>
        {infoIds.length === 0 ? (
          <div className="hint-inline">このシステムに結んだ情報がありません</div>
        ) : (
          <ul className="plain-list info-map">
            {infoIds.map((id) => {
              const tables = tablesOfInformation(database, id);
              return (
                <li key={id} data-information={id}>
                  <span>{nameOf(byId.get(id))}</span>{" "}
                  {tables.length === 0 ? (
                    <small className="unmapped">未対応</small>
                  ) : (
                    tables.map((t) => (
                      <button key={t} type="button" className="chip-link" onClick={() => selectTable(t, database.id)}>
                        {t}
                      </button>
                    ))
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function TableEditor({ model, systemId, database, table }: { model: UntieModel; systemId: string; database: Database; table: string }) {
  const readOnly = useUntieStore(selectReadOnly);
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const selectTable = useUntieStore((s) => s.selectDesignTable);
  const schema = parsePrismaDslCached(database.dsl);
  const parsed = schema.models.find((m) => m.name === table);
  const selected = tableInformationIds(database, table);
  const { used, others } = useMemo(() => {
    const usedIds = systemInformationIds(model, systemId);
    const set = new Set(usedIds);
    const byId = new Map(model.elements.map((e) => [e.id, e]));
    return {
      used: usedIds.map((id) => byId.get(id)!),
      others: model.elements.filter((e): e is Element => e.kind === "information" && !set.has(e.id)).sort((a, b) => nameOf(a).localeCompare(nameOf(b), "ja")),
    };
  }, [model, systemId]);

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    const r = dispatch((m) => setTableInformation(m, { id: database.id, table, informationIds: next }));
    if (!r.ok) pushToast(r.reason, "error");
  };
  const box = (e: Element) => (
    <li key={e.id}>
      <label className="check-row">
        <input type="checkbox" aria-label={nameOf(e)} checked={selected.includes(e.id)} disabled={readOnly} onChange={() => toggle(e.id)} />
        <span>{nameOf(e)}</span>
      </label>
      <button type="button" className="link" onClick={() => revealOnFixedBoard(e.id)} title="分析の情報ボードで見る">
        ↗
      </button>
    </li>
  );

  return (
    <div className="editor" data-testid="table-properties">
      <div className="kind-line">テーブル</div>
      <div className="field">
        <span className="field-label">名前</span>
        <div className="static-value">
          {table}
          {parsed?.mapName && <small className="hint-inline"> (@@map: {parsed.mapName})</small>}
        </div>
        {!parsed && <div className="hint-inline">DSL にありません</div>}
        <button type="button" className="link" onClick={() => selectTable(undefined)}>
          データベースの概要に戻る
        </button>
      </div>
      {parsed && (
        <div className="field">
          <span className="field-label">列</span>
          {parsed.fields.length === 0 ? (
            <div className="hint-inline">列がありません</div>
          ) : (
            <ul className="column-list">
              {parsed.fields.map((f) => (
                <li key={f.name} data-column={f.name}>
                  <span className="column-name">{f.name}</span>
                  <code className="column-type">{describePrismaField(f)}</code>
                </li>
              ))}
            </ul>
          )}
          {parsed.blockAttributes.length > 0 && (
            <small className="hint-inline">{parsed.blockAttributes.map((a) => `@@${a.name}(${a.args})`).join(" ")}</small>
          )}
        </div>
      )}
      <div className="field">
        <span className="field-label">表す情報</span>
        {used.length === 0 ? <div className="hint-inline">このシステムに結んだ情報がありません</div> : <ul className="plain-list">{used.map(box)}</ul>}
        {others.length > 0 && (
          <details className="other-infos" open={others.some((e) => selected.includes(e.id)) || undefined}>
            <summary>その他の情報 ({others.length})</summary>
            <ul className="plain-list">{others.map(box)}</ul>
          </details>
        )}
      </div>
    </div>
  );
}
