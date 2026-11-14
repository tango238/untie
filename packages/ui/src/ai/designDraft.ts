// 設計データの下書き (名前で参照する形) と、それを既存のモデルに足す純粋な関数。AI の呼び出しや画面は持たない。
// 「ソースコードから作成」の、データ (DSL とテーブル → 情報)・サイトマップ (画面と遷移)・画面 UI (view と bindings) の段階が使う。
// AI には id を作らせず、名前で参照させる。足すのは既存のコマンドで行い、足せない部分はその部分だけ落として警告に残す (モデルは壊さない)。
import {
  addDatabase,
  addTransition,
  clearDesignScreenView,
  renameDatabase,
  setDatabaseDesign,
  setDesignDatabases,
  setTableInformation,
  setDesignScreenView,
  updateTransition,
  type CommandResult,
} from "@untie/core/model/commands";
import { DEFAULT_DATABASE_ID, DEFAULT_DATABASE_NAME, effectiveDatabaseIds } from "@untie/core/model/design";
import { unmappedInformationIds } from "@untie/core/model/designData";
import { viewShapeProblem } from "@untie/core/model/designView";
import { NAME_MAX_LENGTH, truncateText } from "@untie/core/model/limits";
import { parsePrismaDsl, type PrismaError } from "@untie/core/model/prisma";
import { parsePrismaDslCached } from "@untie/core/model/prismaCache";
import { addSitemapScreens, designScreenName, TRANSITION_VIAS } from "@untie/core/model/sitemap";
import type { Database, DesignScreen, Element, SystemDesign, Transition, UntieModel } from "@untie/core/model/types";
import { validateView } from "../components/design/viewValidate";
import { sanitizeBindings } from "./designScreen";
import type { ToolDef } from "./tools";

// ---------------------------------------------------------------- 共通

const nameOf = (text: string): string => truncateText(text.trim(), NAME_MAX_LENGTH);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * 下書きの一覧ごとの上限。AI の出力が巨大でも、足す処理 (1 件ごとにコマンドを通すので、件数に応じて重くなる) で画面が固まらないようにする。
 * 超えた分は先頭から使い、「先頭 N 件だけ使いました」と warnings に残す
 */
export const DESIGN_DRAFT_LIMITS = {
  /** データ: テーブルの対応の数と、1 つのテーブルが表す情報の数 */
  tables: 300,
  informationsPerTable: 50,
  /** サイトマップ: 遷移の数 */
  transitions: 500,
  /** 画面 UI: 項目と列の対応の数 */
  bindings: 500,
} as const;

/** 一覧の先頭 max 件だけを返し、超えたら警告に残す (配列でなければ空) */
function clipList<T>(list: readonly T[], max: number, what: string, warnings: string[]): T[] {
  if (!Array.isArray(list)) return [];
  if (list.length > max) warnings.push(`${what}は先頭 ${max} 件だけ使いました (${list.length} 件ありました)`);
  return list.slice(0, max);
}

/** 足した結果の共通部分 */
export interface DraftResult {
  /** 足したあとのモデル。何も足せなければ渡したモデルのまま */
  model: UntieModel;
  /** 落とした部分・気づいたこと */
  warnings: string[];
}

/** 名前で見つけた要素 (同じ名前が複数あれば最初のもの) */
function findNamed(model: UntieModel, kind: "system" | "information", name: string) {
  const n = nameOf(name);
  return model.elements.find((e) => e.kind === kind && e.name === n);
}

// ---------------------------------------------------------------- データ (DSL とテーブル → 情報)

export interface DatabaseDraft {
  /** 対象のシステムの名前 */
  system: string;
  /** データベースの名前 (省略はシステム名から) */
  database_name?: string;
  /** すでにあるデータベースとテーブルが重なるのに、別のデータベースとして出す理由 (任意。ソースコードから作成の、ほかのシステムと共有するデータベースの確認に使う) */
  separate_reason?: string;
  /** Prisma のスキーマ (model / enum だけ) */
  dsl: string;
  /** テーブル (model の名前) と、それが表す情報の名前 */
  tables: { table: string; informations: string[] }[];
}

export interface DatabaseDraftOptions {
  /**
   * DSL に解析エラーがあっても受け付けるか。false (既定) ならモデルを変えず、dslErrors を返す (呼ぶ側が AI に出し直させる)。
   * true なら DSL をそのまま置き、エラーを警告に残す
   */
  acceptDslErrors?: boolean;
  /**
   * 同じ名前なら置き換えてよいデータベースの id。省略すると、設計がすでに使っているデータベースのうち同じ名前のもの。
   * ここに無い、すでにあるデータベースと同じ名前の提出は置き換えず、何も足さずに nameTaken を返す (データベースの名前は 1 つのモデルで 1 つだけ。
   * ほかのシステムが写した・使うデータベースを、別のスキーマで上書きしないため)
   */
  replaceableIds?: readonly string[];
}

export interface DatabaseDraftResult extends DraftResult {
  /** 足したか (false ならモデルは変わっていない) */
  applied: boolean;
  /** DSL の解析エラー (acceptDslErrors でないときは、これがあると足さない) */
  dslErrors: PrismaError[];
  /** 見つからないシステムなど、足せなかった理由 (dslErrors とは別。出し直しても直らない) */
  failure?: string;
  /** 置き換えてよくない、すでにあるデータベースと同じ名前だったので足さなかった (failure も返る) */
  nameTaken?: boolean;
  databaseId?: string;
  added: { tables: number; informations: number };
}

