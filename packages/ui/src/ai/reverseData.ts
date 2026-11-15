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
import { isSchemaFileName, MAX_FILE_BYTES, MAX_SCHEMA_FILE_BYTES, visibleFiles, type SourceTree } from "./sourceTree";

// ---------------------------------------------------------------- 候補を探す

export type SchemaKind = "sql" | "prisma";

/** ソースの中にあった、スキーマ定義の候補 (SQL か schema.prisma) */
export interface SchemaCandidate {
  /** ソースの中のパス (`/` 区切り) */
  path: string;
  size: number;
  kind: SchemaKind;
  /** テーブルの定義 (SQL なら CREATE TABLE、schema.prisma なら model) を含むか。ALTER・DROP だけのマイグレーションは含まない */
  hasTables: boolean;
  /** マイグレーションの組 (順に当てる積み重ね) のファイルか (SQL だけ)。`group` があるときだけ真 */
  migration: boolean;
  /** 所属するマイグレーションの組 (フォルダのパス)。1 つの組は、既定では進む向きのファイルを全部選ぶ */
  group?: string;
  /** 取り消し用 (down・rollback・revert・undo。Flyway の U 始まり) か。候補には出すが、既定では選ばない */
  down: boolean;
  /** 組の中で当てる順 (1 始まり。進む向きのファイルだけ) */
  order?: number;
  /** 組の当てる順を、名前の番号から決められなかった (名前順にしてある。利用者が順を確かめる) */
  orderUncertain?: boolean;
  /** 組の中の並び (取り消し用を含む。当てる順に並べるための内部の値) */
  seq?: number;
  /** 中身を読む (大きなダンプも読める) */
  read(): Promise<string>;
}

/** 候補を探すときの上限 (中身を読んで、テーブルの定義があるかを確かめる SQL の数) */
const SCHEMA_SCAN_LIMITS = { sqlFiles: 1000 } as const;
/** 大きなファイルは、テーブルの定義があるかを、先頭からこの文字数だけ見て決める (全部は読まない) */
const SCAN_HEAD_CHARS = 1_000_000;

