// SQL のスキーマ定義 (CREATE TABLE など) を、データベースの DSL (Prisma のスキーマ言語の一部。prisma.ts) へ機械的に変換する。
// 純粋関数だけを置く。AI は使わない。設計書 5.7「データ」の「SQL からの変換」。
//
// 流れ: sqlLex.ts が文を切り出す → sqlSchema.ts が文を順に当ててテーブル・列・制約・enum の「いまの形」(カタログ) を作る →
// ここでカタログから名前を決め、型・DEFAULT・関連を写して DSL の文字列にする。同じ入力から必ず同じ文字列になる。
import { DESCRIPTION_MAX_LENGTH, DSL_MAX_LENGTH, NAME_MAX_LENGTH, truncateText } from "./limits";
import { PRISMA_SCALAR_TYPES, parsePrismaDsl, type PrismaError } from "./prisma";
import { detectDialect, scanStatements } from "./sqlLex";
import { applyStatement, Catalog, finalizeCatalog, MAX_COLUMNS_PER_TABLE, MAX_DDL_STATEMENTS, MAX_ENUM_VALUES, MAX_ENUMS, MAX_NOTES, MAX_TABLES, type Col, type EnumDef, type Table } from "./sqlSchema";
import { convertDefault, mapScalar, quoteDsl, type ScalarName } from "./sqlTypes";

/** 変換で気づいたこと (読み飛ばした文・変換できなかった型など)。file は複数のファイルを渡したときのパス */
export interface SqlImportNote {
  file?: string;
  /** 1 始まりの行番号 (分からなければ省く) */
  line?: number;
  message: string;
}

export interface SqlImportTable {
  /** SQL のテーブル名 (スキーマ名は除く) */
  table: string;
  /** DSL の model の名前 */
  model: string;
  columns: number;
}

export interface SqlImportResult {
  /** 生成した DSL (テーブルが 1 つも無ければ空文字) */
  dsl: string;
  tables: SqlImportTable[];
  /** enum の名前 */
  enums: string[];
  notes: SqlImportNote[];
  /** 生成した DSL を parsePrismaDsl にかけたときのエラー (空であるべき) */
  dslErrors: PrismaError[];
}

export interface SqlFile {
  path: string;
  text: string;
}

/** 読む量の上限 (超えた分は読まずに notes に残す) */
export const SQL_IMPORT_LIMITS = {
  /** 入力の文字数 (複数のファイルは合計) */
  maxChars: 50_000_000,
  /** ファイルの数 */
  maxFiles: 2000,
  /** テーブルの数 */
  maxTables: MAX_TABLES,
  /** 1 つのテーブルの列の数 */
  maxColumnsPerTable: MAX_COLUMNS_PER_TABLE,
  /** enum の数と、1 つの enum の値の数 */
  maxEnums: MAX_ENUMS,
  maxEnumValues: MAX_ENUM_VALUES,
  /** CREATE・ALTER・DROP・COMMENT・RENAME の文の数 */
  maxStatements: MAX_DDL_STATEMENTS,
  /** notes の数 (超えたら 1 件にまとめる) */
  maxNotes: MAX_NOTES,
  /** 生成する DSL の文字数 (DSL_MAX_LENGTH。超えるぶんのテーブルは出さない) */
  maxDslChars: DSL_MAX_LENGTH,
} as const;

/** 1 つの SQL の文字列を変換する */
export function sqlToPrismaDsl(sql: string): SqlImportResult {
  return run([{ path: "", text: sql }], false);
}

/** 複数の SQL ファイルを、渡した順に当てて変換する (マイグレーションの積み重ね。順は呼ぶ側が決める) */
export function sqlFilesToPrismaDsl(files: readonly SqlFile[]): SqlImportResult {
  return run(files, true);
}

// ---------------------------------------------------------------------------------------------
// 全体