const DATABASE_TOOL_BODY = {
  dsl: { type: "string", description: "Prisma のスキーマ (model / enum だけ。datasource や generator は書かない)" },
  tables: {
    type: "array",
    description: "model の名前と、それが表す情報の名前 (モデルにある情報)。1 つの情報を複数のテーブルが表してもよい",
    items: {
      type: "object",
      properties: {
        table: { type: "string", description: "DSL の model の名前 (enum の名前ではない)。DSL に無いテーブルの対応は捨てられる" },
        informations: { type: "array", items: { type: "string" }, description: "このテーブルが表す情報の名前 (モデルにある情報)。モデルに無い名前は捨てられる" },
      },
      required: ["table", "informations"],
      additionalProperties: false,
    },
  },
};

/** データベースの名前。書かれていなければ、システムの名前から付ける */
export function resolveDatabaseName(systemName: string, databaseName?: string): string {
  return nameOf(databaseName ?? "") || nameOf(`${systemName}のデータベース`);
}

export interface SubmitDatabaseToolOptions {
  /** ほかのシステムも同じデータベースを使うことがあるか (システムが複数あるとき)。真のときだけ、データの中身で名前を付ける説明を出す */
  shareable?: boolean;
  /** すでにあるデータベースがあるか。真のときだけ、別のデータベースである理由 (separate_reason) の項目を足す */
  existing?: boolean;
}

/** submit_database の道具。システムが 1 つだけの会話 (オプションなし) では、共有の説明も理由の項目も出さない */
export function submitDatabaseTool(options: SubmitDatabaseToolOptions = {}): ToolDef {
  const name = options.shareable
    ? "データベースの名前。データの中身で付ける (例: 注文DB。システムの名前にしない。ほかのシステムも同じデータベースを使うため)。省略するとシステム名から付ける。すでにあるデータベースと同じ名前は使えない"
    : "データベースの名前。データの中身で付ける (例: 注文DB)。省略するとシステム名から付ける";
  return {
    name: "submit_database",
    description: "システムのデータベースの DSL (Prisma のスキーマの一部) と、テーブル → 情報の対応を提出する。情報は名前で書く (id は作らない)。DSL に解析エラーがあると理由が返るので直して出し直す。",
    parameters: {
      type: "object",
      properties: {
        system: { type: "string", description: "対象のシステムの名前 (モデルにあるもの)" },
        database_name: { type: "string", description: name },
        ...(options.existing
          ? {
              separate_reason: {
                type: "string",
                description: "すでにあるデータベースとテーブルが重なると断られたとき、本当に別のデータベースだと出し直すときに添える理由 (例: このシステム専用の別のデータベースで、テーブルの名前だけが重なる)。同じデータベースなら use_database を使い、これは書かない",
              },
            }
          : {}),
        ...DATABASE_TOOL_BODY,
      },
      required: ["system", "dsl", "tables"],
      additionalProperties: false,
    },
  };
}

/** システムが 1 つだけの会話の submit_database (共有の説明も理由の項目も無い) */
export const SUBMIT_DATABASE_DRAFT_TOOL: ToolDef = submitDatabaseTool();

/** 提出された内容を取り出す。形が違えば null */
export function readDatabaseDraft(raw: unknown): DatabaseDraft | null {
  if (!isObject(raw) || typeof raw.system !== "string" || typeof raw.dsl !== "string" || !Array.isArray(raw.tables)) return null;
  const tables = raw.tables.flatMap((t) => {
    if (!isObject(t) || typeof t.table !== "string" || t.table === "") return [];
    return [{ table: t.table, informations: strings(t.informations) }];
  });
  return {
    system: raw.system,
    ...(typeof raw.database_name === "string" ? { database_name: raw.database_name } : {}),
    ...(typeof raw.separate_reason === "string" && raw.separate_reason.trim() !== "" ? { separate_reason: raw.separate_reason.trim() } : {}),
    dsl: raw.dsl,
    tables,
  };
}

/**
 * データベースの下書きを、システムの設計に足す。データベースを 1 つ作り (置き換えてよいデータベース (options.replaceableIds。省略は設計が使っているもの) に同じ名前があればそれを置き換え。
 * それ以外のすでにあるデータベースと同じ名前なら、足さずに nameTaken を返す)、
 * DSL とテーブル → 情報の対応を置いて、設計が使うデータベースにする。
 * 落とす: DSL に無いテーブルの対応、見つからない情報の名前。システムが見つからない・DSL が置けないときは何も足さず failure を返す。
 * DSL の解析エラーは acceptDslErrors でないとき足さずに dslErrors を返す
 */
