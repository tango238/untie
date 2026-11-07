import * as Y from "yjs";
import { EDGE_SIDES, isValidDesignShape, isValidElementShape, MODEL_VERSION, repairModel, truncateDatabase, truncateDesignScreen, truncateElementStrings, truncateLayoutBase, truncateModelStrings, truncateNavGroup, truncateTransition } from "@untie/core";
import type { Board, BoardEdge, BoardNode, Database, DesignScreen, Element, Layout, Meta, NavGroup, Relation, SystemDesign, Transition, UntieModel } from "@untie/core";
import { cloneJson, deepEqual } from "./json";
import { compareByOrder } from "./order";
import { databaseKey, designKey, getRoots, keyOwner, ORDER_KEY } from "./roots";
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
    // 形の検査は、長すぎる文字列を切り詰めた写しで行う。上限を超えただけの要素を外すと、その要素と関係が全員の画面から消える。
    // 値は切り詰めずに返す (readRawModel。サーバーの repairDoc が Y.Doc に切り詰めを書けるよう、「直す前」はそのまま)
    // 種類が分からない要素や、形の壊れた要素 (項目が欠けた課題など。壊れた update) は組み立てない。1 つで全員が落ちるのを防ぐ
    if (!isValidElementShape(truncateElementStrings(element).element)) return;
    items.push({ order, id, value: element as Element });
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

// ---------------------------------------------------------------- 設計 (0.4.0)
// 設計データは平らなキーに置いてある (roots.ts)。形の壊れた項目は、スキーマの検証関数で読む時点で読み飛ばす
// (isValidElementShape と同じ流儀。長すぎる文字列は切り詰めた写しで検査し、値は切り詰めずに返す)。
// 設計があるかは `${systemId}/meta` の有無で決め、systemId の設計が無い (消えた) 画面・遷移・ナビは読み飛ばす。
// 参照の整合 (消えた画面を指す遷移など) はここでは見ない (rebuildModel の repairModel が直す)。

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

/** 値から systemId と order を外し、id をキーに揃えた、スキーマの形の値にする */
function partOf(id: string, record: Record<string, unknown>): Record<string, unknown> {
  const { systemId: _systemId, order: _order, ...rest } = record;
  return cloneJson({ ...rest, id });
}

/** systemId ごとに、画面・遷移・ナビのグループを順序つきで集める */
function readParts<T>(map: Y.Map<unknown>, kind: "designScreen" | "transition" | "navGroup", truncate: (v: Record<string, unknown>) => Record<string, unknown>, systems: ReadonlySet<string>): Map<string, T[]> {
  const grouped = new Map<string, Ordered<T>[]>();
  map.forEach((record, id) => {
    if (!isRecord(record) || !isString(record.systemId) || !systems.has(record.systemId)) return;
    const part = partOf(id, record);
    if (!isValidDesignShape(kind, truncate(part))) return;
    const list = grouped.get(record.systemId) ?? [];
    list.push({ order: orderOf(record.order), id, value: part as T });
    grouped.set(record.systemId, list);
  });
  return new Map([...grouped].map(([systemId, list]) => [systemId, sortedValues(list)]));
}

function readDesigns(roots: ReturnType<typeof getRoots>): SystemDesign[] {
  const metas: Ordered<{ databaseIds: string[] }>[] = [];
  roots.designs.forEach((value, key) => {
    if (!key.endsWith("/meta") || !isRecord(value) || !isStringArray(value.databaseIds)) return;
    const systemId = keyOwner(key);
    metas.push({ order: orderOf(value.order), id: systemId, value: { databaseIds: cloneJson(value.databaseIds) } });
  });
  const systems = new Set(metas.map((m) => m.id));
  const screens = readParts<DesignScreen>(roots.designScreens as Y.Map<unknown>, "designScreen", (v) => truncateDesignScreen(v).value, systems);
  const transitions = readParts<Transition>(roots.designTransitions as Y.Map<unknown>, "transition", (v) => truncateTransition(v).value, systems);
  const groups = readParts<NavGroup>(roots.designNav as Y.Map<unknown>, "navGroup", (v) => truncateNavGroup(v).value, systems);
  return metas.sort(compareByOrder).map((m) => {
    // レイアウトが壊れている・無いときは既定値で補い、画面と遷移は残す
    const stored = roots.designs.get(designKey(m.id, "layout"));
    const base = isRecord(stored) && isValidDesignShape("layout", { ...truncateLayoutBase(cloneJson(stored)).value, navigation: [] }) ? (cloneJson(stored) as { shell: Layout["shell"]; header?: Layout["header"] }) : { shell: "shell" as const };
    return {
      systemId: m.id,
      databaseIds: m.value.databaseIds,
      screens: screens.get(m.id) ?? [],
      transitions: transitions.get(m.id) ?? [],
      layout: { shell: base.shell, ...(base.header !== undefined ? { header: base.header } : {}), navigation: groups.get(m.id) ?? [] },
    };
  });
}

