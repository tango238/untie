// 画面 UI (view。mokkun v2 の ViewV2 を JSON で持つ) の中身を、列の対応 (bindings) の面から読む。純粋関数だけを置く (設計書 5.7)。
// view の形は検証しないので、壊れた形でも落ちないよう、読めるところだけを拾う。

import { VIEW_MAX_DEPTH, VIEW_MAX_NODES } from "./limits";

/** 画面の項目と列の対応の 1 つ分の口。key が bindings の item になる */
export interface ViewBindingSlot {
  key: string;
  /** field は form / readonly / summary の項目、column は list の列 */
  kind: "field" | "column";
  /** セクションの種類 (省略は form)。readonly / summary の計算した値は、列に結ばなくてよい */
  sectionKind: string;
  sectionId: string;
  /** 画面に出す名前 (項目の label、列の label) */
  label: string;
}

/** 一覧の列の対応のキー (bindings の item)。`<セクションの id>.<列の id>` */
export const columnBindingKey = (sectionId: string, columnId: string): string => `${sectionId}.${columnId}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** view の中の、列の対応を付けられる口を並び順に返す。list のセクションは一覧の列 list.columns[] だけ、ほかは項目 fields[].item だけを数える (種類を切り替えたあとの古い中身は数えない)。キーの重複は先のものだけ */
export function viewBindingSlots(view: unknown): ViewBindingSlot[] {
  if (!isObject(view) || !Array.isArray(view.sections)) return [];
  const slots: ViewBindingSlot[] = [];
  const seen = new Set<string>();
  const add = (slot: ViewBindingSlot) => {
    if (slot.key === "" || seen.has(slot.key)) return;
    seen.add(slot.key);
    slots.push(slot);
  };
  for (const section of view.sections) {
    if (!isObject(section)) continue;
    const sectionId = text(section.id);
    const sectionKind = text(section.kind) || "form";
    if (sectionKind !== "list" && Array.isArray(section.fields)) {
      for (const f of section.fields) {
        if (isObject(f)) add({ key: text(f.item), kind: "field", sectionId, label: text(f.label) || text(f.item), sectionKind });
      }
    }
    if (sectionKind === "list" && isObject(section.list) && Array.isArray(section.list.columns)) {
      for (const c of section.list.columns) {
        if (isObject(c) && text(c.id) !== "") add({ key: columnBindingKey(sectionId, text(c.id)), kind: "column", sectionId, label: text(c.label) || text(c.id), sectionKind });
      }
    }
  }
  return slots;
}


/** 画面 UI に使えないキー (オブジェクトの原型を書き換える恐れがある) */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * 画面 UI の形の問題 (深さ VIEW_MAX_DEPTH・節の数 VIEW_MAX_NODES・使えないキー)。無ければ null。
 * 節の数は上限で打ち切って数えるので、YAML のエイリアスで共有された巨大な構造でも速く断れる。循環も深さで断る
 */
export function viewShapeProblem(view: unknown): string | null {
  let nodes = 0;
  const stack: { value: unknown; depth: number }[] = [{ value: view, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (++nodes > VIEW_MAX_NODES) return `画面 UI が大きすぎます (要素が ${VIEW_MAX_NODES} 個を超えています)`;
    if (typeof value !== "object" || value === null) continue;
    if (depth > VIEW_MAX_DEPTH) return `画面 UI が深すぎます (入れ子は ${VIEW_MAX_DEPTH} 段までです)`;
    if (Array.isArray(value)) {
      for (const v of value) stack.push({ value: v, depth: depth + 1 });
      continue;
    }
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) return `画面 UI に使えないキーがあります: ${key}`;
      stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
  return null;
}