export function applyDatabaseDraft(model: UntieModel, draft: DatabaseDraft, options: DatabaseDraftOptions = {}): DatabaseDraftResult {
  const none = (failure: string, dslErrors: PrismaError[] = []): DatabaseDraftResult => ({
    model,
    warnings: [failure],
    applied: false,
    dslErrors,
    failure,
    added: { tables: 0, informations: 0 },
  });
  const system = findNamed(model, "system", draft.system);
  if (!system) return none(`データ: システム「${draft.system}」が見つからないので、データベースを足せません`);
  const schema = parsePrismaDsl(draft.dsl);
  if (schema.errors.length > 0 && !options.acceptDslErrors) {
    return { model, warnings: [`データ: DSL に解析エラーが ${schema.errors.length} 件あるので、データベースを足しませんでした`], applied: false, dslErrors: schema.errors, added: { tables: 0, informations: 0 } };
  }
  const warnings: string[] = [];
  if (schema.errors.length > 0) {
    const first = schema.errors[0]!;
    warnings.push(`データ: DSL に解析エラーが ${schema.errors.length} 件残っています (${first.line} 行 ${first.column} 列: ${first.message})`);
  }
  // テーブル → 情報。DSL に無いテーブルと、見つからない情報は落とす
  const modelNames = new Set(schema.models.map((m) => m.name));
  const enumNames = new Set(schema.enums.map((e) => e.name));
  const informationByName = new Map<string, Element>();
  for (const e of model.elements) if (e.kind === "information" && !informationByName.has(e.name)) informationByName.set(e.name, e);
  const tables: { table: string; informationIds: string[] }[] = [];
  for (const t of clipList(draft.tables, DESIGN_DRAFT_LIMITS.tables, "データ: テーブルの対応", warnings)) {
    if (!modelNames.has(t.table)) {
      warnings.push(
        enumNames.has(t.table)
          ? `データ: ${t.table} は model ではなく enum なので、情報との対応を外しました (情報に対応させるのは model だけです)`
          : `データ: テーブル ${t.table} が DSL に無いので、情報との対応を外しました`,
      );
      continue;
    }
    const ids: string[] = [];
    for (const n of clipList(t.informations, DESIGN_DRAFT_LIMITS.informationsPerTable, `データ: テーブル ${t.table} が表す情報`, warnings)) {
      const info = informationByName.get(nameOf(n));
      if (!info) warnings.push(`データ: テーブル ${t.table} が表す情報「${n}」が見つかりません`);
      else if (!ids.includes(info.id)) ids.push(info.id);
    }
    if (ids.length > 0) tables.push({ table: t.table, informationIds: ids });
  }

  // 設計に同じ名前のデータベースがあれば置き換える。無ければ新しく足す。
  // 既定のデータベース (db_default) は、databaseIds が空のほかのシステムの設計が使うので、名前を替えて流用しない
  // (システムが 1 つだけで、空の既定のデータベースしか無いときは、それを使う。ほかに影響する設計が無い)
  const dbName = resolveDatabaseName(system.name, draft.database_name);
  const design = model.designs.find((d) => d.systemId === system.id);
  const systemCount = model.elements.filter((e) => e.kind === "system").length;
  let next = model;
  const step = <T>(r: CommandResult<T>, what: string): (T & { model: UntieModel }) | null => {
    if (!r.ok) {
      warnings.push(`データ: ${what}: ${r.reason}`);
      return null;
    }
    next = r.model;
    return r as T & { model: UntieModel };
  };
  const owned = (options.replaceableIds ?? design?.databaseIds ?? []).map((id) => next.databases.find((d) => d.id === id)).find((d) => d?.name === dbName);
  const emptyDefault =
    systemCount === 1 && next.databases.length === 1 && next.databases[0]!.id === DEFAULT_DATABASE_ID && next.databases[0]!.dsl === "" && next.databases[0]!.tables.length === 0;
  // 置き換えてよくないデータベースと同じ名前は、置き換えず、足さない (名前は一意。画面の対応の database と use_database が名前で引くため)
  if (!owned && !emptyDefault && next.databases.some((d) => d.name === dbName)) {
    const failure = `データ: データベース「${dbName}」はすでにあるので、同じ名前では足せません`;
    return { model, warnings: [failure], applied: false, dslErrors: [], failure, nameTaken: true, added: { tables: 0, informations: 0 } };
  }
  let databaseId: string;
  if (owned) databaseId = owned.id;
  else if (emptyDefault) {
    databaseId = DEFAULT_DATABASE_ID;
    if (!step(renameDatabase(next, { id: databaseId, name: dbName }), "データベースの名前を付けられません")) return none(warnings.join(" / "));
  } else {
    // データベースがまだ無く、ほかにもシステムがあるときは、先に空の既定のデータベースを足す。databaseIds が空のほかの設計は、
    // 先頭のデータベースを使う規則なので、足さないとこのシステムのデータベースを使ってしまう
    if (next.databases.length === 0 && systemCount > 1) {
      if (!step(addDatabase(next, { id: DEFAULT_DATABASE_ID, name: DEFAULT_DATABASE_NAME }), "既定のデータベースを足せません")) return none(warnings.join(" / "));
    }
    const added = step(addDatabase(next, { name: dbName }), "データベースを足せません");
    if (!added) return none(warnings.join(" / "));
    databaseId = added.id;
  }
  if (!step(setDatabaseDesign(next, { id: databaseId, dsl: draft.dsl, tables }), "DSL を置けません")) return none(warnings.join(" / "));
  const explicit = next.designs.find((d) => d.systemId === system.id)?.databaseIds ?? design?.databaseIds ?? [];
  if (!step(setDesignDatabases(next, { systemId: system.id, databaseIds: [...new Set([...explicit, databaseId])] }), "設計が使うデータベースにできません")) {
    return none(warnings.join(" / "));
  }
  // 置き直した DSL に、列やテーブルが無くなった画面の対応は外す (残すと検証が bindingInvalid を出す)
  next = dropInvalidBindings(next, databaseId, warnings);
  // このシステムが使う情報のうち、どのテーブルにも対応していないもの (空の DSL や、名前の誤りの手がかり。AI の出し直しの材料になる)
  warnings.push(...unmappedWarnings(next, system.id));
  const mapped = new Set(tables.flatMap((t) => t.informationIds));
  return { model: next, warnings, applied: true, dslErrors: schema.errors, databaseId, added: { tables: tables.length, informations: mapped.size } };
}

/** 対応していない情報を 1 件ずつ警告にする数 (これを超えたら、残りは 1 行にまとめる) */
const UNMAPPED_WARNING_MAX = 20;