function run(files: readonly SqlFile[], withFile: boolean): SqlImportResult {
  const cat = new Catalog();
  try {
    let budget: number = SQL_IMPORT_LIMITS.maxChars;
    const list = files.length > SQL_IMPORT_LIMITS.maxFiles ? files.slice(0, SQL_IMPORT_LIMITS.maxFiles) : files;
    if (files.length > list.length) cat.note(undefined, undefined, `ファイルの数が上限 (${SQL_IMPORT_LIMITS.maxFiles}) を超えたため、${files.length - list.length} 個を読みませんでした`);
    for (const f of list) {
      let text = typeof f?.text === "string" ? f.text : "";
      const file = withFile && typeof f?.path === "string" ? truncateText(f.path, NAME_MAX_LENGTH) : undefined;
      const ctxFile = file !== undefined && file !== "" ? { file } : {};
      if (budget <= 0) {
        cat.note({ ...ctxFile, dialect: "other", text: "" }, undefined, "入力の大きさが上限を超えたため、このファイルを読みませんでした");
        continue;
      }
      if (text.length > budget) {
        cat.note({ ...ctxFile, dialect: "other", text: "" }, undefined, `入力が上限 (${SQL_IMPORT_LIMITS.maxChars} 文字) を超えたため、先頭の ${budget} 文字だけを読みました`);
        text = text.slice(0, budget);
      }
      budget -= text.length;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const dialect = detectDialect(text);
      const ctx = { ...ctxFile, dialect, text };
      scanStatements(text, dialect, (st) => applyStatement(cat, st, ctx));
    }
  } catch {
    cat.note(undefined, undefined, "SQL を最後まで読めませんでした。読めたところまでを使います");
  }
  let live: Table[] = [];
  try {
    live = finalizeCatalog(cat);
  } catch {
    cat.note(undefined, undefined, "テーブルの定義を確定できませんでした");
  }
  let out: { dsl: string; tables: SqlImportTable[]; enums: string[] } = { dsl: "", tables: [], enums: [] };
  try {
    out = generate(cat, live);
  } catch {
    cat.note(undefined, undefined, "DSL を組み立てられませんでした");
  }
  summarize(cat, live.length);
  const dslErrors = out.dsl === "" ? [] : parsePrismaDsl(out.dsl).errors;
  return { dsl: out.dsl, tables: out.tables, enums: out.enums, notes: cat.notes, dslErrors };
}

function summarize(cat: Catalog, tableCount: number): void {
  if (cat.skipped.size > 0) {
    const parts = [...cat.skipped].map(([label, n]) => `${label} ${n} 件`);
    cat.notes.push({ message: `読み飛ばした文: ${parts.join("、")}` });
  }
  if (cat.dataSkipped.size > 0) {
    const parts = [...cat.dataSkipped].map(([label, n]) => `${label} ${n} 件`);
    cat.notes.push({ message: `データの文 (${parts.join("、")}) は読み飛ばしました。データは取り込みません` });
  }
  if (tableCount === 0) cat.notes.push({ message: "テーブルの定義 (CREATE TABLE) が見つかりませんでした" });
  if (cat.omittedNotes > 0) cat.notes.push({ message: `ほかにも ${cat.omittedNotes} 件の注意がありましたが、省略しました` });
}

// ---------------------------------------------------------------------------------------------
// 名前

const BREAKS = /\r\n|[\r\n\u2028\u2029\u0085\v\f]/;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** 名前を単語に分ける (英数字以外は区切り。日本語など ASCII の識別子にできない文字は落ちる) */
const wordsOf = (name: string): string[] => name.split(/[^A-Za-z0-9]+/).filter(Boolean);

const isAllUpper = (w: string): boolean => /[A-Z]/.test(w) && !/[a-z]/.test(w);
const upperFirst = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
const lowerFirst = (w: string): string => w.charAt(0).toLowerCase() + w.slice(1);
const capWord = (w: string): string => upperFirst(isAllUpper(w) && w.length > 1 ? w.toLowerCase() : w);

/** 先頭を大文字にした PascalCase (order_items → OrderItems)。使える文字が無ければ空文字 */
export function pascalIdent(name: string): string {
  let s = wordsOf(name).map(capWord).join("");
  if (/^[0-9]/.test(s)) s = `Table${s}`;
  return s.slice(0, NAME_MAX_LENGTH - 10);
}

/** camelCase (created_at → createdAt)。使える文字が無ければ空文字 */
export function camelIdent(name: string): string {
  const ws = wordsOf(name);
  if (ws.length === 0) return "";
  const f = ws[0]!;
  const head = isAllUpper(f) ? f.toLowerCase() : /^[A-Z][^A-Z]/.test(f) || f.length === 1 ? lowerFirst(f) : f;
  let s = head + ws.slice(1).map(capWord).join("");
  if (/^[0-9]/.test(s)) s = `column${upperFirst(s)}`;
  return s.slice(0, NAME_MAX_LENGTH - 10);
}