/** マイグレーションのフォルダの名前 (この名前のフォルダの下の SQL は、1 つの組) */
const MIGRATION_ROOT = /^(migrations?|migrate|flyway|liquibase|alembic|versions)$/i;
const CREATE_TABLE = /\bCREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\s+|UNLOGGED\s+|OR\s+REPLACE\s+)?TABLE\b/i;
const PRISMA_MODEL = /^\s*model\s+\w+\s*\{/m;

/** 同じ並びの比較 (数字は数として。「2」は「10」より前) */
export const comparePaths = (a: string, b: string): number => a.localeCompare(b, "ja", { numeric: true });

/** 取り消し用の名前か (down・rollback・revert・undo。Flyway の U 始まり)。ファイル名と、組の下のフォルダの名前を見る */
export function isDownMigration(relative: string): boolean {
  const segs = relative.split("/");
  const file = segs[segs.length - 1] ?? "";
  if (/(^|[._-])(down|rollback|revert|undo)\.sql$/i.test(file) || /^U\d+(?:[._]\d+)*__/.test(file)) return true;
  return segs.some((seg) => /^(down|rollback|revert|undo)$/i.test(seg) || /[_-](rollback|revert)(?:[._-]|$)/i.test(seg) || /(?:^|[_-])(rollback|revert)[_-]/i.test(seg));
}

/** 名前の先頭の版の番号 (V1__・2_・20240101120000_・1.2.3_・V1_2__ など)。数の並び (0 を除いた文字列)。無ければ null */
function versionParts(name: string): string[] | null {
  if (/^R__/.test(name)) return ["9".repeat(40)];
  const m = /^[VvUu]?(\d+(?:[._]\d+)*)/.exec(name);
  return m ? m[1]!.split(/[._]/).map((p) => p.replace(/^0+(?=\d)/, "")) : null;
}

const compareNumeric = (a: string, b: string): number => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);
function compareKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareNumeric(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** 組の中でのパス (組のフォルダからの相対) の、当てる順の鍵。各階層の名前の先頭の番号をつなげる (Prisma の `20240101_init/migration.sql` はフォルダ名の番号)。番号が無ければ null */
function orderKey(relative: string): string[] | null {
  const key = relative.split("/").flatMap((seg) => versionParts(seg) ?? []);
  return key.length > 0 ? key : null;
}

/** 組の鍵を持たない、順番を表す名前 (先頭が番号か V+番号)。同じフォルダに 2 つ以上並んでいれば 1 つの組にする */
const ORDERED_NAME = /^(?:[Vv]\d|\d+[._-]|\d{8,})/;

/** パスから、マイグレーションの組のフォルダを決める (マイグレーションのフォルダの名前のフォルダまで)。無ければ null */
function migrationRootOf(path: string): string | null {
  const segs = path.split("/");
  for (let i = 0; i < segs.length - 1; i++) if (MIGRATION_ROOT.test(segs[i]!)) return segs.slice(0, i + 1).join("/");
  return null;
}

/** 候補探しの結果 */
export interface SchemaScan {
  /** 並びは、マイグレーションの組をまとめて、組の中は当てる順。ほかは名前順 */
  candidates: SchemaCandidate[];
  notes: string[];
  /** 候補に入れられなかった SQL・schema.prisma の件数 (理由ごと) */
  skipped: { folder: number; tooLarge: number; unreadable: number; overLimit: number };
}

/** 1 つのソースの木の中から、スキーマ定義の候補を探す (.sql と .prisma。大きさの上限は、ここでは掛けない)。notes は探すときに気づいたこと */
export async function findSchemaCandidates(tree: SourceTree): Promise<SchemaScan> {
  const notes: string[] = [];
  const named = new Map<string, { path: string; size: number }>();
  for (const f of [...visibleFiles(tree), ...(tree.schemaFiles?.large ?? [])]) if (isSchemaFileName(f.path)) named.set(f.path, f);
  const files = [...named.values()].sort((a, b) => comparePaths(a.path, b.path));
  const read = (path: string, size: number): Promise<string> =>
    size > MAX_FILE_BYTES && tree.schemaFiles ? tree.schemaFiles.read(path, SCAN_HEAD_CHARS) : tree.schemaFiles ? tree.schemaFiles.read(path) : tree.readFile(path);
  const fullRead = (path: string): Promise<string> => (tree.schemaFiles ? tree.schemaFiles.read(path) : tree.readFile(path));
  const sqls = files.filter((f) => /\.sql$/i.test(f.path));
  const prismas = files.filter((f) => /\.prisma$/i.test(f.path));
  const scanned = sqls.slice(0, SCHEMA_SCAN_LIMITS.sqlFiles);
  let unreadable = 0;
  /** 先頭 (大きなものは先頭だけ) を読んで調べる。読めなければ null */
  const probe = async (f: { path: string; size: number }, test: RegExp): Promise<boolean | null> => {
    try {
      return test.test((await read(f.path, f.size)).slice(0, f.size > MAX_FILE_BYTES ? SCAN_HEAD_CHARS : undefined));
    } catch {
      unreadable++;
      return null;
    }
  };
  const flags = new Map<string, boolean>();
  const all = [
    ...prismas.map((f) => ({ f, test: PRISMA_MODEL })),
    ...scanned.map((f) => ({ f, test: CREATE_TABLE })),
  ];
  for (let i = 0; i < all.length; i += 8) {
    await Promise.all(
      all.slice(i, i + 8).map(async ({ f, test }) => {
        const r = await probe(f, test);
        if (r !== null) flags.set(f.path, r);
      }),
    );
  }
  // 組: マイグレーションのフォルダの下の SQL、と、同じフォルダに 2 つ以上並ぶ、順番を表す名前の SQL
  const groupOf = new Map<string, string>();
  const byDir = new Map<string, string[]>();
  for (const f of scanned) {
    if (!flags.has(f.path)) continue;
    const root = migrationRootOf(f.path);
    if (root) groupOf.set(f.path, root);
    else if (ORDERED_NAME.test(f.path.split("/").pop()!)) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      byDir.set(dir, [...(byDir.get(dir) ?? []), f.path]);
    }
  }
  for (const [dir, paths] of byDir) if (paths.length >= 2) for (const p of paths) groupOf.set(p, dir === "" ? "(ソースの直下)" : dir);
  const rootOfGroup = (g: string): string => (g === "(ソースの直下)" ? "" : g);
  const relativeOf = (path: string, g: string): string => (rootOfGroup(g) === "" ? path : path.slice(rootOfGroup(g).length + 1));

  const candidates: SchemaCandidate[] = [];
  const make = (f: { path: string; size: number }, kind: SchemaKind, group: string | undefined): SchemaCandidate => ({
    path: f.path,
    size: f.size,
    kind,
    hasTables: flags.get(f.path) ?? false,
    migration: group !== undefined,
    ...(group !== undefined ? { group } : {}),
    down: group !== undefined && isDownMigration(relativeOf(f.path, group)),
    read: () => fullRead(f.path),
  });
  for (const f of prismas) if (flags.has(f.path)) candidates.push(make(f, "prisma", undefined));
  for (const f of scanned) if (flags.has(f.path)) candidates.push(make(f, "sql", groupOf.get(f.path)));
  // 組ごとに、当てる順を決める (進む向きのファイルだけに番号を付ける)
  const groups = new Map<string, SchemaCandidate[]>();
  for (const c of candidates) if (c.group !== undefined) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  for (const [g, members] of groups) {
    const keyed = members.map((c) => ({ c, key: orderKey(relativeOf(c.path, g)) }));
    keyed.sort((a, b) => {
      // 番号の無いもの (最初の形のスキーマなど) は先頭。同じ番号なら、進む向き、そのあと名前順
      if (a.key === null || b.key === null) return a.key === b.key ? comparePaths(a.c.path, b.c.path) : a.key === null ? -1 : 1;
      return compareKeys(a.key, b.key) || Number(a.c.down) - Number(b.c.down) || comparePaths(a.c.path, b.c.path);
    });
    const forward = keyed.filter((k) => !k.c.down);
    const seen = new Set<string>();
    let tie = false;
    for (const k of forward) {
      const id = k.key ? k.key.join(".") : "";
      if (k.key && seen.has(id)) tie = true;
      seen.add(id);
    }
    const uncertain = forward.some((k) => k.key === null) || tie;
    keyed.forEach((k) => {
      if (uncertain) k.c.orderUncertain = true;
    });
    forward.forEach((k, i) => (k.c.order = i + 1));
    keyed.forEach((k, i) => (k.c.seq = i));
  }
  const seqOf = (c: SchemaCandidate): number => c.seq ?? 0;
  candidates.sort((a, b) => comparePaths(a.group ?? a.path, b.group ?? b.path) || (a.group === b.group ? seqOf(a) - seqOf(b) : 0) || comparePaths(a.path, b.path));

  const overLimit = Math.max(0, sqls.length - scanned.length);
  const schemaFiles = tree.schemaFiles;
  const skipped = { folder: schemaFiles?.skipped.folder ?? 0, tooLarge: schemaFiles?.skipped.tooLarge ?? 0, unreadable: unreadable + (schemaFiles?.skipped.unreadable ?? 0), overLimit };
  if (overLimit > 0) notes.push(`SQL のファイルが ${sqls.length} 件あり、先頭 ${SCHEMA_SCAN_LIMITS.sqlFiles} 件だけ調べました。ほかの SQL は「SQL のファイルを選ぶ」で足してください`);
  if (skipped.tooLarge > 0) notes.push(`大きすぎる (${Math.round(MAX_SCHEMA_FILE_BYTES / 1_000_000)} MB を超える) SQL・schema.prisma が ${skipped.tooLarge} 件ありました。候補に入れていません。「SQL のファイルを選ぶ」で選んでください`);
  if (skipped.unreadable > 0) notes.push(`読めなかった SQL・schema.prisma が ${skipped.unreadable} 件ありました。フォルダの読み取りの権限が切れていないか確かめ、「選び直す」か「SQL のファイルを選ぶ」で足してください`);
  if (skipped.folder > 0) notes.push(`除外したフォルダ (node_modules・dist・build など) の下の SQL・schema.prisma が ${skipped.folder} 件ありました。候補に入れていません。必要なら「SQL のファイルを選ぶ」で選んでください`);
  return { candidates, notes, skipped };
}

