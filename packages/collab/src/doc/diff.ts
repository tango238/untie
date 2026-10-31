import * as Y from "yjs";
import type { Board, Element, IssueAnalysis, UntieModel } from "@untie/core";
import { cloneJson, deepEqual } from "./json";
import { initialOrders, planOrders } from "./order";
import { isUndirected, RELATION_KINDS } from "@untie/core";
import { getRoots, ORDER_KEY } from "./roots";
import type { EdgeRecord, NodeRecord, RelationRecord, UntieDocRoots } from "./roots";
import { boardToYMap, edgeFields, elementToYMap, ELEMENT_SKIPPED_KEYS, analysisToYMap, nodeFields, relationFields } from "./write";

/** 配列 (id を持つ項目の並び) を Y.Map に書くための部品 */
interface ListAdapter<T> {
  idOf(item: T): string;
  /** Y.Doc にその id の項目があるか */
  has(id: string): boolean;
  /** Y.Doc にある順序キー */
  getOrder(id: string): string | undefined;
  remove(id: string): void;
  /** 新しい項目を書く */
  create(item: T, order: string): void;
  /** 内容が変わったか (before と after は同じ id) */
  changed(before: T, after: T): boolean;
  /** 変わった項目を書く (Y.Doc にあるときだけ呼ばれる)。order があれば順序キーも同時に書く (1 つの項目につき書き込みは 1 回) */
  update(before: T, after: T, order?: string): void;
  /** 並びを満たすために順序キーだけ振り直す */
  setOrder(item: T, order: string): void;
}

/**
 * before から after への配列の差分を id 単位で書く。
 * - 消えた id は消し、新しい id は書き、変わった id は変わった分だけ書く。
 * - after の並びを満たすように、新しい項目には隣のキーの間の値を振る。既存の順が入れ替わっていたら最小限のキーだけ振り直す。
 * - 変わった項目でも、Y.Doc に無ければ (ほかの人が消した) 書かない。消した側を勝たせる。
 */
function syncList<T>(before: readonly T[], after: readonly T[], ad: ListAdapter<T>): void {
  if (before === after) return;
  const beforeById = new Map(before.map((t) => [ad.idOf(t), t]));
  const afterById = new Map(after.map((t) => [ad.idOf(t), t]));
  for (const id of beforeById.keys()) if (!afterById.has(id)) ad.remove(id);

  const added = after.filter((t) => !beforeById.has(ad.idOf(t)));
  const addedIds = new Set(added.map((t) => ad.idOf(t)));
  const changed: [T, T][] = [];
  const changedIds = new Set<string>();
  for (const t of after) {
    const b = beforeById.get(ad.idOf(t));
    if (b !== undefined && b !== t && ad.has(ad.idOf(t)) && ad.changed(b, t)) {
      changed.push([b, t]);
      changedIds.add(ad.idOf(t));
    }
  }

  // 並びが before と変わったときだけ順序キーを計画する
  const sameSequence = before.length === after.length && before.every((t, i) => ad.idOf(t) === ad.idOf(after[i]));
  const plan = sameSequence
    ? new Map<string, string>()
    : planOrders(
        after.map((t) => ad.idOf(t)).filter((id) => addedIds.has(id) || ad.has(id)),
        (id) => (addedIds.has(id) ? undefined : ad.getOrder(id)),
      );

  for (const t of added) ad.create(t, plan.get(ad.idOf(t))!);
  // 内容が変わって順序キーも振り直す項目は、まとめて 1 回で書く
  for (const [b, t] of changed) ad.update(b, t, plan.get(ad.idOf(t)));
  for (const [id, order] of plan) if (!addedIds.has(id) && !changedIds.has(id)) ad.setOrder(afterById.get(id)!, order);
}

// ---------------------------------------------------------------- メタ

function syncMeta(meta: Y.Map<unknown>, before: UntieModel["meta"], after: UntieModel["meta"]): void {
  if (before === after) return;
  if (before.name !== after.name) meta.set("name", after.name);
  if (before.description !== after.description) {
    if (after.description === undefined) meta.delete("description");
    else meta.set("description", after.description);
  }
}