const RESERVED_MODEL_NAMES: ReadonlySet<string> = new Set([...PRISMA_SCALAR_TYPES, "Unsupported", "PrismaClient", "Prisma"]);

/** used に無い名前にする (あれば末尾に 2, 3, … を付ける)。決めた名前を used に入れる */
function uniqueName(base: string, used: Set<string>): string {
  let name = base.slice(0, NAME_MAX_LENGTH - 10);
  for (let n = 2; used.has(name); n++) name = `${base.slice(0, NAME_MAX_LENGTH - 10)}${n}`;
  used.add(name);
  return name;
}

/** コメントを DSL の // の行にできる形にする (改行で行を分け、制御文字・向きを変える文字は空白にする) */
function commentLines(text: string): string[] {
  return truncateText(text, DESCRIPTION_MAX_LENGTH)
    .split(BREAKS)
    .map((l) => l.replace(BAD_CHARS, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l !== "")
    .slice(0, 30);
}

// ---------------------------------------------------------------------------------------------
// 計画 (名前・型・属性を決める)

interface EnumValuePlan {
  sql: string;
  name: string;
  map?: string;
}

interface EnumPlan {
  name: string;
  mapName?: string;
  values: EnumValuePlan[];
  /** 列から使われている (使われていない SQL の enum は、大きさに余裕があるときだけ出す) */
  used: boolean;
  def?: EnumDef;
}

interface FieldPlan {
  col: Col;
  name: string;
  mapName?: string;
  type: string;
  optional: boolean;
  list: boolean;
  isId: boolean;
  isUnique: boolean;
  defaultAttr?: string;
  updatedAt: boolean;
  native?: string;
  comment: string[];
  typeNote?: string;
}

interface RelPlan {
  child: ModelPlan;
  parent: ModelPlan;
  fields: FieldPlan[];
  refs: FieldPlan[];
  optional: boolean;
  oneToOne: boolean;
}

interface ModelPlan {
  table: Table;
  index: number;
  name: string;
  fields: FieldPlan[];
  byCol: Map<Col, FieldPlan>;
  blockAttrs: string[];
  comment: string[];
}

interface Plan {
  models: ModelPlan[];
  enums: EnumPlan[];
  rels: RelPlan[];
}

function enumValueName(v: string, used: Set<string>): { name: string; map?: string } {
  let name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? v : v.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (name === "") name = "VALUE";
  else if (/^[0-9]/.test(name)) name = `V${name}`;
  name = name.slice(0, 100);
  const base = name;
  for (let n = 2; used.has(name); n++) name = `${base}${n}`;
  used.add(name);
  return name === v ? { name } : { name, map: truncateText(v, NAME_MAX_LENGTH) };
}

function makeEnumPlan(name: string, values: readonly string[], def?: EnumDef): EnumPlan {
  const used = new Set<string>();
  const vs: EnumValuePlan[] = [];
  for (const sql of values.slice(0, MAX_ENUM_VALUES)) {
    const { name: n, map } = enumValueName(sql, used);
    vs.push({ sql, name: n, ...(map !== undefined ? { map } : {}) });
  }
  return { name, values: vs, used: false, ...(def ? { def } : {}) };
}

function addNote(cat: Catalog, table: Table, line: number | undefined, message: string): void {
  cat.note(table.file ? { file: table.file, dialect: "other", text: "" } : undefined, line, message);
}

/** 型の変換のあと、列の最終的な型・NULL 可・DEFAULT などを決める */
function planField(cat: Catalog, table: Table, model: string, col: Col, name: string, mapName: string | undefined, inPk: boolean, enumFor: (spec: NonNullable<Col["type"]>) => EnumPlan | undefined, inlineEnums: EnumPlan[], usedTypeNames: Set<string>): FieldPlan {
  let prisma: ScalarName | "enum" = "String";
  let type = "String";
  let native: string | undefined;
  let list = false;
  let typeNote: string | undefined;
  let enumPlan: EnumPlan | undefined;
  let spec = col.type;
  if (!spec) {
    typeNote = "型の指定なし";
    addNote(cat, table, col.line, `列 ${table.name}.${col.name} に型が書かれていないため、String にしました`);
  } else {
    list = spec.isArray;
    enumPlan = enumFor(spec);
    if (!enumPlan) spec = resolveDomain(cat, spec);
    if (!enumPlan) enumPlan = enumFor(spec);
    list = spec.isArray;
    if (!enumPlan && spec.base === "enum" && spec.strs.length > 0) {
      // MySQL の enum('a','b') の列。列ごとに enum を作る
      const e = makeEnumPlan(uniqueName(`${model}${upperFirst(name)}`, usedTypeNames), spec.strs);
      e.used = true;
      inlineEnums.push(e);
      enumPlan = e;
    }
    if (enumPlan) {
      enumPlan.used = true;
      prisma = "enum";
      type = enumPlan.name;
    } else {
      const m = mapScalar(spec.base, spec.nums, spec.unsigned, col.dialect);
      if (m) {
        prisma = m.prisma;
        type = m.prisma;
        native = m.native;
      } else {
        typeNote = `元の型: ${spec.raw}`;
        addNote(cat, table, col.line, `列 ${table.name}.${col.name} の型 ${spec.raw} は対応がないため、String にしました`);
      }
    }
  }
  // 連番・DEFAULT
  let defaultAttr: string | undefined;
  let updatedAt = false;
  const intLike = prisma === "Int" || prisma === "BigInt";
  let auto = col.autoInc || col.rowid;
  if (auto && (!intLike || list)) {
    addNote(cat, table, col.line, `列 ${table.name}.${col.name} は連番ですが、型が Int・BigInt ではないため @default(autoincrement()) を付けませんでした`);
    auto = false;
  }
  if (auto) defaultAttr = "@default(autoincrement())";
  else if (col.def) {
    const enumValues = enumPlan ? new Map(enumPlan.values.map((v) => [v.sql, v.name])) : undefined;
    const r = convertDefault(col.def.toks, col.def.text, { prisma, isList: list, ...(enumValues ? { enumValues } : {}) });
    if (r.kind === "attr") defaultAttr = r.attr;
    else if (r.kind === "auto") {
      if (intLike && !list) defaultAttr = "@default(autoincrement())";
      else addNote(cat, table, col.line, `列 ${table.name}.${col.name} の DEFAULT は連番ですが、型が Int・BigInt ではないため付けませんでした`);
    } else if (r.kind === "drop") addNote(cat, table, col.line, `列 ${table.name}.${col.name}: ${r.reason}。DEFAULT は付けませんでした`);
  }
  if (col.onUpdateNow && prisma === "DateTime") {
    updatedAt = true;
    if (defaultAttr === "@default(now())") defaultAttr = undefined;
  }
  const optional = !list && !(col.notNull || inPk || auto);
  const comment = col.comment ? commentLines(col.comment) : [];
  const f: FieldPlan = { col, name, type, optional, list, isId: false, isUnique: false, updatedAt, comment };
  if (mapName !== undefined) f.mapName = mapName;
  if (defaultAttr !== undefined) f.defaultAttr = defaultAttr;
  if (native !== undefined) f.native = native;
  if (typeNote !== undefined) f.typeNote = typeNote;
  return f;
}

function buildPlan(cat: Catalog, live: Table[]): Plan {
  const usedTypeNames = new Set<string>();
  // model の名前 (テーブルの出てきた順に決める)
  const models: ModelPlan[] = [];
  const names: string[] = [];
  live.forEach((t, i) => {
    let base = pascalIdent(t.name) || `Table${i + 1}`;
    if (RESERVED_MODEL_NAMES.has(base)) base = `${base}Table`;
    names.push(uniqueName(base, usedTypeNames));
  });
  // SQL の enum の名前
  const enums: EnumPlan[] = [];
  const enumByDef = new Map<EnumDef, EnumPlan>();
  for (const def of cat.enumsCreated) {
    if (def.dropped) continue;
    let base = pascalIdent(def.name) || `Enum${enums.length + 1}`;
    if (RESERVED_MODEL_NAMES.has(base)) base = `${base}Enum`;
    const name = uniqueName(base, usedTypeNames);
    const p = makeEnumPlan(name, def.values, def);
    if (def.name !== name) p.mapName = truncateText(def.name, NAME_MAX_LENGTH);
    enums.push(p);
    enumByDef.set(def, p);
  }
  const enumFor = (spec: NonNullable<Col["type"]>): EnumPlan | undefined => {
    const def = cat.findEnum(spec.schema ?? "", spec.base);
    return def && !def.dropped ? enumByDef.get(def) : undefined;
  };
  const inlineEnums: EnumPlan[] = [];
  live.forEach((t, i) => {
    const model = names[i]!;
    const usedFields = new Set<string>();
    const fields: FieldPlan[] = [];
    const byCol = new Map<Col, FieldPlan>();
    const pkCols = new Set(t.pk?.cols ?? []);
    t.cols.forEach((col, pos) => {
      const fname = uniqueName(camelIdent(col.name) || `column${pos + 1}`, usedFields);
      const mapName = fname === col.name ? undefined : truncateText(col.name, NAME_MAX_LENGTH);
      const f = planField(cat, t, model, col, fname, mapName, pkCols.has(col), enumFor, inlineEnums, usedTypeNames);
      fields.push(f);
      byCol.set(col, f);
    });
    // キー
    const blockAttrs: string[] = [];
    if (t.pk) {
      if (t.pk.cols.length === 1) byCol.get(t.pk.cols[0]!)!.isId = true;
      else if (t.pk.cols.length > 1) blockAttrs.push(`@@id([${t.pk.cols.map((c) => byCol.get(c)!.name).join(", ")}])`);
    } else if (t.cols.length > 0) addNote(cat, t, t.line, `テーブル ${t.name} に主キーがありません`);
    const seen = new Set<string>();
    if (t.pk) seen.add(keyId(t.pk.cols));
    for (const u of t.uniques) {
      const id = keyId(u.cols);
      if (seen.has(id)) continue;
      seen.add(id);
      if (u.cols.length === 1) byCol.get(u.cols[0]!)!.isUnique = true;
      else blockAttrs.push(`@@unique([${u.cols.map((c) => byCol.get(c)!.name).join(", ")}])`);
    }
    if (t.name !== model) blockAttrs.push(`@@map(${quoteDsl(truncateText(t.name, NAME_MAX_LENGTH))})`);
    models.push({ table: t, index: i, name: model, fields, byCol, blockAttrs, comment: t.comment ? commentLines(t.comment) : [] });
  });
  enums.push(...inlineEnums);
  // 外部キー → 関連
  const rels: RelPlan[] = [];
  const modelOf = new Map<Table, ModelPlan>(models.map((m) => [m.table, m]));
  const seenFk = new Set<string>();
  for (const child of models) {
    for (const fk of child.table.fks) {
      const where = `${child.table.name} の外部キー${fk.name ? ` ${fk.name}` : ""}`;
      const parent = fk.target ? modelOf.get(fk.target) : undefined;
      const cols = fk.cols.map((c) => child.byCol.get(c)).filter((f): f is FieldPlan => !!f);
      if (cols.length !== fk.cols.length || cols.length === 0) continue;
      if (!fk.target || !parent) {
        const note = `参照先: ${fk.refName}${fk.refColNames ? `(${fk.refColNames.join(", ")})` : ""}`;
        addNote(cat, child.table, fk.line, `${where}の参照先のテーブル ${fk.refName} が SQL にないため、関連にしませんでした。列だけを残します`);
        for (const f of cols) f.comment.push(note);
        continue;
      }
      const refCols = fk.refCols ?? (fk.refColNames === null ? fk.target.pk?.cols : undefined);
      if (!refCols) {
        addNote(cat, child.table, fk.line, fk.refColNames === null ? `${where}の参照先 ${fk.target.name} に主キーがないため、関連にしませんでした` : `${where}の参照先の列が ${fk.target.name} にないため、関連にしませんでした`);
        continue;
      }
      const refs = refCols.map((c) => parent.byCol.get(c)).filter((f): f is FieldPlan => !!f);
      if (refs.length !== refCols.length || refs.length !== cols.length) {
        addNote(cat, child.table, fk.line, `${where}の列の数と参照先の列の数が合わないため、関連にしませんでした`);
        continue;
      }
      const id = `${child.index}:${keyId(fk.cols)}:${parent.index}:${keyId(refCols)}`;
      if (seenFk.has(id)) continue;
      seenFk.add(id);
      const sameSet = (a: readonly Col[], b: readonly Col[]) => a.length === b.length && a.every((c) => b.includes(c));
      const oneToOne = (child.table.pk && sameSet(child.table.pk.cols, fk.cols)) || child.table.uniques.some((u) => sameSet(u.cols, fk.cols));
      rels.push({ child, parent, fields: cols, refs, optional: cols.some((f) => f.optional), oneToOne: !!oneToOne });
    }
  }
  return { models, enums, rels };
}

/** ドメイン (CREATE DOMAIN) は元の型にたどる。たどるのは数回まで */
function resolveDomain(cat: Catalog, spec: NonNullable<Col["type"]>): NonNullable<Col["type"]> {
  let s = spec;
  for (let i = 0; i < 4; i++) {
    const d = cat.findDomain(s.schema ?? "", s.base);
    if (!d) return s;
    s = { ...d, isArray: s.isArray || d.isArray, raw: spec.raw };
  }
  return s;
}

const keyId = (cols: readonly Col[]): string => cols.map((c) => c.name.toLowerCase()).join(",");

// ---------------------------------------------------------------------------------------------
// 出力

interface Line {
  name: string;
  type: string;
  attrs: string;
  trailing: string;
  above: string[];
}

function fieldLine(f: FieldPlan): Line {
  const attrs: string[] = [];
  if (f.isId) attrs.push("@id");
  if (f.defaultAttr) attrs.push(f.defaultAttr);
  if (f.isUnique) attrs.push("@unique");
  if (f.updatedAt) attrs.push("@updatedAt");
  if (f.mapName !== undefined) attrs.push(`@map(${quoteDsl(f.mapName)})`);
  if (f.native) attrs.push(f.native);
  const lines = [...f.comment];
  if (f.typeNote) {
    if (lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]} (${f.typeNote})`;
    else lines.push(f.typeNote);
  }
  const type = `${f.type}${f.list ? "[]" : ""}${f.optional ? "?" : ""}`;
  const single = lines.length === 1 && lines[0]!.length <= 100;
  return { name: f.name, type, attrs: attrs.join(" "), trailing: single ? lines[0]! : "", above: single ? [] : lines };
}

function emit(plan: Plan, k: number, withUnusedEnums: boolean): { dsl: string; enums: EnumPlan[]; tables: SqlImportTable[] } {
  const models = plan.models.slice(0, k);
  const usedEnums = new Set<EnumPlan>();
  // 出す関連 (両端が出すテーブルのもの) と、同じ 2 つのテーブルの間の数
  const rels = plan.rels.filter((r) => r.child.index < k && r.parent.index < k);
  const pairCount = new Map<string, number>();
  const pairKey = (r: RelPlan) => (r.child.index < r.parent.index ? `${r.child.index}:${r.parent.index}` : `${r.parent.index}:${r.child.index}`);
  for (const r of rels) pairCount.set(pairKey(r), (pairCount.get(pairKey(r)) ?? 0) + 1);
  const relLines = new Map<ModelPlan, Line[]>();
  const usedFieldNames = new Map<ModelPlan, Set<string>>(models.map((m) => [m, new Set(m.fields.map((f) => f.name))]));
  const usedRelNames = new Map<string, Set<string>>();
  const push = (m: ModelPlan, l: Line) => {
    const a = relLines.get(m);
    if (a) a.push(l);
    else relLines.set(m, [l]);
  };
  for (const r of rels) {
    const self = r.child === r.parent;
    const named = self || pairCount.get(pairKey(r))! > 1;
    let relName = "";
    if (named) {
      const used = usedRelNames.get(pairKey(r)) ?? new Set<string>();
      usedRelNames.set(pairKey(r), used);
      relName = uniqueName(`${r.child.name}_${r.fields.map((f) => f.name).join("_")}`, used);
    }
    // 外部キーの側の関連の名前: xxxId → xxx、ほかは参照先の model の名前
    const childUsed = usedFieldNames.get(r.child)!;
    let base = "";
    if (r.fields.length === 1) {
      const n = r.fields[0]!.name;
      const m = /^(.+?)(Id|ID|_id)$/.exec(n);
      if (m) base = m[1]!;
    }
    if (base === "") base = lowerFirst(r.parent.name);
    if (childUsed.has(base)) base = `${lowerFirst(r.parent.name)}${upperFirst(r.fields[0]!.name)}`;
    const childName = uniqueName(base, childUsed);
    const relArgs = `${relName ? `${quoteDsl(relName)}, ` : ""}fields: [${r.fields.map((f) => f.name).join(", ")}], references: [${r.refs.map((f) => f.name).join(", ")}]`;
    push(r.child, { name: childName, type: `${r.parent.name}${r.optional ? "?" : ""}`, attrs: `@relation(${relArgs})`, trailing: "", above: [] });
    // 参照される側: 子の model の名前 (1 対 1 なら ?、ほかは [])
    const parentUsed = usedFieldNames.get(r.parent)!;
    let pbase = lowerFirst(r.child.name);
    if (parentUsed.has(pbase)) pbase = `${pbase}By${upperFirst(childName)}`;
    const parentName = uniqueName(pbase, parentUsed);
    push(r.parent, { name: parentName, type: `${r.child.name}${r.oneToOne ? "?" : "[]"}`, attrs: relName ? `@relation(${quoteDsl(relName)})` : "", trailing: "", above: [] });
  }
  const blocks: string[] = [];
  const tables: SqlImportTable[] = [];
  const enumByName = new Map(plan.enums.map((e) => [e.name, e]));
  for (const m of models) {
    const lines = [...m.fields.map(fieldLine), ...(relLines.get(m) ?? [])];
    for (const f of m.fields) {
      const e = enumByName.get(f.type);
      if (e) usedEnums.add(e);
    }
    const w1 = Math.max(0, ...lines.map((l) => l.name.length));
    const w2 = Math.max(0, ...lines.map((l) => l.type.length));
    const out: string[] = [];
    for (const c of m.comment) out.push(`// ${c}`);
    out.push(`model ${m.name} {`);
    for (const l of lines) {
      for (const a of l.above) out.push(`  // ${a}`);
      const body = `  ${l.name.padEnd(w1)} ${l.attrs === "" && l.trailing === "" ? l.type : l.type.padEnd(w2)}${l.attrs === "" ? "" : ` ${l.attrs}`}`;
      out.push(l.trailing === "" ? body.trimEnd() : `${body} // ${l.trailing}`);
    }
    for (const a of m.blockAttrs) out.push(`  ${a}`);
    out.push("}");
    blocks.push(out.join("\n"));
    tables.push({ table: truncateText(m.table.name, NAME_MAX_LENGTH), model: m.name, columns: m.fields.length });
  }
  const enums = plan.enums.filter((e) => usedEnums.has(e) || (withUnusedEnums && e.def !== undefined));
  const enumBlocks = enums.map((e) => {
    const out = [`enum ${e.name} {`];
    for (const v of e.values) out.push(`  ${v.name}${v.map !== undefined ? ` @map(${quoteDsl(v.map)})` : ""}`);
    if (e.mapName !== undefined) out.push(`  @@map(${quoteDsl(e.mapName)})`);
    out.push("}");
    return out.join("\n");
  });
  const all = [...enumBlocks, ...blocks];
  return { dsl: all.length === 0 ? "" : `${all.join("\n\n")}\n`, enums, tables };
}