type DefaultInput = Pick<SchemaCandidate, "kind" | "hasTables" | "migration" | "group" | "down"> & { id: string; rowKey?: number | string };

/** 1 つのソースの中の既定の選び方。同じ段のものがなければ次の段。マイグレーションは、最も大きな組 1 つだけ */
function defaultForRow<T extends DefaultInput>(row: readonly T[]): { ids: string[]; otherGroups: string[] } {
  const prisma = row.filter((c) => c.kind === "prisma" && c.hasTables);
  if (prisma.length > 0) return { ids: prisma.map((c) => c.id), otherGroups: [] };
  const dumps = row.filter((c) => c.kind === "sql" && c.group === undefined && !c.down && c.hasTables);
  if (dumps.length > 0) return { ids: dumps.map((c) => c.id), otherGroups: [] };
  const groups = new Map<string, T[]>();
  for (const c of row) if (c.kind === "sql" && c.group !== undefined) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  const usable = [...groups.entries()].filter(([, members]) => members.some((c) => !c.down && c.hasTables));
  if (usable.length === 0) return { ids: [], otherGroups: [] };
  // ファイルの多い組 (同じなら先に並ぶ組)
  const best = usable.reduce((a, b) => (b[1].filter((c) => !c.down).length > a[1].filter((c) => !c.down).length ? b : a));
  return { ids: best[1].filter((c) => !c.down).map((c) => c.id), otherGroups: usable.filter(([g]) => g !== best[0]).map(([g]) => g) };
}