/** システムが使う情報のうち、どのテーブルにも対応していないものの警告 (1 件ずつ。多いときは残りを 1 行にまとめる) */
function unmappedWarnings(model: UntieModel, systemId: string): string[] {
  const unmapped = unmappedInformationIds(model, systemId);
  const nameById = new Map(model.elements.map((e) => [e.id, e.name]));
  const out = unmapped.slice(0, UNMAPPED_WARNING_MAX).map((id) => `データ: 情報「${nameById.get(id) ?? id}」がどのテーブルにも対応していません`);
  if (unmapped.length > UNMAPPED_WARNING_MAX) out.push(`データ: ほか ${unmapped.length - UNMAPPED_WARNING_MAX} 件の情報もどのテーブルにも対応していません`);
  return out;
}

/** データベースの DSL にある model (テーブル) のうち、どの情報にも結ばれていないものの名前 (AI へ「対応を足せるテーブル」として示す) */
export function unmappedTableNames(db: Pick<Database, "dsl" | "tables">): string[] {
  const mapped = new Set(db.tables.filter((t) => t.informationIds.length > 0).map((t) => t.table));
  return parsePrismaDslCached(db.dsl).models.map((m) => m.name).filter((n) => !mapped.has(n));
}

/** データベースの DSL にある model (テーブル) の名前 */
export function tableNamesOf(db: Pick<Database, "dsl">): string[] {
  return parsePrismaDslCached(db.dsl).models.map((m) => m.name);
}
/**
 * 出したテーブルの名前と、すでにあるデータベースのテーブルの名前の重なり (大文字小文字を無視)。
 * 同じかもしれないのは、出したテーブルの過半が既存にある、または既存のテーブルの過半を含むとき (どちらの向きも見る)。どちらかが空なら重なりなし
 */
export function tableOverlap(submitted: readonly string[], existing: readonly string[]): { common: string[]; similar: boolean } {
  const a = new Set(submitted.map((n) => n.toLowerCase()));
  const b = new Set(existing.map((n) => n.toLowerCase()));
  if (a.size === 0 || b.size === 0) return { common: [], similar: false };
  const common = [...a].filter((n) => b.has(n));
  const original = new Map(submitted.map((n) => [n.toLowerCase(), n]));
  return { common: common.map((n) => original.get(n) ?? n), similar: common.length * 2 > a.size || common.length * 2 > b.size };
}

/** 警告に、どの項目がなぜ落ちたかを並べる数 */
const DETAIL_MAX = 3;

/**
 * データベースの DSL を置き直したあと、そのデータベースを指す画面の対応 (bindings) のうち、テーブルや列が無くなったものを外す。
 * 外した画面ごとに、何を外したかを warnings に残す
 */
function dropInvalidBindings(model: UntieModel, databaseId: string, warnings: string[]): UntieModel {
  const db = model.databases.find((d) => d.id === databaseId);
  if (!db) return model;
  const schema = parsePrismaDslCached(db.dsl);
  let next = model;
  for (const design of model.designs) {
    for (const screen of design.screens) {
      const bindings = screen.bindings;
      if (!bindings?.some((b) => b.databaseId === databaseId)) continue;
      const kept: typeof bindings = [];
      const lost: typeof bindings = [];
      for (const b of bindings) {
        const table = b.databaseId === databaseId ? schema.models.find((m) => m.name === b.table) : undefined;
        if (b.databaseId !== databaseId || (table && table.fields.some((f) => f.name === b.column))) kept.push(b);
        else lost.push(b);
      }
      if (lost.length === 0) continue;
      const r = screen.view !== undefined ? setDesignScreenView(next, { systemId: design.systemId, id: screen.id, view: screen.view, bindings: kept }) : clearDesignScreenView(next, { systemId: design.systemId, id: screen.id });
      if (!r.ok) {
        warnings.push(`データ: 画面「${designScreenName(next, screen)}」の対応を外せません: ${r.reason}`);
        continue;
      }
      next = r.model;
      const detail = lost.slice(0, DETAIL_MAX).map((b) => `${b.item} → ${b.table}.${b.column}`).join("、");
      warnings.push(
        `データ: 「${db.name}」を置き直したので、画面「${designScreenName(next, screen)}」の項目と列の対応のうち ${lost.length} 件を、テーブル・列が無くなったため外しました (${detail}${lost.length > DETAIL_MAX ? " ほか" : ""})`,
      );
    }
  }
  return next;
}

// ---------------------------------------------------------------- すでにあるデータベースを使う

export interface DatabaseUseDraft {
  /** 対象のシステムの名前 */
  system: string;
  /** 使うデータベースの名前 (すでにあるもの) */
  database: string;
  /** そのデータベースのテーブルと、このシステムの情報の対応 (足すだけ。すでにある対応は消えない) */
  tables: { table: string; informations: string[] }[];
}

export interface DatabaseUseResult extends DraftResult {
  /** 使うデータベースにできたか (false ならモデルは変わっていない) */
  applied: boolean;
  /** 足せなかった理由 (システム・データベースが見つからないなど) */
  failure?: string;
  databaseId?: string;
  /** 足した対応 (新しく結んだ情報の数) */
  added: { tables: number; informations: number };
}

