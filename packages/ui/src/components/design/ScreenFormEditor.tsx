import { useState, type ReactNode } from "react";
import { LIMITS } from "@untie/core/model/limits";
import { CommitField } from "../CommitField";
import { ConfirmDialog } from "../ConfirmDialog";
import { BindingPicker, type DbInfo } from "./BindingPicker";
import {
  ACTION_KINDS,
  ACTION_STYLES,
  arrayOf,
  COLUMN_TYPES,
  findColumn,
  findField,
  findSection,
  findSecondary,
  listOf,
  moveObject,
  removeObject,
  renameItemRefs,
  renameRowKeys,
  COMPONENTS,
  columnBindingKey,
  isObject,
  items,
  LAYOUTS,
  putBinding,
  renameBinding,
  SECTION_KIND_LABELS,
  SECTION_KINDS,
  SELECTIONS,
  setOrDelete,
  str,
  takenIds,
  uniqueName,
  type Binding,
  type Json,
} from "./screenForm";

/** 画面の編集の口。view と bindings の写しを渡すので、その場で書き換える。1 回の呼び出しが 1 回の dispatch (1 件の履歴) になる */
export type EditFn = (fn: (view: Json, bindings: Binding[]) => unknown) => void;
// fn が false を返したときは、何も変えない (対象が見つからない・入力を断った)

interface Props {
  view: Json;
  bindings: Binding[];
  screens: { id: string; name: string }[];
  databases: DbInfo[];
  readOnly: boolean;
  edit: EditFn;
  /** 断った理由などをトーストで知らせる */
  notify: (message: string) => void;
}

const bindingValue = (bindings: Binding[], key: string) => {
  const b = bindings.find((x) => x.item === key);
  return b ? { databaseId: b.databaseId, table: b.table, column: b.column } : undefined;
};

/** 上へ・下へ・削除の 3 つのボタン */
function Buttons({ what, index, count, readOnly, onMove, onRemove, removeDisabled }: { what: string; index: number; count: number; readOnly: boolean; onMove: (d: -1 | 1) => void; onRemove: () => void; removeDisabled?: boolean }) {
  if (readOnly) return null;
  return (
    <span className="nav-buttons">
      <button type="button" aria-label={`${what} を上へ`} disabled={index === 0} onClick={() => onMove(-1)}>
        ↑
      </button>
      <button type="button" aria-label={`${what} を下へ`} disabled={index === count - 1} onClick={() => onMove(1)}>
        ↓
      </button>
      <button type="button" aria-label={`${what} を削除`} disabled={removeDisabled} onClick={onRemove}>
        ×
      </button>
    </span>
  );
}

