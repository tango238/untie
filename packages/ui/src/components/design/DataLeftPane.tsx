import { useMemo, useState, type FormEvent } from "react";
import type { CommandResult } from "@untie/core/model/commands";
import type { UntieModel } from "@untie/core/model/types";
import { addDatabase, removeDatabase, renameDatabase, setDesignDatabases } from "@untie/core/model/commands";
import { databaseBindingCount, databaseMappingCount, designsUsingDatabase } from "@untie/core/model/designData";
import { effectiveDatabaseIds } from "@untie/core/model/design";
import { LIMITS } from "@untie/core/model/limits";
import { parsePrismaDslCached } from "@untie/core/model/prismaCache";
import { selectReadOnly, useUntieStore } from "../../store";
import { CommitField } from "../CommitField";
import { ConfirmDialog } from "../ConfirmDialog";
import { useDataSelection } from "./dataSelection";

/**
 * 設計モードのデータボードの左ペイン: データベースの一覧 (この設計で使うかのチェック・追加・名前変更・削除) と、
 * 選んだデータベースの DSL から読めたテーブルの一覧
 */
export function DataLeftPane() {
  const { model, systemId, database, tableName } = useDataSelection();
  const readOnly = useUntieStore(selectReadOnly);
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const selectDatabase = useUntieStore((s) => s.selectDesignDatabase);
  const selectTable = useUntieStore((s) => s.selectDesignTable);
  const [adding, setAdding] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const design = model.designs.find((d) => d.systemId === systemId);
  const used = useMemo(() => new Set(design ? effectiveDatabaseIds(model, design) : effectiveDatabaseIds(model, { databaseIds: [] })), [model, design]);
  const implicit = !design || design.databaseIds.length === 0;
  const schema = database ? parsePrismaDslCached(database.dsl) : undefined;

  const run = <T,>(command: (m: UntieModel) => CommandResult<T>) => {
    const r = dispatch(command);
    if (!r.ok) pushToast(r.reason, "error");
    return r;
  };

  const toggleUse = (id: string) => {
    if (!systemId) return;
    const explicit = design?.databaseIds ?? [];
    const next = explicit.includes(id) ? explicit.filter((x) => x !== id) : [...explicit, id];
    run((m) => setDesignDatabases(m, { systemId, databaseIds: next }));
  };

  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    if (adding === null || adding.trim() === "") return;
    const r = run((m) => addDatabase(m, { name: adding }));
    if (r.ok) {
      selectDatabase(r.id);
      setAdding(null);
    }
  };

  const doRemove = () => {
    if (!database) return;
    const r = run((m) => removeDatabase(m, { id: database.id }));
    if (r.ok) setConfirmRemove(false);
  };

  const requestRemove = () => {
    if (!database) return;
    const needs = database.dsl.trim() !== "" || databaseMappingCount(database) > 0 || databaseBindingCount(model, database.id) > 0;
    if (needs) setConfirmRemove(true);
    else doRemove();
  };

  const removeDetails = (): string[] => {
    if (!database) return [];
    const out: string[] = [];
    if (database.dsl.trim() !== "") out.push(`DSL (${parsePrismaDslCached(database.dsl).models.length} 個の model)`);
    const mapping = databaseMappingCount(database);
    if (mapping > 0) out.push(`テーブルと情報の対応 ${mapping} 件`);
    const bindings = databaseBindingCount(model, database.id);
    if (bindings > 0) out.push(`画面の項目と列の対応 ${bindings} 件`);
    const names = designsUsingDatabase(model, database.id).map((u) => model.elements.find((e) => e.id === u.systemId)?.name || "(名前なし)");

    if (names.length > 0) out.push(`使っている設計: ${names.join("、")}`);
    if (designsUsingDatabase(model, database.id).some((u) => u.explicit)) out.push("選んで使っていた設計は、既定の規則 (「既定のデータベース」、無ければ先頭) のデータベースに切り替わります");
    return out;
  };

  const mappedMissing = database && schema ? database.tables.filter((t) => t.informationIds.length > 0 && !schema.models.some((m) => m.name === t.table)) : [];

  return (
    <aside className="sitemap-tree data-left" aria-label="データベースとテーブルの一覧">
      <h2 className="panel-title">データベース</h2>
      {model.databases.length === 0 ? (
        <p className="hint">データベースがまだありません。</p>
      ) : (
        <ul className="db-list">
          {model.databases.map((db) => {
            const selected = database?.id === db.id;
            return (
              <li key={db.id} className={`db-row${selected ? " is-selected" : ""}`} data-database={db.id}>
                <input
                  type="checkbox"
                  aria-label={`${db.name || "(名前なし)"} をこの設計で使う`}
                  checked={design?.databaseIds.includes(db.id) ?? false}
                  disabled={readOnly || !systemId}
                  onChange={() => toggleUse(db.id)}
                />
                <button type="button" className="db-name" aria-current={selected ? "true" : undefined} onClick={() => selectDatabase(db.id)}>
                  {db.name || "(名前なし)"}
                </button>
                {implicit && used.has(db.id) && <span className="db-default-badge">既定</span>}
              </li>
            );
          })}
        </ul>
      )}
      {implicit && used.size > 0 && <p className="hint">何もチェックしないと、「既定」の印のデータベースが使われます。</p>}
      {!readOnly &&
        (adding === null ? (
          <div className="db-actions">
            <button type="button" onClick={() => setAdding("")}>
              ＋データベース
            </button>
          </div>
        ) : (
          <form className="db-add" onSubmit={submitAdd}>
            <input
              aria-label="新しいデータベースの名前"
              value={adding}
              maxLength={LIMITS.name.max}
              placeholder="データベースの名前"
              autoFocus
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setAdding(null);
              }}
            />
            <button type="submit" className="primary" disabled={adding.trim() === ""}>
              追加
            </button>
            <button type="button" onClick={() => setAdding(null)}>
              やめる
            </button>
          </form>
        ))}
      {database && (
        <section className="db-selected" aria-label="選んだデータベース">
          <CommitField
            key={database.id}
            label="データベースの名前"
            value={database.name}
            maxLength={LIMITS.name.max}
            readOnly={readOnly}
            onCommit={(v) => {
              // 空にはできない (元の名前のまま)
              if (v.trim() !== "") run((m) => renameDatabase(m, { id: database.id, name: v }));
            }}
          />
          {!readOnly && (
            <button type="button" className="danger-outline" onClick={requestRemove}>
              このデータベースを削除
            </button>
          )}
        </section>
      )}
      {database && schema && (
        <section className="db-tables" aria-label="テーブル">
          <h3 className="tree-heading">テーブル</h3>
          {schema.models.length === 0 && mappedMissing.length === 0 ? (
            <p className="hint">DSL に model がありません。</p>
          ) : (
            <ul className="table-list">
              {schema.models.map((m) => {
                const count = database.tables.find((t) => t.table === m.name)?.informationIds.length ?? 0;
                return (
                  <li key={m.name} className={`table-row${tableName === m.name ? " is-selected" : ""}`}>
                    <button type="button" className="db-name" aria-current={tableName === m.name ? "true" : undefined} onClick={() => selectTable(m.name, database.id)}>
                      {m.name}
                    </button>
                    <small className="hint-inline">情報 {count}</small>
                  </li>
                );
              })}
              {mappedMissing.map((t) => (
                <li key={`missing:${t.table}`} className={`table-row is-missing${tableName === t.table ? " is-selected" : ""}`}>
                  <button type="button" className="db-name" aria-current={tableName === t.table ? "true" : undefined} onClick={() => selectTable(t.table, database.id)}>
                    {t.table}
                  </button>
                  <small className="hint-inline">DSL にありません (情報 {t.informationIds.length})</small>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {confirmRemove && database && (
        <ConfirmDialog
          title="データベースを削除"
          message={`データベース「${database.name || "(名前なし)"}」を削除します。他の設計からも使われうるため、次のものが消えます。`}
          details={removeDetails()}
          confirmLabel="削除"
          danger
          onConfirm={doRemove}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </aside>
  );
}