function generate(cat: Catalog, live: Table[]): { dsl: string; tables: SqlImportTable[]; enums: string[] } {
  if (live.length === 0) return { dsl: "", tables: [], enums: [] };
  const plan = buildPlan(cat, live);
  const max = SQL_IMPORT_LIMITS.maxDslChars;
  let k = plan.models.length;
  let r = emit(plan, k, false);
  if (r.dsl.length > max) {
    // 上限に収まる最大のテーブル数を二分探索で探す
    let lo = 0;
    let hi = k - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (emit(plan, mid, false).dsl.length <= max) lo = mid;
      else hi = mid - 1;
    }
    k = lo;
    r = emit(plan, k, false);
    if (r.dsl.length > max) {
      cat.note(undefined, undefined, `生成した DSL が上限 (${max} 文字) を超えるため、出力できませんでした`);
      return { dsl: "", tables: [], enums: [] };
    }
    const omitted = plan.models.slice(k).map((m) => m.table.name);
    cat.note(undefined, undefined, `生成した DSL が上限 (${max} 文字) を超えるため、後ろの ${omitted.length} 個のテーブル (${omitted.slice(0, 3).join("、")}${omitted.length > 3 ? " など" : ""}) を出しませんでした`);
  } else {
    const withAll = emit(plan, k, true);
    if (withAll.dsl.length <= max) r = withAll;
  }
  return { dsl: r.dsl, tables: r.tables, enums: r.enums.map((e) => e.name) };
}