/** 遷移先の画面の select (「なし」を含む)。いまの値が設計に無いときは、その旨の選択肢を出す */
function ScreenSelect({ label, value, screens, readOnly, onChange, allowNone = true }: { label: string; value: string; screens: Props["screens"]; readOnly: boolean; onChange: (v: string) => void; allowNone?: boolean }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select aria-label={label} value={value} disabled={readOnly} onChange={(e) => onChange(e.target.value)}>
        {(allowNone || value === "") && <option value="">なし</option>}
        {value !== "" && !screens.some((s) => s.id === value) && <option value={value}>(設計に無い画面)</option>}
        {screens.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Select({ label, value, options, readOnly, onChange }: { label: string; value: string; options: { value: string; label: string }[]; readOnly: boolean; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select aria-label={label} value={value} disabled={readOnly} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 操作 (主・補助) 1 つの編集 */
function ActionEditor({ what, action, screens, readOnly, onPatch, buttons }: { what: string; action: Json; screens: Props["screens"]; readOnly: boolean; onPatch: (fn: (a: Json) => void) => void; buttons: ReactNode }) {
  const kind = str(action.kind);
  // 「補助の操作 1」のように数字で終わる名前は、あとに空白を挟む
  const sp = /\d$/.test(what) ? " " : "";
  // 種類を省いた操作は送信 (submit) として扱う
  const hasTarget = kind === "navigate" || (kind || "submit") === "submit";
  return (
    <div className="screen-card">
      <div className="nav-row">
        <CommitField label={`${what}${sp}の文言`} value={str(action.label)} maxLength={LIMITS.name.max} readOnly={readOnly} onCommit={(v) => onPatch((a) => (a.label = v))} />
        {buttons}
      </div>
      <div className="screen-grid">
        <Select
          label={`${what}${sp}の種類`}
          value={kind}
          readOnly={readOnly}
          options={[{ value: "", label: "(既定)" }, ...ACTION_KINDS.map((k) => ({ value: k, label: k }))]}
          onChange={(v) =>
            onPatch((a) => {
              setOrDelete(a, "kind", v);
              // 遷移は行き先が要る。遷移でも送信でもなくなったら、行き先は外す
              if (v === "navigate" && str(a.to) === "" && screens[0]) a.to = screens[0].id;
              if (v !== "navigate" && v !== "submit") delete a.to;
            })
          }
        />
        {hasTarget && <ScreenSelect label={`${what}${sp}の遷移先`} value={str(action.to)} screens={screens} readOnly={readOnly} allowNone={kind !== "navigate"} onChange={(v) => onPatch((a) => setOrDelete(a, "to", v))} />}
        <Select
          label={`${what}${sp}の見た目`}
          value={str(action.style)}
          readOnly={readOnly}
          options={[{ value: "", label: "(既定)" }, ...ACTION_STYLES.map((k) => ({ value: k, label: k }))]}
          onChange={(v) => onPatch((a) => setOrDelete(a, "style", v))}
        />
      </div>
    </div>
  );
}

/** 画面 UI のフォーム編集: 画面の基本・セクション (項目・一覧の列・列の対応)・操作。要素は添字ではなく id で探して書き換える */
export function ScreenFormEditor({ view, bindings, screens, databases, readOnly, edit, notify }: Props) {
  const sections = items(view.sections);
  const secondary = items(view.secondaryActions);
  const primary = isObject(view.primaryAction) ? view.primaryAction : undefined;
  // 断った入力を元に戻すため、フォーム全体を作り直す印
  const [nonce, setNonce] = useState(0);
  const [pendingList, setPendingList] = useState<string | null>(null);
  const reject = (message: string) => {
    notify(message);
    setNonce((n) => n + 1);
  };

  const patchSection = (sid: string, fn: (sec: Json) => void) =>
    edit((v) => {
      const sec = findSection(v, sid);
      if (!sec) return false;
      fn(sec);
    });
  const applyKind = (sid: string, kind: string) =>
    patchSection(sid, (s) => {
      s.kind = kind;
      if (kind === "list") {
        // 一覧にした区画の項目は消す。一覧には列が 1 つ以上要る (mokkun の決まり)
        delete s.fields;
        if (!isObject(s.list) || items(s.list.columns).length === 0) s.list = { columns: [{ id: "col1", label: "列 1" }] };
      } else {
        // 項目の区画に戻すときは、一覧の設定を消す
        delete s.list;
      }
    });
  const changeKind = (sec: Json, kind: string) => {
    if (kind === "list" && items(sec.fields).length > 0) setPendingList(str(sec.id));
    else applyKind(str(sec.id), kind);
  };

  return (
    <div className="screen-form" key={nonce}>
      <section className="screen-block" aria-label="画面の基本">
        <h3 className="screen-heading">画面の基本</h3>
        <Select
          label="セクションの並べ方 (layout)"
          value={str(view.layout)}
          readOnly={readOnly}
          options={[{ value: "", label: "(既定: stack)" }, ...LAYOUTS.map((l) => ({ value: l, label: l }))]}
          onChange={(v) => edit((d) => setOrDelete(d, "layout", v))}
        />
      </section>

      <section className="screen-block" aria-label="セクション">
        <h3 className="screen-heading">セクション</h3>
        <ul className="screen-list">
          {sections.map((sec, si) => {
            const sid = str(sec.id);
            const kind = str(sec.kind) || "form";
            const isList = kind === "list";
            const n = si + 1;
            const secs = (v: Json) => arrayOf(v, "sections");
            return (
              <li key={`${si}:${sid}`} className="screen-card" data-section={sid}>
                <div className="nav-row">
                  <CommitField label={`セクション ${n} の見出し`} value={str(sec.title)} maxLength={LIMITS.name.max} readOnly={readOnly} onCommit={(v) => patchSection(sid, (s) => (s.title = v))} />
                  <Buttons
                    what={`セクション ${n}`}
                    index={si}
                    count={sections.length}
                    readOnly={readOnly}
                    onMove={(d) =>
                      edit((v) => {
                        const target = findSection(v, sid);
                        if (!target) return false;
                        moveObject(secs(v), target, d);
                      })
                    }
                    onRemove={() =>
                      edit((v) => {
                        const target = findSection(v, sid);
                        if (!target) return false;
                        removeObject(secs(v), target);
                      })
                    }
                  />
                </div>
                <div className="screen-grid">
                  <Select
                    label={`セクション ${n} の種類`}
                    value={kind}
                    readOnly={readOnly}
                    options={SECTION_KINDS.map((k) => ({ value: k, label: SECTION_KIND_LABELS[k] }))}
                    onChange={(v) => changeKind(sec, v)}
                  />
                  <Select
                    label={`セクション ${n} の列数`}
                    value={String(sec.columns ?? "")}
                    readOnly={readOnly}
                    options={[{ value: "", label: "(既定)" }, ...["1", "2", "3"].map((c) => ({ value: c, label: c }))]}
                    onChange={(v) => patchSection(sid, (s) => (v === "" ? delete s.columns : (s.columns = Number(v))))}
                  />
                </div>
                <CommitField label={`セクション ${n} の注記`} value={str(sec.note)} maxLength={LIMITS.description.max} readOnly={readOnly} onCommit={(v) => patchSection(sid, (s) => setOrDelete(s, "note", v.trim()))} />

                {isList ? (
                  <ListEditor sec={sec} n={n} bindings={bindings} screens={screens} databases={databases} readOnly={readOnly} edit={edit} reject={reject} />
                ) : (
                  <ul className="screen-list">
                    {items(sec.fields).map((f, fi) => {
                      const item = str(f.item);
                      const what = `項目 ${n}-${fi + 1}`;
                      const patchField = (fn: (field: Json) => void) =>
                        edit((v) => {
                          const field = findField(findSection(v, sid) ?? {}, item);
                          if (!field) return false;
                          fn(field);
                        });
                      return (
                        <li key={`${fi}:${item}`} className="screen-card is-field" data-field={item}>
                          <div className="nav-row">
                            <CommitField
                              label={`${what} の識別子`}
                              value={item}
                              maxLength={LIMITS.name.max}
                              readOnly={readOnly}
                              onCommit={(raw) =>
                                edit((d, b) => {
                                  const next = raw.trim();
                                  if (next === item) return false;
                                  if (next === "") {
                                    reject("項目の識別子は空にできません");
                                    return false;
                                  }
                                  if (takenIds(d).items.has(next)) return void reject(`項目の識別子「${next}」は、この画面ですでに使っています`), false;
                                  const field = findField(findSection(d, sid) ?? {}, item);
                                  if (!field) return false;
                                  renameBinding(b, item, next);
                                  renameItemRefs(d, item, next);
                                  field.item = next;
                                })
                              }
                            />
                            <Buttons
                              what={what}
                              index={fi}
                              count={items(sec.fields).length}
                              readOnly={readOnly}
                              onMove={(dl) =>
                                edit((d) => {
                                  const s = findSection(d, sid);
                                  const field = s && findField(s, item);
                                  if (!s || !field) return false;
                                  moveObject(arrayOf(s, "fields"), field, dl);
                                })
                              }
                              onRemove={() =>
                                edit((d) => {
                                  const s = findSection(d, sid);
                                  const field = s && findField(s, item);
                                  if (!s || !field) return false;
                                  removeObject(arrayOf(s, "fields"), field);
                                })
                              }
                            />
                          </div>
                          <CommitField label={`${what} のラベル`} value={str(f.label)} maxLength={LIMITS.name.max} readOnly={readOnly} onCommit={(v) => patchField((x) => (x.label = v))} />
                          <CommitField label={`${what} の例 (example)`} value={str(f.example)} maxLength={LIMITS.description.max} readOnly={readOnly} onCommit={(v) => patchField((x) => setOrDelete(x, "example", v.trim()))} />
                          <div className="screen-grid">
                            <Select
                              label={`${what} の部品`}
                              value={str(f.component)}
                              readOnly={readOnly}
                              options={[...(COMPONENTS.includes(str(f.component) as never) ? [] : [{ value: str(f.component), label: str(f.component) || "(未設定)" }]), ...COMPONENTS.map((c) => ({ value: c, label: c }))]}
                              onChange={(v) => patchField((x) => (x.component = v))}
                            />
                            <label className="check-row">
                              <input type="checkbox" aria-label={`${what} は必須`} checked={f.required === true} disabled={readOnly} onChange={(e) => patchField((x) => (e.target.checked ? (x.required = true) : delete x.required))} />
                              必須
                            </label>
                            <label className="check-row">
                              <input type="checkbox" aria-label={`${what} は読み取り専用`} checked={f.readonly === true} disabled={readOnly} onChange={(e) => patchField((x) => (e.target.checked ? (x.readonly = true) : delete x.readonly))} />
                              読み取り専用
                            </label>
                          </div>
                          <BindingPicker label={what} value={bindingValue(bindings, item)} databases={databases} readOnly={readOnly} onChange={(val) => edit((_d, b) => putBinding(b, item, val))} />
                        </li>
                      );
                    })}
                  </ul>
                )}
                {!readOnly && !isList && (
                  <button
                    type="button"
                    className="nav-add-item"
                    aria-label={`セクション ${n} に項目を足す`}
                    onClick={() =>
                      edit((v) => {
                        const s = findSection(v, sid);
                        if (!s) return false;
                        arrayOf(s, "fields").push({ item: uniqueName("item", takenIds(v).items), label: "新しい項目", component: "text" });
                      })
                    }
                  >
                    ＋項目
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {!readOnly && (
          <button
            type="button"
            className="nav-add-group"
            onClick={() => edit((v) => arrayOf(v, "sections").push({ id: uniqueName("section", takenIds(v).sections), title: "新しいセクション", kind: "form", fields: [] }))}
          >
            ＋セクション
          </button>
        )}
      </section>

      <section className="screen-block" aria-label="操作">
        <h3 className="screen-heading">操作</h3>
        {primary ? (
          <ActionEditor
            what="主の操作"
            action={primary}
            screens={screens}
            readOnly={readOnly}
            onPatch={(fn) => edit((v) => fn(v.primaryAction as Json))}
            buttons={
              readOnly ? null : (
                <span className="nav-buttons">
                  <button type="button" aria-label="主の操作を削除" onClick={() => edit((v) => delete v.primaryAction)}>
                    ×
                  </button>
                </span>
              )
            }
          />
        ) : (
          !readOnly && (
            <button type="button" className="nav-add-item" onClick={() => edit((v) => (v.primaryAction = { id: uniqueName("action", takenIds(v).actions), label: "送信する", kind: "submit", style: "primary" }))}>
              ＋主の操作
            </button>
          )
        )}
        <ul className="screen-list">
          {secondary.map((a, ai) => {
            const aid = str(a.id);
            return (
              <li key={`${ai}:${aid}`}>
                <ActionEditor
                  what={`補助の操作 ${ai + 1}`}
                  action={a}
                  screens={screens}
                  readOnly={readOnly}
                  onPatch={(fn) =>
                    edit((v) => {
                      const target = findSecondary(v, aid);
                      if (!target) return false;
                      fn(target);
                    })
                  }
                  buttons={
                    <Buttons
                      what={`補助の操作 ${ai + 1}`}
                      index={ai}
                      count={secondary.length}
                      readOnly={readOnly}
                      onMove={(d) =>
                        edit((v) => {
                          const target = findSecondary(v, aid);
                          if (!target) return false;
                          moveObject(arrayOf(v, "secondaryActions"), target, d);
                        })
                      }
                      onRemove={() =>
                        edit((v) => {
                          const target = findSecondary(v, aid);
                          if (!target) return false;
                          removeObject(arrayOf(v, "secondaryActions"), target);
                          if (arrayOf(v, "secondaryActions").length === 0) delete v.secondaryActions;
                        })
                      }
                    />
                  }
                />
              </li>
            );
          })}
        </ul>
        {!readOnly && (
          <button type="button" className="nav-add-item" onClick={() => edit((v) => arrayOf(v, "secondaryActions").push({ id: uniqueName("action", takenIds(v).actions), label: "新しい操作", kind: "custom" }))}>
            ＋補助の操作
          </button>
        )}
      </section>
      {pendingList !== null && (
        <ConfirmDialog
          title="一覧にする"
          message="このセクションの項目は消えます (項目の列の対応も外れます)。一覧の列は新しく作ります。"
          confirmLabel="項目を消して一覧にする"
          danger
          onConfirm={() => {
            applyKind(pendingList, "list");
            setPendingList(null);
          }}
          onCancel={() => setPendingList(null)}
        />
      )}
    </div>
  );
}

/** 一覧セクションの中身: 列 (id・見出し・型・遷移先・列の対応) と、検索・選択・ページの大きさ */
function ListEditor({ sec, n, bindings, screens, databases, readOnly, edit, reject }: { sec: Json; n: number; bindings: Binding[]; screens: Props["screens"]; databases: DbInfo[]; readOnly: boolean; edit: EditFn; reject: (message: string) => void }) {
  const sid = str(sec.id);
  const list = isObject(sec.list) ? sec.list : {};
  const columns = items(list.columns);
  const patchList = (fn: (l: Json, section: Json) => void) =>
    edit((v) => {
      const s = findSection(v, sid);
      if (!s) return false;
      fn(listOf(s), s);
    });
  const pageSize = isObject(list.paging) && typeof list.paging.pageSize === "number" ? String(list.paging.pageSize) : "";
  return (
    <div className="screen-list-editor">
      <div className="screen-grid">
        <label className="check-row">
          <input type="checkbox" aria-label={`セクション ${n} は検索あり`} checked={list.search === true} disabled={readOnly} onChange={(e) => patchList((l) => (e.target.checked ? (l.search = true) : delete l.search))} />
          検索
        </label>
        <Select
          label={`セクション ${n} の行の選択`}
          value={str(list.selection)}
          readOnly={readOnly}
          options={[{ value: "", label: "(既定)" }, ...SELECTIONS.map((x) => ({ value: x, label: x }))]}
          onChange={(x) => patchList((l) => setOrDelete(l, "selection", x))}
        />
        <CommitField
          label={`セクション ${n} の 1 ページの行数`}
          value={pageSize}
          readOnly={readOnly}
          onCommit={(text) =>
            patchList((l) => {
              const size = Math.floor(Number(text.trim()));
              if (text.trim() === "" || !(size >= 1)) delete l.paging;
              else l.paging = { ...(isObject(l.paging) ? l.paging : {}), pageSize: size };
            })
          }
        />
      </div>
      <ul className="screen-list">
        {columns.map((c, ci) => {
          const cid = str(c.id);
          const key = columnBindingKey(sid, cid);
          const what = `列 ${n}-${ci + 1}`;
          const patchColumn = (fn: (col: Json) => void) =>
            edit((v) => {
              const col = findColumn(findSection(v, sid) ?? {}, cid);
              if (!col) return false;
              fn(col);
            });
          return (
            <li key={`${ci}:${cid}`} className="screen-card is-field" data-column={cid}>
              <div className="nav-row">
                <CommitField
                  label={`${what} の id`}
                  value={cid}
                  maxLength={LIMITS.name.max}
                  readOnly={readOnly}
                  onCommit={(raw) =>
                    edit((d, b) => {
                      const next = raw.trim();
                      if (next === cid) return false;
                      if (next === "") return void reject("列の id は空にできません"), false;
                      const s = findSection(d, sid);
                      if (!s) return false;
                      if (items(listOf(s).columns).some((x) => str(x.id) === next)) return void reject(`列の id「${next}」は、このセクションですでに使っています`), false;
                      const col = findColumn(s, cid);
                      if (!col) return false;
                      renameBinding(b, key, columnBindingKey(sid, next));
                      renameRowKeys(s, cid, next);
                      col.id = next;
                    })
                  }
                />
                <Buttons
                  what={what}
                  index={ci}
                  count={columns.length}
                  readOnly={readOnly}
                  removeDisabled={columns.length <= 1}
                  onMove={(d) =>
                    edit((v) => {
                      const s = findSection(v, sid);
                      const col = s && findColumn(s, cid);
                      if (!s || !col) return false;
                      moveObject(arrayOf(listOf(s), "columns"), col, d);
                    })
                  }
                  onRemove={() =>
                    edit((v) => {
                      const s = findSection(v, sid);
                      const col = s && findColumn(s, cid);
                      if (!s || !col) return false;
                      removeObject(arrayOf(listOf(s), "columns"), col);
                    })
                  }
                />
              </div>
              <CommitField label={`${what} の見出し`} value={str(c.label)} maxLength={LIMITS.name.max} readOnly={readOnly} onCommit={(v) => patchColumn((x) => (x.label = v))} />
              <div className="screen-grid">
                <Select
                  label={`${what} の型`}
                  value={str(c.type)}
                  readOnly={readOnly}
                  options={[{ value: "", label: "(既定: text)" }, ...COLUMN_TYPES.map((t) => ({ value: t, label: t }))]}
                  onChange={(t) => patchColumn((x) => setOrDelete(x, "type", t))}
                />
                <ScreenSelect label={`${what} の遷移先`} value={str(c.to)} screens={screens} readOnly={readOnly} onChange={(t) => patchColumn((x) => setOrDelete(x, "to", t))} />
              </div>
              <BindingPicker label={what} value={bindingValue(bindings, key)} databases={databases} readOnly={readOnly} onChange={(val) => edit((_d, b) => putBinding(b, key, val))} />
            </li>
          );
        })}
      </ul>
      {!readOnly && (
        <button
          type="button"
          className="nav-add-item"
          aria-label={`セクション ${n} に列を足す`}
          onClick={() =>
            patchList((l) => {
              const cols = arrayOf(l, "columns");
              cols.push({ id: uniqueName("col", new Set(cols.map((x) => str(x.id)))), label: "新しい列" });
            })
          }
        >
          ＋列
        </button>
      )}
    </div>
  );
}
