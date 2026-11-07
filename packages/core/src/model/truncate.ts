// 長すぎる文字列の切り詰め (設計書 6 章)。スキーマの上限 (limits.ts) を超えた要素は、そのままだと
// スキーマに合わない「形の壊れた要素」として全員の画面から外され、関係もサーバーに消される。
// そうならないよう、コマンドをすり抜けて Y.Doc に入った長い文字列 (古い版のクライアント・壊れた update など) は、外さずに切り詰める。
import { ANALYSIS_MAX_LENGTH, DSL_MAX_LENGTH, DESCRIPTION_MAX_LENGTH, GROUP_MAX_LENGTH, LINK_TITLE_MAX_LENGTH, LINK_URL_MAX_LENGTH, NAME_MAX_LENGTH, truncateText, VALUE_MAX_LENGTH, VERIFICATION_MAX_LENGTH, TRIGGER_NOTE_MAX_LENGTH } from "./limits";
import { ELEMENT_KIND_LABELS, ISSUE_ANALYSIS_KEYS, ISSUE_ANALYSIS_LABELS } from "./types";
import type { Database, DesignScreen, Layout, Transition, UntieModel } from "./types";
import type { Element } from "./types";

/** 文字列なら切り詰めて返す。切り詰めたら fields に項目名を足す。文字列でなければそのまま (型の不正は形の検査が外す) */
function cut(value: unknown, max: number, field: string, fields: string[]): unknown {
  if (typeof value !== "string") return value;
  const cutValue = truncateText(value, max);
  if (cutValue !== value && !fields.includes(field)) fields.push(field);
  return cutValue;
}

export interface TruncatedElement<T> {
  element: T;
  /** 切り詰めた項目の名前 (日本語。要素の中身は含まない) */
  fields: string[];
}

/**
 * 要素の長すぎる文字列を切り詰める。何も切らなければ同じ参照を返す。
 * 形がまだ検査されていない値を受けるので、型は unknown 寄りに扱い、文字列でない項目には触れない
 */
export function truncateElementStrings<T extends object>(element: T): TruncatedElement<T> {
  const fields: string[] = [];
  const src = element as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  if ("name" in src) out.name = cut(src.name, NAME_MAX_LENGTH, "名前", fields);
  if ("description" in src) out.description = cut(src.description, DESCRIPTION_MAX_LENGTH, "説明", fields);
  if ("group" in src) out.group = cut(src.group, GROUP_MAX_LENGTH, "状態グループ", fields);
  if ("verification" in src) out.verification = cut(src.verification, VERIFICATION_MAX_LENGTH, "検証方法", fields);
  if ("triggerNote" in src) {
    out.triggerNote = cut(src.triggerNote, TRIGGER_NOTE_MAX_LENGTH, "起点 (その他)", fields);
    // 空文字は持たない (スキーマの minLength: 1 で要素ごと外されないよう、項目を消す)
    if (out.triggerNote === "") {
      delete out.triggerNote;
      if (!fields.includes("起点 (その他)")) fields.push("起点 (その他)");
    }
  }
  if (Array.isArray(src.values)) out.values = src.values.map((v) => cut(v, VALUE_MAX_LENGTH, "値", fields));
  if (Array.isArray(src.links)) {
    out.links = src.links.map((l) => {
      if (typeof l !== "object" || l === null) return l;
      const link = l as Record<string, unknown>;
      return { ...link, title: cut(link.title, LINK_TITLE_MAX_LENGTH, "リンクの表示名", fields), url: cut(link.url, LINK_URL_MAX_LENGTH, "リンクの URL", fields) };
    });
  }
  if (typeof src.analysis === "object" && src.analysis !== null && !Array.isArray(src.analysis)) {
    const analysis: Record<string, unknown> = { ...(src.analysis as Record<string, unknown>) };
    for (const key of ISSUE_ANALYSIS_KEYS) if (key in analysis) analysis[key] = cut(analysis[key], ANALYSIS_MAX_LENGTH, `分析の${ISSUE_ANALYSIS_LABELS[key]}`, fields);
    out.analysis = analysis;
  }
  if (fields.length === 0) return { element, fields };
  // 元に無かった項目 (undefined) は足さない
  for (const key of Object.keys(out)) if (out[key] === undefined && !(key in src)) delete out[key];
  return { element: out as T, fields };
}

