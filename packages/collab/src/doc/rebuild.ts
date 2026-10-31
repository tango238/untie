import * as Y from "yjs";
import { EDGE_SIDES, isValidElementShape, repairModel } from "@untie/core";
import type { Board, BoardEdge, BoardNode, Element, Meta, Relation, UntieModel } from "@untie/core";
import { cloneJson, deepEqual } from "./json";
import { compareByOrder } from "./order";
import { getRoots, ORDER_KEY } from "./roots";
import type { EdgeRecord, NodeRecord, RelationRecord } from "./roots";

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === "string";

type Ordered<T> = { order: string; id: string; value: T };

function sortedValues<T>(items: Ordered<T>[]): T[] {
  return items.sort(compareByOrder).map((x) => x.value);
}

function orderOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readMeta(meta: Y.Map<unknown>): Meta {
  const description = meta.get("description");
  return {
    name: typeof meta.get("name") === "string" ? (meta.get("name") as string) : "",
    ...(typeof description === "string" ? { description } : {}),
  };
}

function readElements(map: Y.Map<Y.Map<unknown>>): Element[] {
  const items: Ordered<Element>[] = [];
  map.forEach((ymap, id) => {
    if (!(ymap instanceof Y.Map)) return;
    const fields = ymap.toJSON() as Record<string, unknown>;
    const order = orderOf(fields[ORDER_KEY]);
    delete fields[ORDER_KEY];
    // 分析が空の Y.Map は分析なし (コマンドは空の分析を作らない)
    if (typeof fields.analysis === "object" && fields.analysis !== null && Object.keys(fields.analysis).length === 0) delete fields.analysis;
    const element = { id, ...cloneJson(fields) };
    // 種類が分からない要素や、形の壊れた要素 (項目が欠けた課題など。壊れた update) は組み立てない。1 つで全員が落ちるのを防ぐ
    if (!isValidElementShape(element)) return;
    items.push({ order, id, value: element });
  });
  return sortedValues(items);
}

function readRelations(map: Y.Map<RelationRecord>): Relation[] {
  const items: Ordered<Relation>[] = [];
  map.forEach((r, id) => {
    if (typeof r !== "object" || r === null || !isString(r.kind) || !isString(r.sourceId) || !isString(r.targetId)) return;
    items.push({ order: orderOf(r.order), id, value: { id, kind: r.kind, sourceId: r.sourceId, targetId: r.targetId } as Relation });
  });
  return sortedValues(items);
}

function readNodes(map: unknown): BoardNode[] {
  const items: Ordered<BoardNode>[] = [];
  if (map instanceof Y.Map) {
    (map as Y.Map<NodeRecord>).forEach((n, elementId) => {
      if (typeof n !== "object" || n === null || !isNumber(n.x) || !isNumber(n.y)) return;
      if ((n.width !== undefined && !isNumber(n.width)) || (n.height !== undefined && !isNumber(n.height))) return;
      items.push({
        order: orderOf(n.order),
        id: elementId,
        value: {
          elementId,
          x: n.x,
          y: n.y,
          ...(n.width !== undefined ? { width: n.width } : {}),
          ...(n.height !== undefined ? { height: n.height } : {}),
        },
      });
    });
  }
  return sortedValues(items);
}

function readEdges(map: unknown): BoardEdge[] {
  const items: Ordered<BoardEdge>[] = [];
  if (map instanceof Y.Map) {
    (map as Y.Map<EdgeRecord>).forEach((e, relationId) => {
      if (typeof e !== "object" || e === null) return;
      const sides = EDGE_SIDES as readonly unknown[];
      if ((e.sourceSide !== undefined && !sides.includes(e.sourceSide)) || (e.targetSide !== undefined && !sides.includes(e.targetSide))) return;
      items.push({
        order: orderOf(e.order),
        id: relationId,
        value: {
          relationId,
          ...(e.sourceSide !== undefined ? { sourceSide: e.sourceSide } : {}),
          ...(e.targetSide !== undefined ? { targetSide: e.targetSide } : {}),
        },
      });
    });
  }
  return sortedValues(items);
}

