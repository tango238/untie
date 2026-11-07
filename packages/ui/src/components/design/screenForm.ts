// 画面ボードのフォーム編集の部品 (純粋関数)。view は JSON の写しをその場で書き換える (呼ぶ側が写しを作る)。
// 項目と列の対応 (bindings) は、画面 UI の項目のキー (fields[].item、一覧の列は `<セクションの id>.<列の id>`) で結ぶ。
import { columnBindingKey, viewBindingSlots } from "@untie/core/model/designView";
import type { MokkunV2Schema } from "mokkun";

type ComponentV2 = NonNullable<MokkunV2Schema["views"][string]["sections"][number]["fields"]>[number]["component"];

export type Json = Record<string, unknown>;
export interface Binding {
  item: string;
  databaseId: string;
  table: string;
  column: string;
}

/** mokkun v2 の component の一覧 (mokkun の VALID_COMPONENTS_V2 と同じ。mokkun は export していないので写している。型が合わなくなれば typecheck で気づく) */
export const COMPONENTS: readonly ComponentV2[] = [
  "text",
  "number",
  "textarea",
  "date",
  "time",
  "duration",
  "file",
  "photo_grid",
  "select",
  "combobox",
  "radio",
  "checkbox",
  "toggle",
  "browser",
  "badge",
  "chip",
  "status",
  "timeline",
  "map",
];
export const SECTION_KINDS = ["form", "list", "readonly", "summary"] as const;
export const SECTION_KIND_LABELS: Record<(typeof SECTION_KINDS)[number], string> = { form: "form (入力)", list: "list (一覧)", readonly: "readonly (表示)", summary: "summary (要約)" };
export const LAYOUTS = ["stack", "tabs", "sectioned"] as const;
export const ACTION_KINDS = ["submit", "navigate", "custom", "reset"] as const;
export const ACTION_STYLES = ["primary", "secondary", "tertiary", "danger"] as const;
export const COLUMN_TYPES = ["text", "status", "date", "number"] as const;
export const SELECTIONS = ["none", "single", "multiple"] as const;

export const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 読むための配列 (オブジェクトだけ) */
export const items = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : []);

/** 書き換えるための配列。無ければ作る (オブジェクト以外が混じっていても、添字は元のまま) */
export function arrayOf(o: Json, key: string): Json[] {
  const x = o[key];
  if (Array.isArray(x)) return x as Json[];
  const a: Json[] = [];
  o[key] = a;
  return a;
}

/** 値が空 (空文字・undefined) ならキーを消し、そうでなければ置く */
export function setOrDelete(o: Json, key: string, value: unknown): void {
  if (value === undefined || value === "") delete o[key];
  else o[key] = value;
}

export function moveItem<T>(a: T[], index: number, delta: -1 | 1): void {
  const to = index + delta;
  if (to < 0 || to >= a.length) return;
  [a[index], a[to]] = [a[to]!, a[index]!];
}

/** prefix + 連番で、taken に無い最初の名前 */
export function uniqueName(prefix: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** view の中の、セクションの id・項目の item・操作の id */
export function takenIds(view: Json): { sections: Set<string>; items: Set<string>; actions: Set<string> } {
  const sections = new Set<string>();
  const itemSet = new Set<string>();
  const actions = new Set<string>();
  const addAction = (a: unknown) => {
    if (isObject(a) && typeof a.id === "string") actions.add(a.id);
  };
  addAction(view.primaryAction);
  items(view.secondaryActions).forEach(addAction);
  for (const sec of items(view.sections)) {
    sections.add(str(sec.id));
    items(sec.fields).forEach((f) => itemSet.add(str(f.item)));
    items(sec.actions).forEach(addAction);
    if (isObject(sec.list)) {
      items(sec.list.rowActions).forEach(addAction);
      items(sec.list.bulkActions).forEach(addAction);
    }
  }
  return { sections, items: itemSet, actions };
}

/** 対応を置く (key の今の対応は置き換える)。null なら外す */
export function putBinding(bindings: Binding[], key: string, value: Omit<Binding, "item"> | null): void {
  const at = bindings.findIndex((b) => b.item === key);
  if (at >= 0) bindings.splice(at, 1);
  if (value) bindings.push({ item: key, ...value });
}

/** 項目の名前が変わったときに、対応のキーも変える。変え先に対応がすでにあれば、元の対応を捨てる */
export function renameBinding(bindings: Binding[], from: string, to: string): void {
  if (from === to) return;
  const at = bindings.findIndex((b) => b.item === from);
  if (at < 0) return;
  if (bindings.some((b) => b.item === to)) bindings.splice(at, 1);
  else bindings[at] = { ...bindings[at]!, item: to };
}

/** view に無い項目の対応を外す (項目や列を消したときに、対応を残さない) */
export function pruneBindings(view: unknown, bindings: Binding[]): Binding[] {
  const keys = new Set(viewBindingSlots(view).map((s) => s.key));
  return bindings.filter((b) => keys.has(b.item));
}

/** 見つけて書き換えるための部品。同時編集で並びが変わっても同じものを直せるよう、添字ではなく id (セクションの id・項目の item・列の id・操作の id) で探す */
export const findSection = (view: Json, sectionId: string): Json | undefined => arrayOf(view, "sections").find((s) => isObject(s) && str(s.id) === sectionId);
export const findField = (section: Json, item: string): Json | undefined => arrayOf(section, "fields").find((f) => isObject(f) && str(f.item) === item);
/** 一覧の設定 (無ければ空の一覧を作る) */
export function listOf(section: Json): Json {
  if (!isObject(section.list)) section.list = { columns: [] };
  return section.list as Json;
}
export const findColumn = (section: Json, columnId: string): Json | undefined => arrayOf(listOf(section), "columns").find((c) => isObject(c) && str(c.id) === columnId);
export const findSecondary = (view: Json, actionId: string): Json | undefined => arrayOf(view, "secondaryActions").find((a) => isObject(a) && str(a.id) === actionId);

export function moveObject(array: Json[], target: Json, delta: -1 | 1): void {
  const i = array.indexOf(target);
  if (i >= 0) moveItem(array, i, delta);
}
export function removeObject(array: Json[], target: Json): void {
  const i = array.indexOf(target);
  if (i >= 0) array.splice(i, 1);
}

/** 項目の識別子が変わったとき、条件 (visibleWhen / requiredWhen) の item も書き換える */
export function renameItemRefs(view: Json, from: string, to: string): void {
  const fix = (o: unknown) => {
    if (isObject(o) && o.item === from) o.item = to;
  };
  for (const sec of items(view.sections)) {
    fix(sec.visibleWhen);
    for (const f of items(sec.fields)) {
      fix(f.visibleWhen);
      fix(f.requiredWhen);
    }
    if (isObject(sec.list)) {
      for (const c of items(sec.list.columns)) if (isObject(c.field)) {
        fix(c.field.visibleWhen);
        fix(c.field.requiredWhen);
      }
    }
  }
}

/** 列の id が変わったとき、代表行 (list.rows) のキーも書き換える */
export function renameRowKeys(section: Json, from: string, to: string): void {
  if (!isObject(section.list)) return;
  for (const row of items(section.list.rows)) {
    if (from in row && !(to in row)) {
      row[to] = row[from];
      delete row[from];
    }
  }
}

export { columnBindingKey };