export const USE_DATABASE_TOOL: ToolDef = {
  name: "use_database",
  description:
    "すでにあるデータベース (ほかのシステムが写したもの。依頼に一覧がある) を、このシステムが使うと答える。同じスキーマを submit_database で出し直さない。tables には、そのデータベースのテーブルと、このシステムの情報 (まだ対応が無いもの) の対応を書く。すでにある対応は消えず、足されるだけ。",
  parameters: {
    type: "object",
    properties: {
      system: { type: "string", description: "対象のシステムの名前 (モデルにあるもの)" },
      database: { type: "string", description: "使うデータベースの名前 (依頼の「すでにあるデータベース」にあるもの)" },
      tables: {
        type: "array",
        description: "足すテーブルと情報の対応。すでにある対応を変えない。空でもよい (対応を足さないとき)",
        items: {
          type: "object",
          properties: {
            table: { type: "string", description: "そのデータベースの DSL の model の名前" },
            informations: { type: "array", items: { type: "string" }, description: "このテーブルが表す情報の名前 (モデルにある情報)" },
          },
          required: ["table", "informations"],
          additionalProperties: false,
        },
      },
    },
    required: ["system", "database", "tables"],
    additionalProperties: false,
  },
};

/** 提出された内容を取り出す。形が違えば null */
export function readDatabaseUse(raw: unknown): DatabaseUseDraft | null {
  if (!isObject(raw) || typeof raw.system !== "string" || typeof raw.database !== "string") return null;
  const tables = (Array.isArray(raw.tables) ? raw.tables : []).flatMap((t) => {
    if (!isObject(t) || typeof t.table !== "string" || t.table === "") return [];
    return [{ table: t.table, informations: strings(t.informations) }];
  });
  return { system: raw.system, database: raw.database, tables };
}

/**
 * すでにあるデータベースを、システムの設計が使うデータベースに足し (すでに使っているものは残す)、テーブルと情報の対応を足す。
 * 足すだけで、すでにある対応は消さない。落とす: DSL に無いテーブル・見つからない情報の名前。
 * システム・データベースが見つからないときは何も足さず failure を返す。database は名前か id
 */
export function applyDatabaseUse(model: UntieModel, draft: DatabaseUseDraft): DatabaseUseResult {
  const none = (failure: string): DatabaseUseResult => ({ model, warnings: [failure], applied: false, failure, added: { tables: 0, informations: 0 } });
  const system = findNamed(model, "system", draft.system);
  if (!system) return none(`データ: システム「${draft.system}」が見つからないので、データベースを使えません`);
  const wanted = draft.database.trim();
  const candidates = model.databases.filter((d) => d.id === wanted || d.name === nameOf(wanted));
  if (candidates.length === 0) return none(`データ: データベース「${draft.database}」が見つかりません`);
  const design0 = model.designs.find((d) => d.systemId === system.id);
  const db = candidates.find((d) => design0?.databaseIds.includes(d.id)) ?? candidates[0]!;
  const warnings: string[] = [];
  const modelNames = new Set(tableNamesOf(db));
  const informationByName = new Map<string, Element>();
  for (const e of model.elements) if (e.kind === "information" && !informationByName.has(e.name)) informationByName.set(e.name, e);
  let next = model;
  const addedInfos = new Set<string>();
  let addedTables = 0;
  for (const t of clipList(draft.tables, DESIGN_DRAFT_LIMITS.tables, "データ: テーブルの対応", warnings)) {
    if (!modelNames.has(t.table)) {
      warnings.push(`データ: テーブル ${t.table} がデータベース「${db.name}」の DSL に無いので、情報との対応を外しました`);
      continue;
    }
    const ids: string[] = [];
    for (const n of clipList(t.informations, DESIGN_DRAFT_LIMITS.informationsPerTable, `データ: テーブル ${t.table} が表す情報`, warnings)) {
      const info = informationByName.get(nameOf(n));
      if (!info) warnings.push(`データ: テーブル ${t.table} が表す情報「${n}」が見つかりません`);
      else if (!ids.includes(info.id)) ids.push(info.id);
    }
    const current = next.databases.find((d) => d.id === db.id)?.tables.find((x) => x.table === t.table)?.informationIds ?? [];
    const fresh = ids.filter((id) => !current.includes(id));
    if (fresh.length === 0) continue;
    const r = setTableInformation(next, { id: db.id, table: t.table, informationIds: [...current, ...fresh] });
    if (!r.ok) {
      warnings.push(`データ: テーブル ${t.table} の対応を足せません: ${r.reason}`);
      continue;
    }
    next = r.model;
    addedTables++;
    for (const id of fresh) addedInfos.add(id);
  }
  const explicit = next.designs.find((d) => d.systemId === system.id)?.databaseIds ?? [];
  const used = setDesignDatabases(next, { systemId: system.id, databaseIds: [...new Set([...explicit, db.id])] });
  if (!used.ok) return none(`データ: 設計が使うデータベースにできません: ${used.reason}`);
  next = used.model;
  warnings.push(...unmappedWarnings(next, system.id));
  return { model: next, warnings, applied: true, databaseId: db.id, added: { tables: addedTables, informations: addedInfos.size } };
}

// ---------------------------------------------------------------- サイトマップ (画面と遷移)

export interface SitemapDraft {
  /** 対象のシステムの名前 */
  system: string;
  /** ソースから読み取れた遷移。画面は分析の画面の名前 */
  transitions: { from: string; to: string; via?: string; label?: string }[];
}

export interface SitemapDraftResult extends DraftResult {
  added: {
    /** サイトマップに足した画面 (分析の画面) の数 */
    screens: number;
    /** 作業のつながりなどから導いて足した遷移の数 */
    derivedTransitions: number;
    /** 下書きから足した遷移の数 */
    transitions: number;
    /** 導出済みなどで、すでにあるため足さなかった遷移の数 */
    skipped: number;
  };
}

