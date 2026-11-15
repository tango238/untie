// 「ソースコードから作成」の段階 1: データ。AI は使わない。
// ソースの中のスキーマ定義 (SQL と schema.prisma) を探し、選んだものを機械的に DSL へ変換して、開いているモデルの
// データベース (databases) に置く。システム・情報が無くても実行できる (設計 designs への結び付け databaseIds は、画面・業務の段階が行う)。
import { addDatabase, renameDatabase, setDatabaseDesign, type CommandResult } from "@untie/core/model/commands";
import { DEFAULT_DATABASE_ID } from "@untie/core/model/design";
import { databaseBindingCount } from "@untie/core/model/designData";
import { DSL_MAX_LENGTH, NAME_MAX_LENGTH, truncateText } from "@untie/core/model/limits";
import { parsePrismaDsl, type PrismaError } from "@untie/core/model/prisma";
import { sqlFilesToPrismaDsl, type SqlImportNote } from "@untie/core/model/sqlImport";
import type { UntieModel } from "@untie/core/model/types";
import { dropInvalidBindings } from "./designDraft";
import { visibleFiles, type SourceTree } from "./sourceTree";

// ---------------------------------------------------------------- 候補を探す

export type SchemaKind = "sql" | "prisma";

/** ソースの中にあった、スキーマ定義の候補 (SQL か schema.prisma) */
export interface SchemaCandidate {
  /** ソースの中のパス (`/` 区切り) */
  path: string;
  size: number;
  kind: SchemaKind;
  /** テーブルの定義 (SQL なら CREATE TABLE、schema.prisma なら model) を含むか */
  hasTables: boolean;
  /** マイグレーションのフォルダの中か (SQL だけ。順に当てる積み重ね) */
  migration: boolean;
  /** 中身を読む */
  read(): Promise<string>;
}

/** 候補を探すときの上限 (中身を読んで、テーブルの定義があるかを確かめる SQL の数) */
export const SCHEMA_SCAN_LIMITS = { sqlFiles: 300 } as const;

