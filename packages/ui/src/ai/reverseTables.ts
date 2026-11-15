// 「ソースコードから作成」の依頼に入れる、データベースのテーブルと列。実物のスキーマは数百のテーブルになるので、依頼には、
// その画面・システムに関わるテーブルだけを列つきで入れ、残りは名前だけにする。列を知りたいテーブルは、道具 get_table で調べさせる。
// 設計モードの「AI で作る」(designScreen.ts の generateScreen) は、これを使わず、これまでどおり全部を入れる。
import { screenInformations } from "@untie/core/model/placement";
import { parsePrismaDslCached } from "@untie/core/model/prismaCache";
import type { PrismaModel, PrismaSchema } from "@untie/core/model/prisma";
import type { Database, UntieModel } from "@untie/core/model/types";
import { nameKey } from "./spec";
import type { ToolDef, ToolOutcome } from "./tools";

/** 依頼に列つきで入れるテーブルの数・文字数の上限 (データベースをまたいだ合計)。残りは名前だけ */
export const TABLE_REQUEST_LIMITS = { fullTables: 40, fullChars: 30_000, nameOnly: 300 } as const;

export interface TableView {
  table: string;
  informations: string[];
  columns: { name: string; type: string }[];
}

export interface DatabaseView {
  id: string;
  name: string;
  tables: TableView[];
  /** 列を入れなかったテーブルの名前 (列は get_table で調べる) */
  otherTables?: string[];
  note?: string;
}

const typeOf = (f: PrismaModel["fields"][number]): string => `${f.type}${f.isList ? "[]" : ""}${f.isOptional ? "?" : ""}`;

/** 列 (ほかのテーブルへの関連の欄は除く) */
function columnsOf(names: ReadonlySet<string>, m: PrismaModel): TableView["columns"] {
  return m.fields.filter((f) => !f.relation && !names.has(f.type)).map((f) => ({ name: f.name, type: typeOf(f) }));
}

/** 手がかりの文章に、名前が出るか (短すぎる名前は、偶然の一致が多いので数えない) */
function mentions(hintKey: string, name: string | undefined): boolean {
  if (!name) return false;
  const k = nameKey(name);
  return k.length >= (/[^\x00-\x7f]/.test(k) ? 2 : 3) && hintKey.includes(k);
}

/**
 * 依頼に入れるデータベースを作る。hint (画面の説明・調査結果・ソースのパス・情報の名前など) に、名前 (テーブル名・もとの名前・表す情報の名前) が出るテーブルと、
 * その関連先 (関連の欄で結ばれたテーブル) を先に、上限まで列つきで入れる。上限を超えた分は、名前だけの一覧 (otherTables) にする
 */
export function selectTablesForRequest(model: UntieModel, databaseIds: readonly string[], hint: string, limits: { fullTables: number; fullChars: number; nameOnly: number } = TABLE_REQUEST_LIMITS): DatabaseView[] {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const hintKey = nameKey(hint);
  type Row = { db: Database; schema: PrismaSchema; m: PrismaModel; rank: number; view: TableView };
  const rows: Row[] = [];
  for (const id of databaseIds) {
    const db = model.databases.find((d) => d.id === id);
    if (!db) continue;
    const schema = parsePrismaDslCached(db.dsl);
    const modelNames = new Set(schema.models.map((x) => x.name));
    const direct = new Set<string>();
    const infoNames = new Map<string, string[]>();
    for (const m of schema.models) {
      const infos = (db.tables.find((t) => t.table === m.name)?.informationIds ?? []).map((i) => byId.get(i)?.name ?? i);
      infoNames.set(m.name, infos);
      if ([m.name, m.mapName, ...infos].some((n) => mentions(hintKey, n))) direct.add(m.name);
    }
    const related = new Set<string>();
    for (const m of schema.models) {
      for (const f of m.fields) {
        if (!modelNames.has(f.type)) continue;
        if (direct.has(m.name)) related.add(f.type);
        if (direct.has(f.type)) related.add(m.name);
      }
    }
    for (const m of schema.models) {
      rows.push({ db, schema, m, rank: direct.has(m.name) ? 0 : related.has(m.name) ? 1 : 2, view: { table: m.name, informations: infoNames.get(m.name) ?? [], columns: columnsOf(modelNames, m) } });
    }
  }
  const order = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.rank - b.r.rank || a.i - b.i);
  const full = new Set<Row>();
  let chars = 0;
  for (const { r } of order) {
    if (full.size >= limits.fullTables) break;
    const size = JSON.stringify(r.view, null, 2).length + 40;
    if (chars + size > limits.fullChars && full.size > 0) break;
    full.add(r);
    chars += size;
  }
  return databaseIds.flatMap((id): DatabaseView[] => {
    const mine = rows.filter((r) => r.db.id === id);
    const db = model.databases.find((d) => d.id === id);
    if (!db) return [];
    const others = mine.filter((r) => !full.has(r)).map((r) => r.m.name);
    return [
      {
        id: db.id,
        name: db.name,
        tables: mine.filter((r) => full.has(r)).map((r) => r.view),
        ...(others.length > 0 ? { otherTables: others.slice(0, limits.nameOnly), ...(others.length > limits.nameOnly ? { note: `テーブルは全部で ${mine.length} 件。名前だけの一覧は先頭 ${limits.nameOnly} 件` } : {}) } : {}),
      },
    ];
  });
}