export const SUBMIT_SITEMAP_TOOL: ToolDef = {
  name: "submit_sitemap",
  description: "システムの画面遷移 (ソースコードから読み取れたもの) を提出する。画面は分析の画面の名前で書く (id は作らない)。作業のつながりから導ける遷移は足さなくてよい。",
  parameters: {
    type: "object",
    properties: {
      system: { type: "string", description: "対象のシステムの名前" },
      transitions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string", description: "遷移元の画面の名前" },
            to: { type: "string", description: "遷移先の画面の名前" },
            via: { type: "string", enum: [...TRANSITION_VIAS], description: "きっかけ: button ボタン / row 一覧の行 / nav メニュー / afterSubmit 送信のあと" },
            label: { type: "string", description: "ボタンの文言など" },
          },
          required: ["from", "to"],
          additionalProperties: false,
        },
      },
    },
    required: ["system", "transitions"],
    additionalProperties: false,
  },
};

export function readSitemapDraft(raw: unknown): SitemapDraft | null {
  if (!isObject(raw) || typeof raw.system !== "string") return null;
  const transitions = (Array.isArray(raw.transitions) ? raw.transitions : []).flatMap((t) => {
    if (!isObject(t) || typeof t.from !== "string" || typeof t.to !== "string") return [];
    return [{ from: t.from, to: t.to, ...(typeof t.via === "string" ? { via: t.via } : {}), ...(typeof t.label === "string" ? { label: t.label } : {}) }];
  });
  return { system: raw.system, transitions };
}

/**
 * システムの分析の画面を設計の画面にし (addSitemapScreens。導出する遷移も足る)、ソースから読み取れた遷移を足す。
 * 落とす: 見つからない画面の名前を持つ遷移、自分自身への遷移。すでにある遷移 (導出済みを含む) は足さず skipped に数える。
 * 使えない via はきっかけだけ外して遷移は足す
 */
export function applySitemapDraft(model: UntieModel, draft: SitemapDraft): SitemapDraftResult {
  const empty = { screens: 0, derivedTransitions: 0, transitions: 0, skipped: 0 };
  const system = findNamed(model, "system", draft.system);
  if (!system) return { model, warnings: [`サイトマップ: システム「${draft.system}」が見つからないので、足せません`], added: empty };
  const warnings: string[] = [];
  const before = model.designs.find((d) => d.systemId === system.id);
  const sources = model.elements
    .filter((e) => e.kind === "screen" && e.systemId === system.id)
    .map((e) => ({ kind: "screen", screenId: e.id }) as const);
  let next = model;
  const added = addSitemapScreens(next, system.id, sources);
  if (!added.ok) return { model, warnings: [`サイトマップ: 画面を足せません: ${added.reason}`], added: empty };
  next = added.model;
  const design = (m: UntieModel): SystemDesign | undefined => m.designs.find((d) => d.systemId === system.id);
  const afterScreens = design(next);
  const result = { ...empty, screens: (afterScreens?.screens.length ?? 0) - (before?.screens.length ?? 0), derivedTransitions: (afterScreens?.transitions.length ?? 0) - (before?.transitions.length ?? 0) };

  // 画面の名前 → 設計の画面の id (同じ名前が複数あれば最初のもの)
  const byName = new Map<string, DesignScreen>();
  for (const s of afterScreens?.screens ?? []) {
    const n = designScreenName(next, s);
    if (!byName.has(n)) byName.set(n, s);
  }
  const existing = new Set((afterScreens?.transitions ?? []).map((x) => `${x.from}\n${x.to}`));
  for (const t of clipList(draft.transitions, DESIGN_DRAFT_LIMITS.transitions, "サイトマップ: 遷移", warnings)) {
    const from = byName.get(nameOf(t.from));
    const to = byName.get(nameOf(t.to));
    if (!from || !to) {
      warnings.push(`サイトマップ: 遷移「${t.from}」→「${t.to}」の画面が見つからないので、落としました${!from && !to ? " (両方)" : !from ? ` (「${t.from}」)` : ` (「${t.to}」)`}`);
      continue;
    }
    if (from.id === to.id) {
      warnings.push(`サイトマップ: 遷移「${t.from}」→「${t.to}」は同じ画面への遷移なので、落としました`);
      continue;
    }
    let via: Transition["via"];
    if (t.via !== undefined && t.via !== "") {
      if ((TRANSITION_VIAS as readonly string[]).includes(t.via)) via = t.via as Transition["via"];
      else warnings.push(`サイトマップ: 遷移「${t.from}」→「${t.to}」のきっかけ「${t.via}」は使えないので、${existing.has(`${from.id}\n${to.id}`) ? "きっかけは付けませんでした" : "きっかけなしで足しました"}`);
    }
    const label = t.label ? truncateText(t.label.trim(), NAME_MAX_LENGTH) : undefined;
    if (existing.has(`${from.id}\n${to.id}`)) {
      // 作業のつながりから導いた遷移と同じ両端: きっかけ・文言が未定なら AI の値で埋める (決まっているものは変えない)
      const found = design(next)?.transitions.find((x) => x.from === from.id && x.to === to.id);
      const patch: { via?: Transition["via"]; label?: string } = {
        ...(found && found.via === undefined && via ? { via } : {}),
        ...(found && !found.label && label ? { label } : {}),
      };
      if (found && Object.keys(patch).length > 0) {
        const u = updateTransition(next, { systemId: system.id, id: found.id, patch });
        if (u.ok) next = u.model;
        else warnings.push(`サイトマップ: 遷移「${t.from}」→「${t.to}」のきっかけを付けられません: ${u.reason}`);
      }
      result.skipped++;
      continue;
    }
    const r = addTransition(next, { systemId: system.id, from: from.id, to: to.id, ...(via ? { via } : {}), ...(label ? { label } : {}) });
    if (!r.ok) {
      warnings.push(`サイトマップ: 遷移「${t.from}」→「${t.to}」を足せません: ${r.reason}`);
      continue;
    }
    next = r.model;
    existing.add(`${from.id}\n${to.id}`);
    result.transitions++;
  }
  return { model: next, warnings, added: result };
}