// ---------------------------------------------------------------- 要素

/** 課題の分析を項目ごとに書く (空の Y.Map は残す) */
function syncAnalysis(ymap: Y.Map<unknown>, before: IssueAnalysis | undefined, after: IssueAnalysis | undefined): void {
  const current = ymap.get("analysis");
  if (!(current instanceof Y.Map)) {
    ymap.set("analysis", analysisToYMap(after ?? {}));
    return;
  }
  // 分析が無くなったときも Y.Map は残し、項目だけ消す
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (a[key] === undefined) {
      if (b[key] !== undefined) current.delete(key);
    } else if (!deepEqual(a[key], b[key])) {
      current.set(key, a[key]);
    }
  }
}

/** 要素の項目を Y.Map の値ごとに書く (未定義の項目はキーを消す) */
function syncElementFields(ymap: Y.Map<unknown>, before: Element, after: Element): void {
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (ELEMENT_SKIPPED_KEYS.has(key)) continue;
    if (key === "analysis") {
      if (!deepEqual(b[key], a[key])) syncAnalysis(ymap, b[key] as IssueAnalysis | undefined, a[key] as IssueAnalysis | undefined);
    } else if (a[key] === undefined) {
      if (b[key] !== undefined) ymap.delete(key);
    } else if (!deepEqual(a[key], b[key])) {
      ymap.set(key, cloneJson(a[key]));
    }
  }
}

function elementAdapter(map: Y.Map<Y.Map<unknown>>): ListAdapter<Element> {
  return {
    idOf: (e) => e.id,
    has: (id) => map.get(id) instanceof Y.Map,
    getOrder: (id) => map.get(id)?.get(ORDER_KEY) as string | undefined,
    remove: (id) => map.delete(id),
    create: (e, order) => map.set(e.id, elementToYMap(e, order)),
    changed: (b, a) => !deepEqual(b, a),
    update(b, a, order) {
      const ymap = map.get(a.id)!;
      syncElementFields(ymap, b, a);
      if (order !== undefined) ymap.set(ORDER_KEY, order);
    },
    setOrder: (e, order) => map.get(e.id)!.set(ORDER_KEY, order),
  };
}

// ---------------------------------------------------------------- 値ごとに置く項目 (関係・ノード・線)

function recordAdapter<T, R extends { order: string }>(
  map: Y.Map<R>,
  idOf: (t: T) => string,
  fields: (t: T) => Omit<R, "order">,
): ListAdapter<T> {
  const write = (t: T, order: string) => map.set(idOf(t), { ...fields(t), order } as R);
  return {
    idOf,
    has: (id) => map.has(id),
    getOrder: (id) => map.get(id)?.order,
    remove: (id) => map.delete(id),
    create: write,
    changed: (b, a) => !deepEqual(fields(b), fields(a)),
    // 値ごと書く。順序キーは、振り直すものがなければ Y.Doc にあるものを引き継ぐ
    update: (_b, a, order) => write(a, order ?? map.get(idOf(a))!.order),
    setOrder: write,
  };
}

// ---------------------------------------------------------------- ボード

function getOrCreateMap<V>(board: Y.Map<unknown>, key: string): Y.Map<V> {
  const existing = board.get(key);
  if (existing instanceof Y.Map) return existing as Y.Map<V>;
  const created = new Y.Map<V>();
  board.set(key, created);
  return created;
}