// ---------------------------------------------------------------- 設計データ (0.4.0)
// 設計の name 型の文字列 (ナビの group / label、遷移の label、header.*、bindings の item / table / column、テーブル名、データベース名) と DSL。
// 形がまだ検査されていない値 (Y.Doc から読んだもの) も受けるので、文字列でない項目には触れない。何も切らなければ同じ参照を返す

const mapIf = <T,>(items: unknown, fn: (item: T) => T): T[] | unknown => (Array.isArray(items) ? items.map((i) => (typeof i === "object" && i !== null ? fn(i as T) : i)) : items);

/** 1 つのオブジェクトの文字列項目を切り詰める。切ったら fields に足し、新しいオブジェクトを返す */
function cutFields<T extends object>(value: T, names: Record<string, [number, string]>, fields: string[]): T {
  const src = value as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [key, [max, label]] of Object.entries(names)) {
    if (!(key in src)) continue;
    const cutValue = cut(src[key], max, label, fields);
    if (cutValue !== src[key]) (out ??= { ...src })[key] = cutValue;
  }
  return (out ?? value) as T;
}

const NAME = (label: string): [number, string] => [NAME_MAX_LENGTH, label];

export function truncateDesignScreen<T extends object = DesignScreen>(screen: T): { value: T; fields: string[] } {
  const fields: string[] = [];
  let value = screen;
  const bindings = (value as { bindings?: unknown }).bindings;
  if (Array.isArray(bindings)) {
    const next = mapIf<object>(bindings, (b) => cutFields(b, { item: NAME("項目の対応の項目"), table: NAME("項目の対応のテーブル"), column: NAME("項目の対応の列") }, fields)) as unknown[];
    if (next.some((b, i) => b !== bindings[i])) value = { ...value, bindings: next };
  }
  return { value, fields };
}

export function truncateTransition<T extends object = Transition>(transition: T): { value: T; fields: string[] } {
  const fields: string[] = [];
  return { value: cutFields(transition, { label: NAME("遷移のラベル") }, fields), fields };
}

/** ナビゲーションのグループ 1 つ (id・group・items) */
export function truncateNavGroup<T extends object>(group: T): { value: T; fields: string[] } {
  const fields: string[] = [];
  let value = cutFields(group, { group: NAME("ナビゲーションのグループ名") }, fields);
  const items = (value as { items?: unknown }).items;
  if (Array.isArray(items)) {
    const next = mapIf<object>(items, (i) => cutFields(i, { label: NAME("ナビゲーションの項目名") }, fields)) as unknown[];
    if (next.some((i, k) => i !== items[k])) value = { ...value, items: next };
  }
  return { value, fields };
}

/** レイアウトのうち、ナビゲーション以外 (shell・header) */
export function truncateLayoutBase<T extends object = Layout>(layout: T): { value: T; fields: string[] } {
  const fields: string[] = [];
  let value = layout;
  const header = (value as { header?: unknown }).header;
  if (typeof header === "object" && header !== null && !Array.isArray(header)) {
    const next = cutFields(header, { systemName: NAME("ヘッダーのシステム名"), userName: NAME("ヘッダーのユーザー名"), tenantName: NAME("ヘッダーのテナント名") }, fields);
    if (next !== header) value = { ...value, header: next };
  }
  return { value, fields };
}