/** 文章のうち、name を含む行 (調査結果から、その画面・システムの行だけを取り出す)。maxChars までで打ち切る */
export function linesMentioning(text: string, name: string, maxChars = 4000): string {
  const key = nameKey(name);
  if (key === "") return "";
  const out: string[] = [];
  let used = 0;
  for (const line of text.split("\n")) {
    if (!nameKey(line).includes(key)) continue;
    if (used + line.length > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}

/** 画面 UI の依頼でテーブルを絞る手がかり: 画面の説明 (ソースのパスを含む)・調査結果のこの画面の行・使う操作と情報の名前 */
export function screenHint(model: UntieModel, analysisId: string, screenName: string, description: string, survey: string): string {
  const byId = new Map(model.elements.map((e) => [e.id, e.name]));
  const usecases = model.relations.filter((r) => r.kind === "usecaseScreen" && r.targetId === analysisId).map((r) => byId.get(r.sourceId) ?? "");
  const informations = (screenInformations(model).get(analysisId) ?? []).map((d) => byId.get(d.id) ?? "");
  return [screenName, description, linesMentioning(survey, screenName), ...usecases, ...informations].join("\n");
}

/** 画面 UI・テーブルの対応の依頼に入れる、使うデータベースの JSON 文字列 (すべて列つきではなく、絞ったもの) */
export function describeTablesForRequest(model: UntieModel, databaseIds: readonly string[], hint: string): { text: string; narrowed: boolean } {
  const views = selectTablesForRequest(model, databaseIds, hint);
  return { text: JSON.stringify(views, null, 2), narrowed: views.some((v) => (v.otherTables?.length ?? 0) > 0) };
}

/** 道具 get_table: 名前を渡すと、テーブルの列と型を返す (依頼で名前だけにしたテーブルを調べる) */
export const GET_TABLE_TOOL: ToolDef = {
  name: "get_table",
  description: "データベース (依頼の「使うデータベース」) のテーブルの列と型を返す。依頼に列が書かれていない (名前だけの) テーブルの列を知りたいときに使う。table はテーブル (model) の名前か、DB 上の名前。database は省略してよい (名前が重なるときだけ)。呼べる回数には上限がある。",
  parameters: {
    type: "object",
    properties: {
      table: { type: "string", description: "テーブルの名前" },
      database: { type: "string", description: "データベースの名前 (省略可)" },
    },
    required: ["table"],
    additionalProperties: false,
  },
};

const fail = (message: string): ToolOutcome => ({ ok: false, content: JSON.stringify({ error: message }), changed: false });

/** get_table の実行。databaseIds の範囲のデータベースだけから探す */
export function executeGetTable(model: UntieModel, databaseIds: readonly string[], rawInput: unknown): ToolOutcome {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as { table?: unknown; database?: unknown };
  if (typeof input.table !== "string" || input.table.trim() === "") return fail("table (テーブルの名前) が必要です");
  const key = nameKey(input.table);
  const wanted = typeof input.database === "string" && input.database.trim() !== "" ? nameKey(input.database) : null;
  const dbs = databaseIds.flatMap((id) => model.databases.filter((d) => d.id === id)).filter((d) => wanted === null || nameKey(d.name) === wanted);
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const found = dbs.flatMap((db) => {
    const schema = parsePrismaDslCached(db.dsl);
    const modelNames = new Set(schema.models.map((x) => x.name));
    return schema.models
      .filter((m) => nameKey(m.name) === key || (m.mapName !== undefined && nameKey(m.mapName) === key))
      .map((m) => ({
        database: db.name,
        table: m.name,
        ...(m.mapName ? { dbName: m.mapName } : {}),
        informations: (db.tables.find((t) => t.table === m.name)?.informationIds ?? []).map((i) => byId.get(i)?.name ?? i),
        columns: columnsOf(modelNames, m),
        relations: m.fields.filter((f) => modelNames.has(f.type)).map((f) => ({ field: f.name, table: f.type, list: f.isList })),
      }));
  });
  if (found.length === 0) return fail(`テーブル「${input.table}」は見つかりません`);
  return { ok: true, content: JSON.stringify(found.length === 1 ? found[0] : found, null, 2), changed: false };
}