function readDatabases(map: Y.Map<unknown>): Database[] {
  const items: Ordered<Database>[] = [];
  map.forEach((name, key) => {
    if (!key.endsWith("/name") || !isString(name)) return;
    const id = keyOwner(key);
    const db = { id, name, dsl: map.get(databaseKey(id, "dsl")), tables: cloneJson(map.get(databaseKey(id, "tables"))) };
    if (!isValidDesignShape("database", truncateDatabase(db).value)) return;
    items.push({ order: orderOf(map.get(databaseKey(id, "order"))), id, value: db as Database });
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

/** 設計 1 つ。画面・遷移・ナビのグループを id ごとに共有する (1 つの view を変えても、ほかの画面の参照は変わらない) */
function shareDesign(n: SystemDesign, p: SystemDesign): SystemDesign {
  const screens = shareList(n.screens, p.screens, (s) => s.id, shareDeep);
  const transitions = shareList(n.transitions, p.transitions, (x) => x.id, shareDeep);
  const navigation = shareList(n.layout.navigation, p.layout.navigation, (g) => g.id, shareDeep);
  const databaseIds = shareDeep(n.databaseIds, p.databaseIds);
  const header = shareDeep(n.layout.header, p.layout.header);
  if (screens === p.screens && transitions === p.transitions && navigation === p.layout.navigation && databaseIds === p.databaseIds && header === p.layout.header && n.layout.shell === p.layout.shell) return p;
  return { systemId: n.systemId, databaseIds, screens, transitions, layout: { shell: n.layout.shell, ...(header !== undefined ? { header } : {}), navigation } };
}

/** prev と内容が同じ部分は prev の参照を使い回す */
function shareModel(next: UntieModel, prev: UntieModel): UntieModel {
  const meta = shareDeep(next.meta, prev.meta);
  const elements = shareList(next.elements, prev.elements, (e) => e.id, shareDeep);
  const relations = shareList(next.relations, prev.relations, (r) => r.id, shareDeep);
  const boards = shareList(next.boards as Board[], prev.boards as Board[], (b) => b.id, shareBoard) as UntieModel["boards"];
  const designs = shareList(next.designs, prev.designs, (d) => d.systemId, shareDesign);
  const databases = shareList(next.databases, prev.databases, (d) => d.id, shareDeep);
  if (meta === prev.meta && elements === prev.elements && relations === prev.relations && boards === prev.boards && designs === prev.designs && databases === prev.databases) return prev;
  return { ...next, meta, elements, relations, boards, designs, databases };
}

/**
 * Y.Doc の中身を、長すぎる文字列も含めてそのままモデルにする。サーバーが Y.Doc を直す差分 (repairDoc) の「直す前」に使う
 * (切り詰めた結果との差分を Y.Doc に書くため、ここでは切り詰めない)。返すモデルはスキーマの文字数の上限を超えうる。
 * 壊れた参照 (消えた要素を指す関係など) は外さない。ただし形の壊れた要素・ノード・関係・線 (項目が欠けている、種類が不明など) は外す。
 * 1 つで組み立てが落ちるのを防ぐため。文字列が上限を超えているだけの要素は外さない (形の検査は切り詰めた写しで行う)。
 * ボードが 0 枚でも補わない。
 */
export function readRawModel(doc: Y.Doc): UntieModel {
  const roots = getRoots(doc);
  return {
    version: MODEL_VERSION,
    meta: readMeta(roots.meta),
    elements: readElements(roots.elements),
    relations: readRelations(roots.relations),
    boards: readBoards(roots.boards) as UntieModel["boards"],
    designs: readDesigns(roots),
    databases: readDatabases(roots.databases),
  };
}

/**
 * Y.Doc の中身をモデルにする。壊れた参照は外さず、ボードが 0 枚でも補わない。
 * ただし形の壊れた要素・ノード・関係・線は外し、長すぎる文字列は外さずに上限へ切り詰める
 * (外すと、上限を超えただけの要素が全員の画面から消え、関係もサーバーに消される)。
 */
export function readModel(doc: Y.Doc): UntieModel {
  return truncateModelStrings(readRawModel(doc)).model;
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
  const model = repairModel(readRawModel(doc)).model;
  return prev ? shareModel(model, prev) : model;
}