// ---------------------------------------------------------------- 画面 UI (view と bindings)

export interface ScreenDraft {
  /** 分析の画面の名前 (設計の画面の名前) */
  screen: string;
  /** 画面が複数のシステムにあるときの絞り込み */
  system?: string;
  /** mokkun v2 の view。遷移 (to) は画面の名前でも設計の画面の id でもよい */
  view: Record<string, unknown>;
  /** 項目 (fields[].item、一覧の列は `<セクションの id>.<列の id>`) → テーブルの列。databaseId は省くと設計が使うデータベース */
  bindings: { item: string; table: string; column: string; database?: string }[];
}

export interface ScreenDraftResult extends DraftResult {
  /** view を置いたか (false ならモデルは変わっていない) */
  applied: boolean;
  /** view が mokkun の検証に通らなかった理由 (AI に出し直させる材料。通らなければ view は置かない) */
  viewError?: string;
  /** 足せなかった理由 (画面が見つからないなど。viewError とは別) */
  failure?: string;
  added: { bindings: number; droppedBindings: number };
}

export const SUBMIT_SCREEN_DRAFT_TOOL: ToolDef = {
  name: "submit_screen",
  description: "画面 UI (mokkun v2 の view) と、項目と列の対応を提出する。画面は分析の画面の名前で書く。view が mokkun の検証に通らないと理由が返るので直して出し直す。",
  parameters: {
    type: "object",
    properties: {
      screen: { type: "string", description: "画面の名前" },
      system: { type: "string", description: "同じ名前の画面が複数のシステムにあるときのシステムの名前" },
      view: { type: "object", description: "mokkun v2 の view。遷移は action の navigate / submit の to、一覧の列の to に、遷移先の画面の名前を書く", additionalProperties: true },
      bindings: {
        type: "array",
        description: "項目と列の対応。item は fields[].item、一覧の列は `<セクションの id>.<列の id>`",
        items: {
          type: "object",
          properties: {
            item: { type: "string" },
            table: { type: "string" },
            column: { type: "string" },
            database: { type: "string", description: "データベースの名前 (任意)。使うデータベースが複数あるときは必須。1 つだけなら省いてよい" },
          },
          required: ["item", "table", "column"],
          additionalProperties: false,
        },
      },
    },
    required: ["screen", "view", "bindings"],
    additionalProperties: false,
  },
};

export function readScreenDraft(raw: unknown): ScreenDraft | null {
  if (!isObject(raw) || typeof raw.screen !== "string" || !isObject(raw.view)) return null;
  const bindings = (Array.isArray(raw.bindings) ? raw.bindings : []).flatMap((b) => {
    if (!isObject(b) || typeof b.item !== "string" || typeof b.table !== "string" || typeof b.column !== "string") return [];
    const database = typeof b.database === "string" ? b.database : typeof b.databaseId === "string" ? b.databaseId : undefined;
    return [{ item: b.item, table: b.table, column: b.column, ...(database ? { database } : {}) }];
  });
  return { screen: raw.screen, ...(typeof raw.system === "string" ? { system: raw.system } : {}), view: raw.view, bindings };
}

const REMOVE = Symbol("remove");

/** view の遷移先 (to) を直した結果。分からない・この画面からの遷移ではない遷移先の名前を集める */
interface TargetProblems {
  /** 設計にそんな画面が無い */
  unknown: Set<string>;
  /** 設計にある画面だが、この画面からの遷移 (サイトマップ) の行き先ではない */
  notAllowed: Set<string>;
}

/**
 * view の中の遷移先 (to) を、画面の名前から設計の画面の id へ直す。遷移先にできるのは、サイトマップでこの画面から出る遷移の行き先だけ。
 * それ以外 (分からない名前・遷移の無い画面・自分自身) の to は、navigate の操作ならその操作ごと、ほか (送信のあと・一覧の列) なら to だけを外し、
 * その名前を problems に集める (元の view は書き換えない)
 */
function resolveViewTargets(view: unknown, resolve: (to: string) => { id: string } | "unknown" | "notAllowed", problems: TargetProblems): unknown {
  if (Array.isArray(view)) return view.map((v) => resolveViewTargets(v, resolve, problems)).filter((v) => v !== REMOVE);
  if (!isObject(view)) return view;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(view)) {
    if (key === "to" && typeof value === "string") {
      const r = resolve(value);
      if (typeof r === "object") out[key] = r.id;
      else {
        problems[r].add(value);
        if (view.kind === "navigate") return REMOVE;
      }
      continue;
    }
    const resolved = resolveViewTargets(value, resolve, problems);
    if (resolved !== REMOVE) out[key] = resolved;
  }
  return out;
}

/**
 * 画面の画面 UI と対応を足す (setDesignScreenView)。画面の名前は設計の画面 (サイトマップにあるもの) の名前。
 * title は画面の名前にそろえ、goal が無ければ説明 (無ければ名前) で補う。view 内の遷移先は名前から id に直す (分からない遷移先は外す)。
 * 落とす: 存在しないデータベース・テーブル・列や、view に無い項目の対応 (sanitizeBindings)。
 * view が mokkun の検証に通らなければ置かず、viewError を返す (呼ぶ側が AI に出し直させるか、警告のまま飛ばすかを選ぶ)
 */