/** ソースごとの候補 (rowKey が同じものを 1 つのソースとして、出てきた順に) */
function rowsOf<T extends DefaultInput>(candidates: readonly T[]): { rowKey: number | string | undefined; items: T[] }[] {
  const rows: { rowKey: number | string | undefined; items: T[] }[] = [];
  for (const c of candidates) {
    const row = rows.find((r) => r.rowKey === c.rowKey);
    if (row) row.items.push(c);
    else rows.push({ rowKey: c.rowKey, items: [c] });
  }
  return rows;
}

/**
 * 既定で選ぶ候補。1 つのソースの中では、次の順で最初に見つかった組にする (テーブルの定義があるものだけ):
 * 1. schema.prisma (最終の形そのもの。マイグレーションの SQL と重ねると同じテーブルが 2 回になる)
 * 2. マイグレーションではない SQL (schema.sql・structure.sql・ダンプなど。最終の形)
 * 3. マイグレーションの組 (フォルダ) 1 つ: 進む向きのファイルを全部 (CREATE TABLE を含むかに関係なく。ALTER だけ・DROP だけのファイルも当てる)。
 *    取り消し用 (down など) は選ばない。複数の組があれば、ファイルの多い 1 つだけ (複数の道具のマイグレーションを混ぜない)
 * ソースが複数 (rowKey) あるときは、スキーマの見つかった最初のソースだけを選ぶ (データベースは 1 つずつ取り込む。skipRows は、取り込み済みのソース)
 */
export function defaultSchemaSelection<T extends DefaultInput>(candidates: readonly T[], skipRows: ReadonlySet<number | string> = new Set()): Set<string> {
  for (const row of rowsOf(candidates)) {
    if (row.rowKey !== undefined && skipRows.has(row.rowKey)) continue;
    const { ids } = defaultForRow(row.items);
    if (ids.length > 0) return new Set(ids);
  }
  return new Set();
}