function boardAdapter(map: Y.Map<Y.Map<unknown>>): ListAdapter<Board> {
  return {
    idOf: (b) => b.id,
    has: (id) => map.get(id) instanceof Y.Map,
    getOrder: (id) => map.get(id)?.get(ORDER_KEY) as string | undefined,
    remove: (id) => map.delete(id),
    create: (b, order) => map.set(b.id, boardToYMap(b, order, initialOrders(b.nodes.length), initialOrders((b.edges ?? []).length))),
    changed: (b, a) => !deepEqual(b, a),
    update(b, a, order) {
      const ymap = map.get(a.id)!;
      if (order !== undefined) ymap.set(ORDER_KEY, order);
      if (b.name !== a.name) ymap.set("name", a.name);
      if (b.nodes !== a.nodes) {
        syncList(b.nodes, a.nodes, recordAdapter<Board["nodes"][number], NodeRecord>(getOrCreateMap(ymap, "nodes"), (n) => n.elementId, nodeFields));
      }
      if (b.edges !== a.edges) {
        syncList(b.edges ?? [], a.edges ?? [], recordAdapter<NonNullable<Board["edges"]>[number], EdgeRecord>(getOrCreateMap(ymap, "edges"), (e) => e.relationId, edgeFields));
      }
    },
    setOrder: (b, order) => map.get(b.id)!.set(ORDER_KEY, order),
  };
}

/**
 * 関係を消したとき、Y.Doc に残っている同じ関係 (sameRelation) の重複と、その線の設定も消す。
 * 残すと、見えていた方を消した途端に、表示から外れていた重複の方が現れてしまう。
 */
function removeHiddenDuplicates(roots: UntieDocRoots, before: UntieModel, after: UntieModel): void {
  const keptIds = new Set(after.relations.map((r) => r.id));
  const keys = new Set<string>();
  for (const r of before.relations) {
    if (keptIds.has(r.id) || !(RELATION_KINDS as readonly string[]).includes(r.kind)) continue;
    keys.add(`${r.kind}\0${r.sourceId}\0${r.targetId}`);
    if (isUndirected(r.kind)) keys.add(`${r.kind}\0${r.targetId}\0${r.sourceId}`);
  }
  if (keys.size === 0) return;
  const duplicates: string[] = [];
  roots.relations.forEach((rec, id) => {
    if (keptIds.has(id) || typeof rec !== "object" || rec === null) return;
    if (keys.has(`${rec.kind}\0${rec.sourceId}\0${rec.targetId}`)) duplicates.push(id);
  });
  for (const id of duplicates) {
    roots.relations.delete(id);
    roots.boards.forEach((board) => {
      const edges = board.get("edges");
      if (edges instanceof Y.Map) edges.delete(id);
    });
  }
}

/**
 * Y.Doc のボードが 0 枚のとき、before のボード (表示用に補った board_main) を Y.Doc に作る。
 * 作らないと、補ったボードへの編集 (ノードを置くなど) が Y.Doc に届かず消える。
 * id は固定 (サーバーの修復と同じ) なので、両方が作っても 1 つのボードに合流する。
 */
function materializeFallbackBoards(roots: UntieDocRoots, before: UntieModel): void {
  if (roots.boards.size > 0) return;
  const orders = initialOrders(before.boards.length);
  before.boards.forEach((b, i) => {
    roots.boards.set(b.id, boardToYMap(b, orders[i], initialOrders(b.nodes.length), initialOrders((b.edges ?? []).length)));
  });
}

/**
 * 2 つのモデルを id 単位で比べ、違う項目だけを 1 つのトランザクションで Y.Doc に書く (設計書 4.2)。
 * before と after が同じ参照なら何もしない。origin は doc.transact の origin (自分の書き込みの判別に使う)。
 */
export function applyModelDiff(doc: Y.Doc, before: UntieModel, after: UntieModel, origin: unknown): void {
  if (before === after) return;
  const roots = getRoots(doc);
  doc.transact(() => {
    syncMeta(roots.meta, before.meta, after.meta);
    syncList(before.elements, after.elements, elementAdapter(roots.elements));
    syncList(before.relations, after.relations, recordAdapter<UntieModel["relations"][number], RelationRecord>(roots.relations, (r) => r.id, relationFields));
    removeHiddenDuplicates(roots, before, after);
    materializeFallbackBoards(roots, before);
    syncList(before.boards, after.boards, boardAdapter(roots.boards));
  }, origin);
}
