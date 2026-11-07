// 長すぎる文字列の切り詰め (設計書 6 章)。スキーマの上限 (limits.ts) を超えた要素は、そのままだと
// スキーマに合わない「形の壊れた要素」として全員の画面から外され、関係もサーバーに消される。
// そうならないよう、コマンドをすり抜けて Y.Doc に入った長い文字列 (古い版のクライアント・壊れた update など) は、外さずに切り詰める。
import { ANALYSIS_MAX_LENGTH, DESCRIPTION_MAX_LENGTH, GROUP_MAX_LENGTH, LINK_TITLE_MAX_LENGTH, LINK_URL_MAX_LENGTH, NAME_MAX_LENGTH, truncateText, VALUE_MAX_LENGTH, VERIFICATION_MAX_LENGTH, TRIGGER_NOTE_MAX_LENGTH } from "./limits";
import { ELEMENT_KIND_LABELS, ISSUE_ANALYSIS_KEYS, ISSUE_ANALYSIS_LABELS } from "./types";
import type { Element, UntieModel } from "./types";

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

  if (changes.length === 0) return { model, changes };
  return {
    model: { ...model, meta, elements: elementsChanged ? elements : model.elements, boards: boardsChanged ? boards : model.boards },
    changes,
  };
}