export function truncateDatabase<T extends object = Database>(db: T): { value: T; fields: string[] } {
  const fields: string[] = [];
  let value = cutFields(db, { name: NAME("名前"), dsl: [DSL_MAX_LENGTH, "DSL"] }, fields);
  const tables = (value as { tables?: unknown }).tables;
  if (Array.isArray(tables)) {
    const next = mapIf<object>(tables, (tb) => cutFields(tb, { table: NAME("テーブル名") }, fields)) as unknown[];
    if (next.some((tb, i) => tb !== tables[i])) value = { ...value, tables: next };
  }
  return { value, fields };
}

/**
 * モデルの長すぎる文字列 (ファイル名・説明・ボード名・要素の項目) を切り詰める。何も切らなければ同じ参照。
 * changes には id と項目名だけを出す (名前などの中身はログに出さない)
 */
export function truncateModelStrings(model: UntieModel): { model: UntieModel; changes: string[] } {
  const changes: string[] = [];

  const metaFields: string[] = [];
  const metaName = cut(model.meta.name, NAME_MAX_LENGTH, "名前", metaFields) as string;
  const metaDescription = model.meta.description === undefined ? undefined : (cut(model.meta.description, DESCRIPTION_MAX_LENGTH, "説明", metaFields) as string);
  const meta = metaFields.length === 0 ? model.meta : { ...model.meta, name: metaName, ...(metaDescription !== undefined ? { description: metaDescription } : {}) };
  if (metaFields.length > 0) changes.push(`ファイルの${metaFields.join("・")}が長すぎたので切り詰めた`);

  let elementsChanged = false;
  const elements = model.elements.map((e) => {
    const { element, fields } = truncateElementStrings<Element>(e);
    if (fields.length === 0) return e;
    elementsChanged = true;
    changes.push(`${ELEMENT_KIND_LABELS[e.kind]} ${e.id} の${fields.join("・")}が長すぎたので切り詰めた`);
    return element;
  });

  let boardsChanged = false;
  const boards = model.boards.map((b) => {
    const fields: string[] = [];
    const name = cut(b.name, NAME_MAX_LENGTH, "名前", fields) as string;
    if (fields.length === 0) return b;
    boardsChanged = true;
    changes.push(`ボード ${b.id} の名前が長すぎたので切り詰めた`);
    return { ...b, name };
  }) as UntieModel["boards"];

  // 設計データ (0.4.0)
  let designsChanged = false;
  const designs = model.designs.map((d) => {
    const fields: string[] = [];
    const screens = d.screens.map((s) => {
      const r = truncateDesignScreen(s);
      fields.push(...r.fields);
      return r.value;
    });
    const transitions = d.transitions.map((tr) => {
      const r = truncateTransition(tr);
      fields.push(...r.fields);
      return r.value;
    });
    const base = truncateLayoutBase(d.layout);
    fields.push(...base.fields);
    const navigation = d.layout.navigation.map((g) => {
      const r = truncateNavGroup(g);
      fields.push(...r.fields);
      return r.value;
    });
    if (fields.length === 0) return d;
    designsChanged = true;
    changes.push(`システム ${d.systemId} の設計の${[...new Set(fields)].join("・")}が長すぎたので切り詰めた`);
    return { ...d, screens, transitions, layout: { ...base.value, navigation } };
  });

  // データベースの名前・DSL・テーブル名
  let databasesChanged = false;
  const databases = model.databases.map((db) => {
    const r = truncateDatabase(db);
    if (r.fields.length === 0) return db;
    databasesChanged = true;
    changes.push(`データベース ${db.id} の${[...new Set(r.fields)].join("・")}が長すぎたので切り詰めた`);
    return r.value;
  });

  if (changes.length === 0) return { model, changes };
  return {
    model: { ...model, meta, elements: elementsChanged ? elements : model.elements, boards: boardsChanged ? boards : model.boards, designs: designsChanged ? designs : model.designs, databases: databasesChanged ? databases : model.databases },
    changes,
  };
}