export function applyScreenDraft(model: UntieModel, draft: ScreenDraft): ScreenDraftResult {
  const fail = (failure: string): ScreenDraftResult => ({ model, warnings: [failure], applied: false, failure, added: { bindings: 0, droppedBindings: 0 } });
  const wanted = nameOf(draft.screen);
  let system: { id: string } | undefined;
  if (draft.system) {
    system = findNamed(model, "system", draft.system);
    if (!system) return fail(`画面 UI: システム「${draft.system}」が見つかりません`);
  }
  const candidates = model.designs
    .filter((d) => !system || d.systemId === system.id)
    .flatMap((d) => d.screens.filter((s) => designScreenName(model, s) === wanted).map((s) => ({ design: d, screen: s })));
  if (candidates.length === 0) return fail(`画面 UI: 画面「${draft.screen}」がサイトマップに見つかりません`);
  const warnings: string[] = [];
  if (candidates.length > 1) warnings.push(`画面 UI: 画面「${draft.screen}」が複数のシステムにあるので、最初の 1 つに置きました`);
  const { design, screen } = candidates[0]!;

  // 大きさ・深さ・使えないキー (__proto__ など) は、読み替える前に検査する
  const shape = viewShapeProblem(draft.view);
  if (shape) return { model, warnings: [...warnings, `画面 UI: 画面「${wanted}」の view を置きませんでした (${shape})`], applied: false, viewError: shape, added: { bindings: 0, droppedBindings: 0 } };

  // 遷移先にできるのは、サイトマップでこの画面から出る遷移の行き先だけ (名前が重なれば、行き先のほうを先に引く)
  const allowed = new Set(design.transitions.filter((t) => t.from === screen.id && t.to !== screen.id).map((t) => t.to));
  const byName = new Map<string, string>();
  const nameLookup = [...design.screens.filter((s) => allowed.has(s.id)), ...design.screens.filter((s) => !allowed.has(s.id))];
  for (const s of nameLookup) {
    const n = designScreenName(model, s);
    if (!byName.has(n)) byName.set(n, s.id);
  }
  const screenIds = new Set(design.screens.map((s) => s.id));
  const problems: TargetProblems = { unknown: new Set(), notAllowed: new Set() };
  const resolved = resolveViewTargets(
    draft.view,
    (to) => {
      const id = screenIds.has(to) ? to : byName.get(nameOf(to));
      if (!id) return "unknown";
      return allowed.has(id) ? { id } : "notAllowed";
    },
    problems,
  ) as Record<string, unknown>;
  for (const t of problems.unknown) warnings.push(`画面 UI: 画面「${wanted}」の遷移先「${t}」が見つからないので、その遷移を外しました`);
  for (const t of problems.notAllowed) {
    warnings.push(`画面 UI: 画面「${wanted}」の遷移先「${t}」は、サイトマップでこの画面から出る遷移の行き先ではないので、その遷移を外しました (遷移を足すか、to を直してください)`);
  }

  const analysis = screen.source.kind === "screen" ? model.elements.find((e) => e.id === (screen.source as { screenId: string }).screenId) : undefined;
  const goal = typeof resolved.goal === "string" && resolved.goal.trim() !== "" ? resolved.goal : (analysis?.kind === "screen" && analysis.description?.trim()) || wanted;
  const view = { ...resolved, title: wanted, goal };
  const check = validateView(view, screen.id, design.screens.map((s) => s.id));
  if (!check.ok) {
    return { model, warnings: [...warnings, `画面 UI: 画面「${wanted}」の view が mokkun の検証に通らないので、置きませんでした (${check.message})`], applied: false, viewError: check.message, added: { bindings: 0, droppedBindings: 0 } };
  }
  // 対応: databaseId は名前で書かれていても使うデータベースの id にそろえる (sanitizeBindings が id で判定する。同じ名前のデータベースがあれば、この設計が使うほうを先に引く)。見つからない名前は、使うデータベースが 1 つだけならそれに付け替える (警告に残す)
  const used = effectiveDatabaseIds(model, design);
  const usedName = (id: string | undefined) => model.databases.find((d) => d.id === id)?.name ?? "";
  const replaced = new Set<string>();
  const proposed = clipList(draft.bindings, DESIGN_DRAFT_LIMITS.bindings, `画面 UI: 画面「${wanted}」の項目と列の対応`, warnings).map((b) => {
    const candidates = b.database ? model.databases.filter((d) => d.id === b.database || d.name === b.database) : [];
    const db = candidates.find((d) => used.includes(d.id)) ?? candidates[0];
    if (b.database && !db && used.length === 1 && !replaced.has(b.database)) {
      replaced.add(b.database);
      warnings.push(`画面 UI: 画面「${wanted}」の対応のデータベース「${b.database}」が見つからないので、使うデータベース「${usedName(used[0])}」に付け替えました`);
    }
    return { item: b.item, table: b.table, column: b.column, ...(db ? { databaseId: db.id } : {}) };
  });
  const { bindings, dropped, reasons } = sanitizeBindings(model, design, view, proposed);
  if (dropped > 0) {
    const detail = reasons.slice(0, DETAIL_MAX).map((r) => `${r.item}: ${r.reason}`).join("、");
    warnings.push(`画面 UI: 画面「${wanted}」の項目と列の対応のうち ${dropped} 件は、落としました (${detail}${dropped > DETAIL_MAX ? " ほか" : ""})`);
  }
  const r = setDesignScreenView(model, { systemId: design.systemId, id: screen.id, view, bindings });
  if (!r.ok) return { model, warnings: [...warnings, `画面 UI: 画面「${wanted}」の view を置けません: ${r.reason}`], applied: false, failure: r.reason, added: { bindings: 0, droppedBindings: dropped } };
  return { model: r.model, warnings, applied: true, added: { bindings: bindings.length, droppedBindings: dropped } };
}