const MIGRATION_DIR = /(^|\/)(migrations?|migrate|db\/migrate|flyway|liquibase|alembic|versions)(\/|$)/i;
const CREATE_TABLE = /\bCREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\s+|UNLOGGED\s+|OR\s+REPLACE\s+)?TABLE\b/i;
const PRISMA_MODEL = /^\s*model\s+\w+\s*\{/m;

/** 同じ並びの比較 (数字は数として。「2」は「10」より前) */
export const comparePaths = (a: string, b: string): number => a.localeCompare(b, "ja", { numeric: true });

/** 1 つのソースの木の中から、スキーマ定義の候補を探す (.sql と .prisma)。並びは、パスの名前順。notes は探すときに気づいたこと */
export async function findSchemaCandidates(tree: SourceTree): Promise<{ candidates: SchemaCandidate[]; notes: string[] }> {
  const candidates: SchemaCandidate[] = [];
  const notes: string[] = [];
  const files = visibleFiles(tree);
  const make = (file: { path: string; size: number }, kind: SchemaKind, hasTables: boolean): SchemaCandidate => ({
    path: file.path,
    size: file.size,
    kind,
    hasTables,
    migration: kind === "sql" && MIGRATION_DIR.test(file.path),
    read: () => tree.readFile(file.path),
  });
  const sqls = files.filter((f) => /\.sql$/i.test(f.path));
  for (const f of files.filter((x) => /\.prisma$/i.test(x.path))) {
    const text = await tree.readFile(f.path).catch(() => "");
    candidates.push(make(f, "prisma", PRISMA_MODEL.test(text)));
  }
  for (const f of sqls.slice(0, SCHEMA_SCAN_LIMITS.sqlFiles)) {
    const text = await tree.readFile(f.path).catch(() => "");
    candidates.push(make(f, "sql", CREATE_TABLE.test(text)));
  }
  if (sqls.length > SCHEMA_SCAN_LIMITS.sqlFiles) {
    notes.push(`SQL のファイルが ${sqls.length} 件あり、先頭 ${SCHEMA_SCAN_LIMITS.sqlFiles} 件だけ調べました。ほかの SQL は「SQL のファイルを選ぶ」で足してください`);
  }
  candidates.sort((a, b) => comparePaths(a.path, b.path));
  return { candidates, notes };
}

/**
 * 既定で選ぶ候補。テーブルの定義があるものだけを、次の順で最初に見つかった組にする:
 * 1. schema.prisma (最終の形そのもの。マイグレーションの SQL と重ねると同じテーブルが 2 回になる)
 * 2. マイグレーションではない SQL (schema.sql・structure.sql・ダンプなど。最終の形)
 * 3. マイグレーションの SQL (パスの名前順に当てる積み重ね)
 */
export function defaultSchemaSelection<T extends Pick<SchemaCandidate, "kind" | "hasTables" | "migration"> & { id: string }>(candidates: readonly T[]): Set<string> {
  const withTables = candidates.filter((c) => c.hasTables);
  const tiers = [withTables.filter((c) => c.kind === "prisma"), withTables.filter((c) => c.kind === "sql" && !c.migration), withTables.filter((c) => c.kind === "sql" && c.migration)];
  return new Set((tiers.find((t) => t.length > 0) ?? []).map((c) => c.id));
}

// ---------------------------------------------------------------- 変換

/** 変換する入力 (候補から読んだ・直接選んだファイル) */
export interface SchemaInput {
  /** 画面に出す名前 (パス) */
  path: string;
  text: string;
  kind: SchemaKind;
}

/** 変換の結果の気づいたこと (どのファイルのどの行か) */
export interface SchemaNote {
  where: string;
  message: string;
}

export interface SchemaPreview {
  /** 置く DSL (テーブルが 1 つも無ければ空) */
  dsl: string;
  tables: { name: string; columns: number }[];
  enums: string[];
  notes: SchemaNote[];
  dslErrors: PrismaError[];
  /** 変換そのものができなかった理由 (sqlImport が例外を投げたなど) */
  failure?: string;
}

const noteOf = (n: SqlImportNote): SchemaNote => ({ where: n.file ? `${n.file}${n.line !== undefined ? `:${n.line}` : ""}` : n.line !== undefined ? `${n.line} 行目` : "", message: n.message });

/**
 * 選んだファイルを DSL に変換する (AI は使わない)。SQL は渡した順に当てる (マイグレーションの積み重ね。順は呼ぶ側が決める) ので、
 * SQL をまとめて sqlFilesToPrismaDsl に渡し、schema.prisma はそのまま DSL として使う。SQL と schema.prisma を両方選んだときは、続けてつなぐ
 * (同じテーブルが両方にあれば DSL の解析エラーになる)。テーブルの数と列の数は、できあがった DSL から数える
 */
export function previewSchema(inputs: readonly SchemaInput[]): SchemaPreview {
  const notes: SchemaNote[] = [];
  const parts: string[] = [];
  const enums = new Set<string>();
  const sqls = inputs.filter((i) => i.kind === "sql");
  if (sqls.length > 0) {
    try {
      const r = sqlFilesToPrismaDsl(sqls.map((i) => ({ path: i.path, text: i.text })));
      notes.push(...r.notes.map(noteOf));
      if (r.dsl.trim() !== "") parts.push(r.dsl.trim());
      for (const e of r.enums) enums.add(e);
    } catch (e) {
      return { dsl: "", tables: [], enums: [], notes, dslErrors: [], failure: `SQL を変換できませんでした (${e instanceof Error ? e.message : String(e)})` };
    }
  }
  for (const p of inputs.filter((i) => i.kind === "prisma")) if (p.text.trim() !== "") parts.push(p.text.trim());
  const dsl = parts.length > 0 ? `${parts.join("\n\n")}\n` : "";
  const schema = parsePrismaDsl(dsl);
  for (const e of schema.enums) enums.add(e.name);
  const modelNames = new Set(schema.models.map((m) => m.name));
  const tables = schema.models.map((m) => ({ name: m.name, columns: m.fields.filter((f) => !modelNames.has(f.type)).length }));
  const tooLong = dsl.length > DSL_MAX_LENGTH ? [{ line: 1, column: 1, message: `DSL が長すぎます (${dsl.length.toLocaleString("ja-JP")} 文字。上限は ${DSL_MAX_LENGTH.toLocaleString("ja-JP")} 文字)。選ぶファイルを減らしてください` }] : [];
  return { dsl, tables, enums: [...enums], notes, dslErrors: [...schema.errors, ...tooLong] };
}

/** 変換できて、取り込める結果か (テーブルがあり、DSL にエラーが無い) */
export const canImportPreview = (p: SchemaPreview): boolean => !p.failure && p.tables.length > 0 && p.dslErrors.length === 0;

// ---------------------------------------------------------------- データベースに置く

/** データベースの既定の名前: ソースのラベルから「〇〇のデータベース」。ラベルが無ければフォルダ名。どちらも無ければ「データベース」 */
export function defaultDatabaseName(label: string, folder: string): string {
  const base = label.trim() || folder.trim();
  return base === "" ? "データベース" : truncateText(`${base}のデータベース`, NAME_MAX_LENGTH);
}

export interface DataImportResult {
  model: UntieModel;
  /** 置いたデータベースの id (置けなければ無し) */
  databaseId?: string;
  /** 同じ名前のデータベースを置き換えたか */
  replaced: boolean;
  /** 置けなかった理由 */
  failure?: string;
  /** 置き換えで、無くなったテーブル・列への画面の項目の対応を外した件数 */
  droppedBindings: number;
  /** 置き換えで、無くなったテーブルの情報との対応を外したテーブルの名前 */
  droppedMappings: string[];
  /** 同じ名前のテーブルで残した、情報との対応のテーブルの数 */
  keptMappings: number;
  warnings: string[];
}

/**
 * 変換した DSL を、名前のデータベースに置く。同じ名前のデータベースがあれば置き換える (id を変えないので、設計の使うデータベースと
 * 画面の項目の対応は残る。DSL に無くなったテーブル・列への対応だけ外れる。同じ名前のテーブルの情報との対応は残す)。無ければ足す。
 * データベースがまだ空の既定のもの 1 つだけなら、それに名前を付けて使う。システム・情報が無くても置ける
 */
export function applyDataImport(model: UntieModel, input: { name: string; dsl: string }): DataImportResult {
  const name = truncateText(input.name.trim(), NAME_MAX_LENGTH);
  const fail = (failure: string): DataImportResult => ({ model, replaced: false, failure, droppedBindings: 0, droppedMappings: [], keptMappings: 0, warnings: [failure] });
  if (name === "") return fail("データベースの名前を入れてください");
  const schema = parsePrismaDsl(input.dsl);
  if (schema.errors.length > 0) return fail(`DSL に解析エラーが ${schema.errors.length} 件あるので、置けません`);
  if (schema.models.length === 0) return fail("テーブルが 1 つも無いので、置けません");
  const existing = model.databases.find((d) => d.name === name);
  const warnings: string[] = [];
  let next = model;
  const step = <T,>(r: CommandResult<T>, what: string): (T & { model: UntieModel }) | null => {
    if (!r.ok) {
      warnings.push(`${what}: ${r.reason}`);
      return null;
    }
    next = r.model;
    return r as T & { model: UntieModel };
  };
  const emptyDefault = model.databases.length === 1 && model.databases[0]!.id === DEFAULT_DATABASE_ID && model.databases[0]!.dsl === "" && model.databases[0]!.tables.length === 0;
  let databaseId: string;
  if (existing) databaseId = existing.id;
  else if (emptyDefault) {
    databaseId = DEFAULT_DATABASE_ID;
    if (!step(renameDatabase(next, { id: databaseId, name }), "データベースの名前を付けられません")) return fail(warnings.join(" / "));
  } else {
    const added = step(addDatabase(next, { name }), "データベースを足せません");
    if (!added) return fail(warnings.join(" / "));
    databaseId = added.id;
  }
  // 情報との対応は、同じ名前のテーブルのものを残す (DSL に無くなったテーブルの対応は外れる)
  const modelNames = new Set(schema.models.map((m) => m.name));
  const before = existing?.tables.filter((t) => t.informationIds.length > 0) ?? [];
  const kept = before.filter((t) => modelNames.has(t.table));
  const droppedMappings = before.filter((t) => !modelNames.has(t.table)).map((t) => t.table);
  const bindingsBefore = databaseBindingCount(next, databaseId);
  if (!step(setDatabaseDesign(next, { id: databaseId, dsl: input.dsl, tables: kept.map((t) => ({ table: t.table, informationIds: [...t.informationIds] })) }), "DSL を置けません")) return fail(warnings.join(" / "));
  next = dropInvalidBindings(next, databaseId, warnings);
  return { model: next, databaseId, replaced: !!existing, droppedBindings: bindingsBefore - databaseBindingCount(next, databaseId), droppedMappings, keptMappings: kept.length, warnings };
}

/** 取り込む前に、同じ名前のデータベースを置き換えるか・置き換えると何が外れるかを調べる (モデルは変えない) */
export function planDataImport(model: UntieModel, input: { name: string; dsl: string }): { replaces: boolean; droppedBindings: number; droppedMappings: string[]; tableCount: number } {
  const name = input.name.trim();
  const existing = model.databases.find((d) => d.name === name);
  const r = applyDataImport(model, input);
  return { replaces: !!existing && !r.failure, droppedBindings: r.droppedBindings, droppedMappings: r.droppedMappings, tableCount: existing ? existing.tables.length : 0 };
}

/** 気づいたことを、画面に出す文にする (1 件ずつ。多いときは先頭だけ) */
export function describeSchemaNotes(notes: readonly SchemaNote[], max = 20): string[] {
  const lines = notes.slice(0, max).map((n) => (n.where ? `${n.where}: ${n.message}` : n.message));
  if (notes.length > max) lines.push(`ほか ${notes.length - max} 件`);
  return lines;
}

/** 取り込んだ結果の要約 (履歴・引き継ぐ会話・画面の結果の行に使う) */
export function dataImportSummary(preview: SchemaPreview, name: string, r: DataImportResult): string {
  const columns = preview.tables.reduce((n, t) => n + t.columns, 0);
  return `データベース「${name}」に、テーブル ${preview.tables.length} (列 ${columns}) を${r.replaced ? "置き換えて" : ""}取り込みました。`;
}