/** 既定の選び方で、選ばれなかったもの: スキーマの見つかった、ほかのソース (rowKey) と、選ばれなかったマイグレーションの組 */
export function defaultSchemaLeftovers<T extends DefaultInput>(candidates: readonly T[], skipRows: ReadonlySet<number | string> = new Set()): { rows: (number | string)[]; groups: string[] } {
  const rows: (number | string)[] = [];
  const groups: string[] = [];
  let first = true;
  for (const row of rowsOf(candidates)) {
    if (row.rowKey !== undefined && skipRows.has(row.rowKey)) continue;
    const d = defaultForRow(row.items);
    if (d.ids.length === 0) continue;
    if (first) {
      first = false;
      groups.push(...d.otherGroups);
    } else if (row.rowKey !== undefined) rows.push(row.rowKey);
  }
  return { rows, groups };
}

/**
 * 選んだマイグレーションの組のうち、一部だけ選ばれているもの (進む向きのファイルに選んでいないものがある、または取り消し用を選んでいる)。
 * マイグレーションは順に全部当てないと、最後の形にならない
 */
export function partialMigrationGroups<T extends Pick<SchemaCandidate, "group" | "down"> & { id: string }>(candidates: readonly T[], selected: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const groups = new Set(candidates.flatMap((c) => (c.group !== undefined ? [c.group] : [])));
  for (const g of groups) {
    const members = candidates.filter((c) => c.group === g);
    const picked = members.filter((c) => selected.has(c.id));
    if (picked.length === 0) continue;
    if (members.some((c) => !c.down && !selected.has(c.id)) || picked.some((c) => c.down)) out.push(g);
  }
  return out;
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
  warnings.push(...databaseOverlaps(model, input).map((o) => o.message));
  return { model: next, databaseId, replaced: !!existing, droppedBindings: bindingsBefore - databaseBindingCount(next, databaseId), droppedMappings, keptMappings: kept.length, warnings };
}

/**
 * これから置く DSL と、同じテーブルが多く重なる、別の名前のデータベース (名前が同じものは置き換えるので数えない)。
 * 同じデータベースを別の名前で二重に取り込もうとしているのかもしれないので、知らせる (止めはしない)。2 つ以上重なり、小さいほうの半分以上が重なるとき
 */
export function databaseOverlaps(model: UntieModel, input: { name: string; dsl: string }): { name: string; shared: number; message: string }[] {
  const name = input.name.trim();
  const mine = new Set(parsePrismaDsl(input.dsl).models.map((m) => m.name.toLowerCase()));
  if (mine.size === 0) return [];
  return model.databases.flatMap((d) => {
    if (d.name === name) return [];
    const theirs = new Set(parsePrismaDsl(d.dsl).models.map((m) => m.name.toLowerCase()));
    const shared = [...mine].filter((n) => theirs.has(n)).length;
    if (shared < 2 || shared * 2 < Math.min(mine.size, theirs.size)) return [];
    return [{ name: d.name, shared, message: `データベース「${d.name}」と同じテーブルが ${shared} 個あります。置き換えるなら同じ名前にしてください` }];
  });
}

/** 取り込む前に、同じ名前のデータベースを置き換えるか・置き換えると何が外れるか・同じテーブルが多く重なる別のデータベースがあるかを調べる (モデルは変えない) */
export function planDataImport(
  model: UntieModel,
  input: { name: string; dsl: string },
): { replaces: boolean; droppedBindings: number; droppedMappings: string[]; tableCount: number; overlaps: { name: string; shared: number; message: string }[] } {
  const name = input.name.trim();
  const existing = model.databases.find((d) => d.name === name);
  const r = applyDataImport(model, input);
  return { replaces: !!existing && !r.failure, droppedBindings: r.droppedBindings, droppedMappings: r.droppedMappings, tableCount: existing ? existing.tables.length : 0, overlaps: databaseOverlaps(model, input) };
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