function readBoards(map: Y.Map<Y.Map<unknown>>): Board[] {
  const items: Ordered<Board>[] = [];
  map.forEach((ymap, id) => {
    if (!(ymap instanceof Y.Map)) return;
    const edges = readEdges(ymap.get("edges"));
    const name = ymap.get("name");
    items.push({
      order: orderOf(ymap.get(ORDER_KEY)),
      id,
      value: { id, name: typeof name === "string" ? name : "", nodes: readNodes(ymap.get("nodes")), ...(edges.length > 0 ? { edges } : {}) },
    });
  });
  return sortedValues(items);
}

/** next の各項目を、prev に同じ id で内容が同じ項目があればその参照にする。全部同じなら prev の配列自体 */
function shareList<T>(next: readonly T[], prev: readonly T[], idOf: (t: T) => string, share: (n: T, p: T) => T): T[] {
  const prevById = new Map(prev.map((t) => [idOf(t), t]));
  let same = next.length === prev.length;
  const out = next.map((n, i) => {
    const p = prevById.get(idOf(n));
    const r = p === undefined ? n : share(n, p);
    if (r !== prev[i]) same = false;
    return r;
  });
  return same ? (prev as T[]) : out;
}

function shareDeep<T>(n: T, p: T): T {
  return deepEqual(n, p) ? p : n;
}

function shareBoard(n: Board, p: Board): Board {
  const nodes = shareList(n.nodes, p.nodes, (x) => x.elementId, shareDeep);
  const edges = n.edges === undefined ? undefined : p.edges === undefined ? n.edges : shareList(n.edges, p.edges, (x) => x.relationId, shareDeep);
  if (n.name === p.name && nodes === p.nodes && edges === p.edges) return p;
  return { id: n.id, name: n.name, nodes, ...(edges !== undefined ? { edges } : {}) };
}

/** prev と内容が同じ部分は prev の参照を使い回す */
function shareModel(next: UntieModel, prev: UntieModel): UntieModel {
  const meta = shareDeep(next.meta, prev.meta);
  const elements = shareList(next.elements, prev.elements, (e) => e.id, shareDeep);
  const relations = shareList(next.relations, prev.relations, (r) => r.id, shareDeep);
  const boards = shareList(next.boards as Board[], prev.boards as Board[], (b) => b.id, shareBoard) as UntieModel["boards"];
  if (meta === prev.meta && elements === prev.elements && relations === prev.relations && boards === prev.boards) return prev;
  return { ...next, meta, elements, relations, boards };
}

/**
 * Y.Doc の中身をそのままモデルにする。order で並べ、order は出力に含めない。
 * 壊れた参照 (消えた要素を指す関係など) は外さない。サーバーが Y.Doc を直す差分 (repairDoc) の「直す前」に使う。
 * ただし形の壊れた要素・ノード・関係・線 (項目が欠けている、種類が不明など) は外す。1 つで組み立てが落ちるのを防ぐため。
 * ボードが 0 枚でも補わない。
 */
export function readModel(doc: Y.Doc): UntieModel {
  const roots = getRoots(doc);
  return {
    version: 1,
    meta: readMeta(roots.meta),
    elements: readElements(roots.elements),
    relations: readRelations(roots.relations),
    boards: readBoards(roots.boards) as UntieModel["boards"],
  };
}

/**
 * Y.Doc からモデルを組み立てる (表示用)。readModel の結果から壊れた参照を外す。
 *
 * - 壊れた参照 (合流で残った、消えた要素を指す関係など) は repairModel と同じ規則で出力から外す/直す。Y.Doc は変えない (設計書 6 章)。
 *   Y.Doc を直すのはサーバーだけ (repairDoc)。クライアントは直されるまでの間 UI が壊れないよう表示から外すだけ。
 * - ボードが 0 枚なら「ボード 1」(board_main) を 1 枚入れる (Y.Doc は変えない)。
 * - prev を渡すと、内容が deep-equal な要素・関係・ボード・ノード・線は prev の参照を使い回す
 *   (配列全体が同じなら配列自体も)。全部同じなら prev 自体を返す。
 */
export function rebuildModel(doc: Y.Doc, prev?: UntieModel): UntieModel {
  const model = repairModel(readModel(doc)).model;
  return prev ? shareModel(model, prev) : model;
}
