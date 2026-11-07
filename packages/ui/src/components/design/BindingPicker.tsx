import { useEffect, useState } from "react";
import type { Binding } from "./screenForm";

export interface DbInfo {
  id: string;
  name: string;
  tables: { name: string; columns: string[] }[];
}

type Value = Omit<Binding, "item"> | undefined;

interface Props {
  /** aria-label の前半 (例: 項目「keyword」) */
  label: string;
  value: Value;
  databases: DbInfo[];
  readOnly?: boolean;
  /** 3 つ揃ったら対応を、データベースを「なし」にしたら null を返す */
  onChange: (value: Omit<Binding, "item"> | null) => void;
}

/** 項目や列を、使うデータベースの列に結ぶ 3 つの select (データベース → テーブル → 列)。データベースを「なし」にすると対応を外す */
export function BindingPicker({ label, value, databases, readOnly, onChange }: Props) {
  // 3 つ揃うまでの途中の選択はここに持つ。外の対応が変わったら、それに合わせる
  const [draft, setDraft] = useState({ databaseId: value?.databaseId ?? "", table: value?.table ?? "", column: value?.column ?? "" });
  useEffect(() => {
    setDraft({ databaseId: value?.databaseId ?? "", table: value?.table ?? "", column: value?.column ?? "" });
  }, [value?.databaseId, value?.table, value?.column]);

  const db = databases.find((d) => d.id === draft.databaseId);
  const table = db?.tables.find((t) => t.name === draft.table);
  const tableNames = db ? db.tables.map((t) => t.name) : [];
  const columnNames = table ? table.columns : [];

  const choose = (next: typeof draft) => {
    setDraft(next);
    if (next.databaseId === "") onChange(null);
    else if (next.table !== "" && next.column !== "") onChange(next);
  };

  return (
    <div className="binding-picker" role="group" aria-label={`${label} の列の対応`}>
      <select aria-label={`${label} の使うデータベース`} value={draft.databaseId} disabled={readOnly} onChange={(e) => choose({ databaseId: e.target.value, table: "", column: "" })}>
        <option value="">列の対応: なし</option>
        {draft.databaseId !== "" && !db && <option value={draft.databaseId}>(存在しないデータベース)</option>}
        {databases.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name || "(名前なし)"}
          </option>
        ))}
      </select>
      {draft.databaseId !== "" && (
        <>
          <select aria-label={`${label} のテーブル`} value={draft.table} disabled={readOnly} onChange={(e) => choose({ ...draft, table: e.target.value, column: "" })}>
            <option value="">テーブルを選ぶ</option>
            {draft.table !== "" && !tableNames.includes(draft.table) && <option value={draft.table}>{draft.table} (存在しない)</option>}
            {tableNames.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select aria-label={`${label} の列`} value={draft.column} disabled={readOnly || draft.table === ""} onChange={(e) => choose({ ...draft, column: e.target.value })}>
            <option value="">列を選ぶ</option>
            {draft.column !== "" && !columnNames.includes(draft.column) && <option value={draft.column}>{draft.column} (存在しない)</option>}
            {columnNames.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
