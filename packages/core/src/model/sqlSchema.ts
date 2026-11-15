// SQL の文を読んで、テーブル・列・制約・enum の「いまの形」(カタログ) に当てていく (sqlImport.ts の下請け)。
// CREATE TABLE のあとの ALTER TABLE / DROP TABLE / RENAME などを順に当てて最後の形を作る。純粋関数だけを置く。
// 文の切り出しは sqlLex.ts。ここは切り出したトークンを読む。例外は投げない (読めない文は notes に残して飛ばす)。
import { type Dialect, type Statement, type Tok } from "./sqlLex";
import { SERIAL_BASE } from "./sqlTypes";

/** 読む量の上限 */
export const MAX_TABLES = 5000;
export const MAX_COLUMNS_PER_TABLE = 1000;
export const MAX_ENUMS = 5000;
export const MAX_ENUM_VALUES = 1000;
export const MAX_NOTES = 300;
/** 中身を読む文 (CREATE・ALTER・DROP・COMMENT・RENAME) の数の上限 */
export const MAX_DDL_STATEMENTS = 200_000;

export interface TypeSpec {
  /** 小文字・単語は空白 1 つでつなぐ (例: `character varying`・`timestamp with time zone`)。スキーマ名は含まない */
  base: string;
  schema?: string;
  nums: number[];
  strs: string[];
  isArray: boolean;
  unsigned: boolean;
  /** もとの書き方 (コメントや notes に出す) */
  raw: string;
}

export interface DefaultExpr {
  toks: Tok[];
  text: string;
}

export interface Col {
  name: string;
  /** 型が書かれていなければ null (SQLite) */
  type: TypeSpec | null;
  notNull: boolean;
  autoInc: boolean;
  /** SQLite の INTEGER PRIMARY KEY (rowid の別名) */
  rowid: boolean;
  def?: DefaultExpr;
  onUpdateNow: boolean;
  comment?: string;
  line: number;
  dialect: Dialect;
  dropped: boolean;
}

export interface KeyDef {
  cols: Col[];
  name?: string;
  line: number;
}

export interface FkDef {
  cols: Col[];
  name?: string;
  line: number;
  refSchema: string;
  refName: string;
  target?: Table;
  refCols?: Col[];
  refColNames: string[] | null;
}

export interface Table {
  schema: string;
  name: string;
  cols: Col[];
  colMap: Map<string, Col>;
  pk?: KeyDef;
  uniques: KeyDef[];
  fks: FkDef[];
  comment?: string;
  line: number;
  file?: string;
  dropped: boolean;
  dialect: Dialect;
}

export interface EnumDef {
  schema: string;
  name: string;
  values: string[];
  comment?: string;
  line: number;
  dropped: boolean;
}

export interface Note {
  file?: string;
  line?: number;
  message: string;
}

export interface Ctx {
  file?: string;
  dialect: Dialect;
  text: string;
}

const DEFAULT_SCHEMAS = new Set(["public", "dbo", "main", "default"]);
const normSchema = (s: string): string => (DEFAULT_SCHEMAS.has(s.toLowerCase()) ? "" : s);
const tableKey = (schema: string, name: string): string => `${normSchema(schema).toLowerCase()}\u0000${name.toLowerCase()}`;
const colKey = (name: string): string => name.toLowerCase();

export class Catalog {
  tables = new Map<string, Table>();
  /** 作った順 (消したものも含む。dropped で見分ける) */
  created: Table[] = [];
  enums = new Map<string, EnumDef>();
  enumsCreated: EnumDef[] = [];
  domains = new Map<string, TypeSpec>();
  keyNames = new Map<string, { table: Table; key: KeyDef }[]>();
  notes: Note[] = [];
  omittedNotes = 0;
  skipped = new Map<string, number>();
  dataSkipped = new Map<string, number>();
  ddlStatements = 0;
  tableLimitHit = false;
  columnLimitTables = new Set<string>();

  note(ctx: Ctx | undefined, line: number | undefined, message: string): void {
    if (this.notes.length >= MAX_NOTES) {
      this.omittedNotes++;
      return;
    }
    const n: Note = { message };
    if (ctx?.file) n.file = ctx.file;
    if (line !== undefined) n.line = line;
    this.notes.push(n);
  }

  skip(label: string): void {
    if (!this.skipped.has(label) && this.skipped.size >= 60) label = "そのほか";
    this.skipped.set(label, (this.skipped.get(label) ?? 0) + 1);
  }

  skipData(label: string): void {
    if (!this.dataSkipped.has(label) && this.dataSkipped.size >= 20) label = "そのほか";
    this.dataSkipped.set(label, (this.dataSkipped.get(label) ?? 0) + 1);
  }

  /** 名前 (小文字) だけで引く表。スキーマ名なしの参照を、同じ名前が 1 つだけのときに結ぶため */
  private bareTables = new Map<string, Table[]>();
  private bareEnums = new Map<string, EnumDef[]>();

  private static addBare<T>(m: Map<string, T[]>, k: string, v: T): void {
    const a = m.get(k);
    if (a) a.push(v);
    else m.set(k, [v]);
  }

  private static delBare<T>(m: Map<string, T[]>, k: string, v: T): void {
    const a = m.get(k);
    if (!a) return;
    const i = a.indexOf(v);
    if (i >= 0) a.splice(i, 1);
    if (a.length === 0) m.delete(k);
  }

  registerTable(t: Table): void {
    this.created.push(t);
    this.tables.set(tableKey(t.schema, t.name), t);
    Catalog.addBare(this.bareTables, t.name.toLowerCase(), t);
  }

  findTable(schema: string, name: string, fromSchema = ""): Table | undefined {
    const exact = this.tables.get(tableKey(schema, name));
    if (exact) return exact;
    if (schema === "") {
      const same = fromSchema !== "" ? this.tables.get(tableKey(fromSchema, name)) : undefined;
      if (same) return same;
      // スキーマ名なしで書かれていて、同じ名前のテーブルが 1 つだけならそれ
      const list = this.bareTables.get(name.toLowerCase());
      return list && list.length === 1 ? list[0] : undefined;
    }
    return undefined;
  }

  setEnum(def: EnumDef): void {
    const old = this.enums.get(tableKey(def.schema, def.name));
    if (old) this.removeEnum(old);
    this.enums.set(tableKey(def.schema, def.name), def);
    this.enumsCreated.push(def);
    Catalog.addBare(this.bareEnums, def.name.toLowerCase(), def);
  }

  removeEnum(e: EnumDef): void {
    e.dropped = true;
    const k = tableKey(e.schema, e.name);
    if (this.enums.get(k) === e) this.enums.delete(k);
    Catalog.delBare(this.bareEnums, e.name.toLowerCase(), e);
  }

  renameEnum(e: EnumDef, name: string): void {
    const k = tableKey(e.schema, e.name);
    if (this.enums.get(k) === e) this.enums.delete(k);
    Catalog.delBare(this.bareEnums, e.name.toLowerCase(), e);
    e.name = name;
    this.enums.set(tableKey(e.schema, e.name), e);
    Catalog.addBare(this.bareEnums, e.name.toLowerCase(), e);
  }

  findEnum(schema: string, name: string): EnumDef | undefined {
    const e = this.enums.get(tableKey(schema, name));
    if (e) return e;
    if (schema === "") {
      const list = this.bareEnums.get(name.toLowerCase());
      return list && list.length === 1 ? list[0] : undefined;
    }
    return undefined;
  }

  findDomain(schema: string, name: string): TypeSpec | undefined {
    return this.domains.get(tableKey(schema, name)) ?? this.domains.get(tableKey("", name));
  }

  liveTables(): Table[] {
    return this.created.filter((t) => !t.dropped);
  }

  dropTable(t: Table): void {
    t.dropped = true;
    const k = tableKey(t.schema, t.name);
    if (this.tables.get(k) === t) this.tables.delete(k);
    Catalog.delBare(this.bareTables, t.name.toLowerCase(), t);
  }

  renameTable(t: Table, schema: string, name: string): void {
    const old = tableKey(t.schema, t.name);
    if (this.tables.get(old) === t) this.tables.delete(old);
    Catalog.delBare(this.bareTables, t.name.toLowerCase(), t);
    const existing = this.tables.get(tableKey(schema, name));
    if (existing && existing !== t) this.dropTable(existing);
    t.schema = normSchema(schema);
    t.name = name;
    this.tables.set(tableKey(schema, name), t);
    Catalog.addBare(this.bareTables, name.toLowerCase(), t);
  }

  registerKeyName(table: Table, key: KeyDef): void {
    if (!key.name) return;
    const k = key.name.toLowerCase();
    const list = this.keyNames.get(k);
    if (list) list.push({ table, key });
    else this.keyNames.set(k, [{ table, key }]);
  }
}

// ---------------------------------------------------------------------------------------------
// トークンの読み取り

class Cur {
  i: number;
  constructor(
    readonly t: readonly Tok[],
    i: number,
    readonly end: number,
    readonly text: string,
  ) {
    this.i = i;
  }
  peek(o = 0): Tok | undefined {
    const x = this.i + o;
    return x < this.end ? this.t[x] : undefined;
  }
  next(): Tok | undefined {
    return this.i < this.end ? this.t[this.i++] : undefined;
  }
  get done(): boolean {
    return this.i >= this.end;
  }
  kw(u: string, o = 0): boolean {
    const t = this.peek(o);
    return !!t && t.k === "w" && t.u === u;
  }
  sym(v: string, o = 0): boolean {
    const t = this.peek(o);
    return !!t && t.k === "p" && t.v === v;
  }
  /** 単語を順に読む。すべて合えば進めて true */
  eat(...us: string[]): boolean {
    for (let n = 0; n < us.length; n++) if (!this.kw(us[n]!, n)) return false;
    this.i += us.length;
    return true;
  }
  eatSym(v: string): boolean {
    if (!this.sym(v)) return false;
    this.i++;
    return true;
  }
}

const isIdentTok = (t: Tok | undefined): t is Tok => !!t && (t.k === "w" || t.k === "q" || (t.k === "s" && t.d === '"' && t.pre === undefined));

/** 名前 (a.b.c)。最大 4 つまで */
function readNameParts(c: Cur): { parts: string[]; line: number } | null {
  const f = c.peek();
  if (!isIdentTok(f)) return null;
  const parts = [c.next()!.v];
  while (c.sym(".") && isIdentTok(c.peek(1)) && parts.length < 4) {
    c.i++;
    parts.push(c.next()!.v);
  }
  return { parts, line: f.line };
}

function readTableName(c: Cur): { schema: string; name: string; line: number } | null {
  const n = readNameParts(c);
  if (!n) return null;
  const name = n.parts[n.parts.length - 1]!;
  const schema = n.parts.length >= 2 ? n.parts[n.parts.length - 2]! : "";
  return { schema: normSchema(schema), name, line: n.line };
}

/** c.i が ( のとき、対応する ) の次へ進める (閉じていなければ終わりまで)。中のトークンを返す */
function readGroup(c: Cur): Tok[] {
  const inner: Tok[] = [];
  if (!c.sym("(")) return inner;
  let depth = 0;
  while (!c.done) {
    const t = c.next()!;
    if (t.k === "p" && t.v === "(") {
      depth++;
      if (depth === 1) continue;
    } else if (t.k === "p" && t.v === ")") {
      depth--;
      if (depth === 0) break;
    }
    inner.push(t);
  }
  return inner;
}

function skipGroup(c: Cur): void {
  readGroup(c);
}

/** [from, to) をかっこの外のカンマで区切った範囲 */
function splitTop(t: readonly Tok[], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const x = t[i]!;
    if (x.k !== "p") continue;
    if (x.v === "(") depth++;
    else if (x.v === ")") depth = Math.max(0, depth - 1);
    else if (x.v === "," && depth === 0) {
      if (i > start) out.push([start, i]);
      start = i + 1;
    }
  }
  if (to > start) out.push([start, to]);
  return out;
}

/** t[open] の ( に対応する ) の位置 (無ければ -1) */
function matchClose(t: readonly Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const x = t[i]!;
    if (x.k !== "p") continue;
    if (x.v === "(") depth++;
    else if (x.v === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const TYPE_STOP = new Set(["NOT", "NULL", "DEFAULT", "PRIMARY", "UNIQUE", "REFERENCES", "CHECK", "CONSTRAINT", "COLLATE", "GENERATED", "AUTOINCREMENT", "AUTO_INCREMENT", "COMMENT", "AS", "ON", "IDENTITY", "KEY", "CHARACTER", "CHARSET"]);

/** 型を読む。型が無ければ null */
function readType(c: Cur): TypeSpec | null {
  const f = c.peek();
  if (!isIdentTok(f)) return null;
  if (f.k === "w" && TYPE_STOP.has(f.u) && f.u !== "CHARACTER") return null;
  const startTok = f;
  c.i++;
  let schema: string | undefined;
  let words = [f.v.toLowerCase()];
  while (c.sym(".") && isIdentTok(c.peek(1))) {
    schema = words[0];
    c.i++;
    words = [c.next()!.v.toLowerCase()];
  }
  const nums: number[] = [];
  const strs: string[] = [];
  let isArray = false;
  let unsigned = false;
  let lastTok: Tok = startTok;
  for (;;) {
    const t = c.peek();
    if (!t) break;
    if (t.k === "w") {
      const last = words[words.length - 1]!;
      const u = t.u;
      if (u === "UNSIGNED") unsigned = true;
      else if (u === "SIGNED" || u === "ZEROFILL") {
        /* 読み飛ばす */
      } else if (u === "ARRAY") isArray = true;
      else if (u === "PRECISION" && last === "double") words.push("precision");
      else if (u === "VARYING" && (last === "character" || last === "char" || last === "bit" || last === "national character")) words.push("varying");
      else if ((u === "WITH" || u === "WITHOUT") && (last === "timestamp" || last === "time") && c.kw("TIME", 1)) words.push(u.toLowerCase());
      else if (u === "TIME" && (last === "with" || last === "without")) words.push("time");
      else if (u === "ZONE" && last === "time") words.push("zone");
      else if (u === "LOCAL" && (last === "with" || last === "without")) words.push("local");
      else if ((u === "CHARACTER" || u === "CHAR" || u === "VARCHAR") && last === "national") words.push(u.toLowerCase());
      else break;
      c.i++;
      lastTok = t;
      continue;
    }
    if (t.k === "p" && t.v === "(") {
      const inner = readGroup(c);
      for (const x of inner) {
        if (x.k === "n" && /^\d{1,9}$/.test(x.v)) nums.push(Number(x.v));
        else if (x.k === "s") strs.push(x.v);
      }
      lastTok = c.t[c.i - 1] ?? lastTok;
      continue;
    }
    if (t.k === "p" && t.v === "[") {
      isArray = true;
      c.i++;
      while (!c.done && !c.sym("]")) c.i++;
      if (c.sym("]")) c.i++;
      lastTok = c.t[c.i - 1] ?? lastTok;
      continue;
    }
    break;
  }
  let base = words.join(" ");
  const rawEnd = lastTok.e;
  const spec: TypeSpec = { base, nums: nums.slice(0, 8), strs: strs.slice(0, MAX_ENUM_VALUES), isArray, unsigned, raw: c.text.slice(startTok.s, Math.min(rawEnd, startTok.s + 200)).replace(/\s+/g, " ") };
  if (schema !== undefined) spec.schema = schema;
  const serial = SERIAL_BASE[base];
  if (serial !== undefined) {
    base = serial;
    spec.base = serial;
  }
  return spec;
}

function typeIsSerial(c: Cur, from: number): boolean {
  const t = c.t[from];
  return !!t && t.k === "w" && t.v.toLowerCase() in SERIAL_BASE;
}

/** ( 列, 列 ) の列の一覧。式 (関数) を含めば null */
function readColList(c: Cur): string[] | null {
  if (!c.sym("(")) return null;
  const inner = readGroup(c);
  const names: string[] = [];
  let ok = true;
  let i = 0;
  while (i < inner.length) {
    const t = inner[i]!;
    if (!isIdentTok(t)) {
      ok = false;
      // 次のカンマまで進める
    } else {
      names.push(t.v);
      i++;
      // 接頭辞の長さ col(10)
      if (inner[i]?.k === "p" && inner[i]!.v === "(") {
        let d = 0;
        let j = i;
        let numeric = true;
        for (; j < inner.length; j++) {
          const x = inner[j]!;
          if (x.k === "p" && x.v === "(") d++;
          else if (x.k === "p" && x.v === ")") {
            d--;
            if (d === 0) break;
          } else if (x.k !== "n") numeric = false;
        }
        if (!numeric) ok = false;
        i = j + 1;
      }
    }
    // ASC / DESC / COLLATE x / NULLS FIRST などを次のカンマまで飛ばす
    let depth = 0;
    while (i < inner.length) {
      const x = inner[i]!;
      if (x.k === "p" && x.v === "(") depth++;
      else if (x.k === "p" && x.v === ")") depth--;
      else if (x.k === "p" && x.v === "," && depth === 0) {
        i++;
        break;
      }
      i++;
    }
    if (names.length > MAX_COLUMNS_PER_TABLE) break;
  }
  return ok && names.length > 0 ? names : null;
}

// ---------------------------------------------------------------------------------------------
// 列と制約

interface ColumnResult {
  col: Col;
  inlinePk: boolean;
  inlineUnique: boolean;
  inlineRef?: { schema: string; name: string; cols: string[] | null; line: number };
  constraintName?: string;
  position?: { first?: boolean; after?: string };
}

const DEFAULT_STOP = new Set(["NOT", "NULL", "PRIMARY", "UNIQUE", "REFERENCES", "CHECK", "CONSTRAINT", "COLLATE", "GENERATED", "AUTO_INCREMENT", "AUTOINCREMENT", "COMMENT", "ON", "CHARACTER", "CHARSET", "KEY", "AS", "VISIBLE", "INVISIBLE", "FIRST", "AFTER", "STORAGE", "COLUMN_FORMAT", "IDENTITY"]);

function parseColumn(cat: Catalog, c: Cur, ctx: Ctx, nameTok: Tok): ColumnResult {
  const startIdx = c.i;
  const type = readType(c);
  const col: Col = { name: nameTok.v, type, notNull: false, autoInc: false, rowid: false, onUpdateNow: false, line: nameTok.line, dialect: ctx.dialect, dropped: false };
  if (typeIsSerial(c, startIdx)) col.autoInc = true;
  const res: ColumnResult = { col, inlinePk: false, inlineUnique: false };
  let pendingName: string | undefined;
  while (!c.done) {
    const t = c.peek()!;
    if (t.k !== "w") {
      c.i++;
      if (t.k === "p" && t.v === "(") {
        c.i--;
        skipGroup(c);
      }
      continue;
    }
    const u = t.u;
    if (u === "CONSTRAINT") {
      c.i++;
      const n = c.peek();
      if (isIdentTok(n) && !(n.k === "w" && ["PRIMARY", "UNIQUE", "NOT", "NULL", "CHECK", "REFERENCES", "DEFAULT"].includes(n.u))) pendingName = c.next()!.v;
      continue;
    }
    if (u === "NOT" && c.kw("NULL", 1)) {
      c.i += 2;
      col.notNull = true;
    } else if (u === "NULL") {
      c.i++;
    } else if (u === "DEFAULT") {
      c.i++;
      const toks: Tok[] = [];
      let depth = 0;
      if (c.kw("NULL")) {
        c.i++;
        col.def = undefined;
        continue;
      }
      while (!c.done) {
        const x = c.peek()!;
        if (depth === 0 && x.k === "w" && DEFAULT_STOP.has(x.u)) break;
        if (x.k === "p" && (x.v === "(" || x.v === "[")) depth++;
        else if (x.k === "p" && (x.v === ")" || x.v === "]")) depth = Math.max(0, depth - 1);
        toks.push(x);
        c.i++;
      }
      col.def = toks.length > 0 ? { toks, text: ctx.text } : undefined;
    } else if (u === "PRIMARY") {
      c.i++;
      c.eat("KEY");
      res.inlinePk = true;
      if (pendingName) res.constraintName = pendingName;
      pendingName = undefined;
      // ASC / DESC / AUTOINCREMENT / ON CONFLICT … は次の周で読む
    } else if (u === "UNIQUE") {
      c.i++;
      c.eat("KEY");
      res.inlineUnique = true;
      if (pendingName) res.constraintName = pendingName;
      pendingName = undefined;
    } else if (u === "KEY") {
      // MySQL の列の KEY は PRIMARY KEY の略
      c.i++;
      res.inlinePk = true;
    } else if (u === "REFERENCES") {
      c.i++;
      const ref = readTableName(c);
      if (ref) {
        let cols: string[] | null = null;
        if (c.sym("(")) cols = readColList(c);
        res.inlineRef = { schema: ref.schema, name: ref.name, cols, line: t.line };
        if (pendingName) res.constraintName = pendingName;
      }
      pendingName = undefined;
    } else if (u === "CHECK") {
      c.i++;
      cat.skip("CHECK 制約");
      if (c.sym("(")) skipGroup(c);
    } else if (u === "COLLATE") {
      c.i++;
      if (c.peek() && c.peek()!.k !== "p") c.i++;
    } else if (u === "CHARACTER" || u === "CHAR") {
      c.i++;
      if (c.kw("SET")) c.i++;
      if (c.sym("=")) c.i++;
      if (c.peek() && c.peek()!.k !== "p") c.i++;
    } else if (u === "CHARSET") {
      c.i++;
      if (c.sym("=")) c.i++;
      if (c.peek() && c.peek()!.k !== "p") c.i++;
    } else if (u === "GENERATED") {
      c.i++;
      if (c.eat("ALWAYS") || c.eat("BY", "DEFAULT")) {
        if (c.kw("AS") && c.kw("IDENTITY", 1)) {
          c.i += 2;
          col.autoInc = true;
          if (c.sym("(")) skipGroup(c);
        } else if (c.kw("AS")) {
          c.i++;
          if (c.sym("(")) skipGroup(c);
          if (c.kw("STORED") || c.kw("VIRTUAL")) c.i++;
        }
      }
    } else if (u === "AS") {
      c.i++;
      if (c.sym("(")) skipGroup(c);
      if (c.kw("STORED") || c.kw("VIRTUAL") || c.kw("PERSISTENT")) c.i++;
    } else if (u === "IDENTITY") {
      c.i++;
      col.autoInc = true;
      if (c.sym("(")) skipGroup(c);
    } else if (u === "AUTO_INCREMENT" || u === "AUTOINCREMENT") {
      c.i++;
      col.autoInc = true;
    } else if (u === "COMMENT") {
      c.i++;
      c.eatSym("=");
      const s = c.peek();
      if (s && s.k === "s") {
        col.comment = s.v;
        c.i++;
      }
    } else if (u === "ON") {
      c.i++;
      if (c.kw("UPDATE")) {
        c.i++;
        const f = c.peek();
        if (f && f.k === "w") {
          if (/^(CURRENT_TIMESTAMP|NOW|LOCALTIME|LOCALTIMESTAMP)$/.test(f.u)) col.onUpdateNow = true;
          c.i++;
          if (c.sym("(")) skipGroup(c);
        }
      } else if (c.kw("DELETE") || c.kw("CONFLICT")) {
        c.i++;
        while (!c.done && c.peek()!.k === "w") c.i++;
      }
    } else if (u === "FIRST") {
      c.i++;
      res.position = { first: true };
    } else if (u === "AFTER") {
      c.i++;
      const n = c.peek();
      if (isIdentTok(n)) {
        res.position = { after: n.v };
        c.i++;
      }
    } else if (u === "AUTOINCREMENT") {
      c.i++;
    } else {
      c.i++;
      if (c.sym("(")) skipGroup(c);
    }
  }
  if (res.constraintName === undefined && pendingName) res.constraintName = pendingName;
  return res;
}

function addColumn(cat: Catalog, table: Table, res: ColumnResult, ctx: Ctx): Col | null {
  const key = colKey(res.col.name);
  if (table.colMap.has(key)) {
    cat.note(ctx, res.col.line, `テーブル ${table.name} に同じ名前の列 ${res.col.name} が 2 回あります。あとのものは読み飛ばしました`);
    return null;
  }
  if (table.cols.length >= MAX_COLUMNS_PER_TABLE) {
    const k = tableKey(table.schema, table.name);
    if (!cat.columnLimitTables.has(k)) {
      cat.columnLimitTables.add(k);
      cat.note(ctx, res.col.line, `テーブル ${table.name} の列が上限 (${MAX_COLUMNS_PER_TABLE}) を超えたため、以降の列を読みませんでした`);
    }
    return null;
  }
  const col = res.col;
  if (res.position?.first) table.cols.unshift(col);
  else if (res.position?.after) {
    const at = table.cols.findIndex((x) => colKey(x.name) === colKey(res.position!.after!));
    if (at >= 0) table.cols.splice(at + 1, 0, col);
    else table.cols.push(col);
  } else table.cols.push(col);
  table.colMap.set(key, col);
  attachInline(cat, table, res, ctx);
  return col;
}

function attachInline(cat: Catalog, table: Table, res: ColumnResult, ctx: Ctx): void {
  const col = res.col;
  if (res.inlinePk) {
    if (table.pk) cat.note(ctx, col.line, `テーブル ${table.name} の主キーが重ねて書かれています。あとのもので置き換えました`);
    table.pk = { cols: [col], line: col.line, ...(res.constraintName ? { name: res.constraintName } : {}) };
    if (ctx.dialect === "sqlite" && col.type?.base === "integer" && !col.type.isArray) col.rowid = true;
  }
  if (res.inlineUnique) {
    const key: KeyDef = { cols: [col], line: col.line, ...(res.constraintName ? { name: res.constraintName } : {}) };
    table.uniques.push(key);
    cat.registerKeyName(table, key);
  }
  if (res.inlineRef) {
    const r = res.inlineRef;
    pushFk(cat, table, { cols: [col], line: r.line, ...(res.constraintName ? { name: res.constraintName } : {}), refSchema: r.schema, refName: r.name, refColNames: r.cols });
  }
}

function pushFk(cat: Catalog, table: Table, fk: FkDef): void {
  const target = cat.findTable(fk.refSchema, fk.refName, table.schema);
  if (target) {
    fk.target = target;
    resolveRefCols(fk);
  }
  table.fks.push(fk);
}

function resolveRefCols(fk: FkDef): void {
  const t = fk.target;
  if (!t || fk.refCols) return;
  if (fk.refColNames === null) return;
  const cols: Col[] = [];
  for (const n of fk.refColNames) {
    const c = t.colMap.get(colKey(n));
    if (!c) return;
    cols.push(c);
  }
  fk.refCols = cols;
}

function resolveCols(cat: Catalog, table: Table, names: string[] | null, ctx: Ctx, line: number, what: string): Col[] | null {
  if (!names) {
    cat.note(ctx, line, `${table.name} の ${what} は、式を含むため読み飛ばしました`);
    return null;
  }
  const cols: Col[] = [];
  for (const n of names) {
    const c = table.colMap.get(colKey(n));
    if (!c) {
      cat.note(ctx, line, `${table.name} の ${what} が、存在しない列 ${n} を指しているため読み飛ばしました`);
      return null;
    }
    cols.push(c);
  }
  return cols;
}

const CONSTRAINT_KW = new Set(["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "EXCLUDE"]);

/** CREATE TABLE の中の 1 項目 (列か制約)、または ALTER TABLE ADD の 1 項目 */
function parseTableItem(cat: Catalog, table: Table, c: Cur, ctx: Ctx, forceColumn = false): void {
  const f = c.peek();
  if (!f) return;
  let cname: string | undefined;
  if (!forceColumn && f.k === "w" && f.u === "CONSTRAINT") {
    c.i++;
    const n = c.peek();
    if (isIdentTok(n) && !(n.k === "w" && CONSTRAINT_KW.has(n.u))) {
      cname = n.v;
      c.i++;
    }
  }
  const k = c.peek();
  if (!k) return;
  const line = k.line;
  if (!forceColumn && k.k === "w") {
    if (k.u === "PRIMARY" && c.kw("KEY", 1)) {
      c.i += 2;
      c.eat("CLUSTERED");
      const names = readColList(c);
      const cols = resolveCols(cat, table, names, ctx, line, "主キー");
      if (cols) {
        if (table.pk) cat.note(ctx, line, `テーブル ${table.name} の主キーが重ねて書かれています。あとのもので置き換えました`);
        table.pk = { cols, line, ...(cname ? { name: cname } : {}) };
        if (cols.length === 1 && ctx.dialect === "sqlite" && cols[0]!.type?.base === "integer" && !cols[0]!.type.isArray) cols[0]!.rowid = true;
      }
      return;
    }
    if (k.u === "UNIQUE" || (cname !== undefined && k.u === "UNIQUE")) {
      // UNIQUE [KEY|INDEX] [名前] ( … )
      let o = 1;
      if (c.kw("KEY", o) || c.kw("INDEX", o)) o++;
      let name: string | undefined;
      if (isIdentTok(c.peek(o)) && c.sym("(", o + 1)) {
        name = c.peek(o)!.v;
        o++;
      }
      if (c.sym("(", o)) {
        c.i += o;
        const names = readColList(c);
        const cols = resolveCols(cat, table, names, ctx, line, "一意制約");
        if (cols) {
          const key: KeyDef = { cols, line, ...(cname ?? name ? { name: (cname ?? name)! } : {}) };
          table.uniques.push(key);
          cat.registerKeyName(table, key);
        }
        return;
      }
    }
    if (k.u === "FOREIGN" && c.kw("KEY", 1)) {
      c.i += 2;
      let name = cname;
      if (isIdentTok(c.peek()) && c.sym("(", 1)) name = c.next()!.v;
      const names = readColList(c);
      if (!c.eat("REFERENCES")) {
        cat.note(ctx, line, `${table.name} の外部キーに REFERENCES がないため読み飛ばしました`);
        return;
      }
      const ref = readTableName(c);
      if (!ref) {
        cat.note(ctx, line, `${table.name} の外部キーの参照先が読めないため読み飛ばしました`);
        return;
      }
      let refNames: string[] | null = null;
      if (c.sym("(")) {
        refNames = readColList(c);
        if (refNames === null) {
          cat.note(ctx, line, `${table.name} の外部キーの参照先の列を読めないため読み飛ばしました`);
          return;
        }
      }
      const cols = resolveCols(cat, table, names, ctx, line, "外部キー");
      if (cols) {
        if (refNames && refNames.length !== cols.length) {
          cat.note(ctx, line, `${table.name} の外部キーの列の数と参照先の列の数が合わないため読み飛ばしました`);
          return;
        }
        pushFk(cat, table, { cols, line, ...(name ? { name } : {}), refSchema: ref.schema, refName: ref.name, refColNames: refNames });
      }
      return;
    }
    if (k.u === "CHECK" || k.u === "EXCLUDE" || k.u === "PERIOD" || (k.u === "LIKE" && !forceColumn)) {
      cat.skip(k.u === "CHECK" ? "CHECK 制約" : `${k.u} (制約)`);
      return;
    }
    if (k.u === "FULLTEXT" || k.u === "SPATIAL" || ((k.u === "KEY" || k.u === "INDEX") && (c.sym("(", 1) || (isIdentTok(c.peek(1)) && c.sym("(", 2))))) {
      cat.skip("KEY / INDEX (一意でないインデックス)");
      return;
    }
  }
  if (cname !== undefined) {
    // CONSTRAINT 名 のあとが制約ではない
    cat.skip("読めない制約");
    return;
  }
  // 列
  if (!isIdentTok(k)) {
    cat.skip("読めない項目");
    return;
  }
  c.i++;
  const res = parseColumn(cat, c, ctx, k);
  addColumn(cat, table, res, ctx);
}

// ---------------------------------------------------------------------------------------------
// 文の種類ごと

const OBJECTS = new Set(["TABLE", "INDEX", "VIEW", "TYPE", "DOMAIN", "SEQUENCE", "FUNCTION", "PROCEDURE", "TRIGGER", "EVENT", "SCHEMA", "DATABASE", "EXTENSION", "RULE", "POLICY", "ROLE", "USER", "TABLESPACE", "SERVER", "PUBLICATION", "SUBSCRIPTION", "AGGREGATE", "OPERATOR", "CAST", "COLLATION", "CONVERSION", "LANGUAGE", "STATISTICS", "TRANSFORM", "SYNONYM", "PACKAGE", "ASSEMBLY"]);

function objectOf(t: readonly Tok[], from: number): { kind: string; index: number } {
  for (let i = from; i < Math.min(t.length, from + 14); i++) {
    const x = t[i]!;
    if (x.k === "w" && OBJECTS.has(x.u)) return { kind: x.u, index: i };
  }
  return { kind: "", index: -1 };
}

export function applyStatement(cat: Catalog, st: Statement, ctx: Ctx): void {
  try {
    apply(cat, st, ctx);
  } catch {
    cat.note(ctx, st.line, "この文は読めませんでした");
  }
}

const DATA_FIRST = new Set(["INSERT", "REPLACE", "UPDATE", "DELETE", "COPY", "MERGE", "UPSERT", "LOAD", "TRUNCATE", "VALUES"]);
const KNOWN_OTHER = new Set(["SET", "SELECT", "GRANT", "REVOKE", "USE", "BEGIN", "START", "COMMIT", "ROLLBACK", "END", "LOCK", "UNLOCK", "PRAGMA", "VACUUM", "ANALYZE", "REINDEX", "DELIMITER", "DO", "SAVEPOINT", "RELEASE", "EXPLAIN", "SHOW", "SECURITY", "PREPARE", "EXECUTE", "DECLARE", "CALL", "WITH", "DESCRIBE", "ATTACH", "DETACH", "SOURCE", "CLUSTER", "REFRESH", "REASSIGN", "DISCARD", "ABORT", "CHECKPOINT", "LISTEN", "NOTIFY", "GO", "PRINT", "EXEC", "IF", "WHILE", "SHUTDOWN", "FLUSH", "OPTIMIZE", "REPAIR", "DEALLOCATE", "RESET", "CHECK", "ENABLE", "DISABLE", "IMPORT", "DROP", "ALTER", "CREATE", "COMMENT", "RENAME"]);

function apply(cat: Catalog, st: Statement, ctx: Ctx): void {
  const t = st.tokens;
  if (st.meta) {
    cat.skip("psql のメタコマンド");
    return;
  }
  if (t.length === 0) return;
  const first = t[0]!;
  if (first.k !== "w") {
    cat.skip("解釈できない文");
    return;
  }
  const u = first.u;
  if (DATA_FIRST.has(u)) {
    // REPLACE は MySQL の REPLACE INTO / UPDATE は データ。DELETE も
    cat.skipData(u === "COPY" ? "COPY" : u === "TRUNCATE" ? "TRUNCATE" : u);
    if (st.copyUnterminated) cat.note(ctx, st.line, "COPY のデータが \\. で終わっていません。最後まで読み飛ばしました");
    return;
  }
  if (u !== "CREATE" && u !== "ALTER" && u !== "DROP" && u !== "COMMENT" && u !== "RENAME") {
    cat.skip(KNOWN_OTHER.has(u) ? u : "解釈できない文");
    return;
  }
  if (cat.ddlStatements >= MAX_DDL_STATEMENTS) {
    if (cat.ddlStatements === MAX_DDL_STATEMENTS) {
      cat.ddlStatements++;
      cat.note(ctx, st.line, `読む文の数が上限 (${MAX_DDL_STATEMENTS}) を超えたため、以降の CREATE・ALTER・DROP などを読みませんでした`);
    }
    return;
  }
  cat.ddlStatements++;
  if (st.truncated) cat.note(ctx, st.line, "文が長すぎるため、途中から読みませんでした");
  const c = new Cur(t, 1, t.length, st.text);
  switch (u) {
    case "CREATE":
      return applyCreate(cat, st, ctx, c);
    case "ALTER":
      return applyAlter(cat, st, ctx, c);
    case "DROP":
      return applyDrop(cat, c);
    case "COMMENT":
      return applyComment(cat, c);
    default:
      return applyRenameTables(cat, st, ctx, c);
  }
}

function applyCreate(cat: Catalog, st: Statement, ctx: Ctx, c: Cur): void {
  const { kind, index } = objectOf(st.tokens, 1);
  const mods = st.tokens.slice(1, index < 0 ? 1 : index).map((x) => x.u);
  if (kind === "TABLE" && !mods.includes("FOREIGN") && !mods.includes("VIRTUAL") && !mods.includes("TEMP") && !mods.includes("TEMPORARY")) {
    c.i = index + 1;
    return createTable(cat, st, ctx, c);
  }
  if (kind === "INDEX" && mods.includes("UNIQUE")) {
    c.i = index + 1;
    return createUniqueIndex(cat, st, ctx, c);
  }
  if (kind === "TYPE") {
    c.i = index + 1;
    return createType(cat, ctx, c);
  }
  if (kind === "DOMAIN") {
    c.i = index + 1;
    const n = readTableName(c);
    c.eat("AS");
    const spec = readType(c);
    if (n && spec) cat.domains.set(tableKey(n.schema, n.name), spec);
    cat.skip("CREATE DOMAIN");
    return;
  }
  const label = kind === "" ? "CREATE" : mods.length > 0 && (mods.includes("TEMP") || mods.includes("TEMPORARY") || mods.includes("VIRTUAL") || mods.includes("FOREIGN") || mods.includes("MATERIALIZED")) ? `CREATE ${mods.filter((m) => m !== "OR" && m !== "REPLACE").join(" ")} ${kind}` : kind === "INDEX" ? "CREATE INDEX (一意でないもの)" : `CREATE ${kind}`;
  cat.skip(label);
}

function createTable(cat: Catalog, st: Statement, ctx: Ctx, c: Cur): void {
  const ifNotExists = c.eat("IF", "NOT", "EXISTS");
  const nm = readTableName(c);
  if (!nm) {
    cat.note(ctx, st.line, "CREATE TABLE の名前を読めませんでした");
    return;
  }
  if (/^sqlite_/i.test(nm.name)) {
    cat.skip("SQLite の内部テーブル (sqlite_*)");
    return;
  }
  const existing = cat.findTable(nm.schema, nm.name);
  if (existing && tableKey(existing.schema, existing.name) === tableKey(nm.schema, nm.name)) {
    if (ifNotExists) {
      cat.skip("CREATE TABLE IF NOT EXISTS (すでにあるテーブル)");
      return;
    }
    cat.note(ctx, nm.line, `テーブル ${nm.name} をもう一度作っています。あとの定義に置き換えました`);
    cat.dropTable(existing);
  }
  if (cat.created.length >= MAX_TABLES) {
    if (!cat.tableLimitHit) {
      cat.tableLimitHit = true;
      cat.note(ctx, nm.line, `テーブルの数が上限 (${MAX_TABLES}) を超えたため、以降の CREATE TABLE を読みませんでした`);
    }
    return;
  }
  const table: Table = { schema: nm.schema, name: nm.name, cols: [], colMap: new Map(), uniques: [], fks: [], line: nm.line, dropped: false, dialect: ctx.dialect };
  if (ctx.file) table.file = ctx.file;
  if (c.sym("(")) {
    const open = c.i;
    const close = matchClose(st.tokens, open);
    // (LIKE 元) は元の定義を写す
    if (c.kw("LIKE", 1) && isIdentTok(c.peek(2))) {
      c.i += 2;
      const src = readTableName(c);
      const from = src ? cat.findTable(src.schema, src.name, nm.schema) : undefined;
      if (from) {
        for (const col of from.cols) {
          const copy: Col = { ...col };
          table.cols.push(copy);
          table.colMap.set(colKey(copy.name), copy);
        }
      } else cat.note(ctx, nm.line, `テーブル ${nm.name} の LIKE の元が見つからないため、列を写せませんでした`);
    } else {
      if (close < 0) cat.note(ctx, nm.line, `テーブル ${nm.name} の定義が閉じられていません (ファイルが途中で終わっている可能性があります)。読めたところまでを使います`);
      const end = close < 0 ? st.tokens.length : close;
      for (const [s, e] of splitTop(st.tokens, open + 1, end)) parseTableItem(cat, table, new Cur(st.tokens, s, e, st.text), ctx);
    }
    // 閉じたあとのオプション (ENGINE=… COMMENT='…' など)
    if (close >= 0) {
      const tc = new Cur(st.tokens, close + 1, st.tokens.length, st.text);
      readTableOptions(tc, table);
    }
  } else if (c.kw("PARTITION") && c.kw("OF", 1)) {
    cat.note(ctx, nm.line, `テーブル ${nm.name} はパーティションの子 (PARTITION OF) のため読み飛ばしました`);
    return;
  } else if (c.kw("AS") || c.kw("SELECT") || c.kw("LIKE")) {
    cat.note(ctx, nm.line, `テーブル ${nm.name} は CREATE TABLE … AS (または LIKE) で作られていて、列を読めないため読み飛ばしました`);
    return;
  } else {
    cat.note(ctx, nm.line, `テーブル ${nm.name} の列の定義がないため読み飛ばしました`);
    return;
  }
  cat.registerTable(table);
}

function readTableOptions(c: Cur, table: Table): void {
  while (!c.done) {
    const t = c.next()!;
    if (t.k === "w" && t.u === "COMMENT") {
      c.eatSym("=");
      const s = c.peek();
      if (s && s.k === "s") {
        table.comment = s.v;
        c.i++;
      }
    } else if (t.k === "p" && t.v === "(") {
      c.i--;
      skipGroup(c);
    }
  }
}

function createUniqueIndex(cat: Catalog, st: Statement, ctx: Ctx, c: Cur): void {
  c.eat("CONCURRENTLY");
  c.eat("IF", "NOT", "EXISTS");
  let name: string | undefined;
  if (isIdentTok(c.peek()) && !c.kw("ON")) name = readNameParts(c)?.parts.pop();
  if (!c.eat("ON")) {
    cat.skip("CREATE UNIQUE INDEX (読めないもの)");
    return;
  }
  c.eat("ONLY");
  const tn = readTableName(c);
  const table = tn ? cat.findTable(tn.schema, tn.name) : undefined;
  if (!tn || !table) {
    cat.skip("CREATE UNIQUE INDEX (対象のテーブルなし)");
    return;
  }
  if (c.kw("USING")) c.i += 2;
  if (!c.sym("(")) {
    cat.skip("CREATE UNIQUE INDEX (読めないもの)");
    return;
  }
  const names = readColList(c);
  // INCLUDE (…) のあとに WHERE があれば条件つき
  let partial = false;
  for (let i = c.i; i < st.tokens.length; i++) if (st.tokens[i]!.k === "w" && st.tokens[i]!.u === "WHERE") partial = true;
  const line = st.tokens[0]!.line;
  if (partial) {
    cat.note(ctx, line, `${table.name} の条件つきの一意インデックス${name ? ` ${name}` : ""} は、一意として扱えないため読み飛ばしました`);
    return;
  }
  const cols = resolveCols(cat, table, names, ctx, line, `一意インデックス${name ? ` ${name}` : ""}`);
  if (!cols) return;
  const key: KeyDef = { cols, line, ...(name ? { name } : {}) };
  table.uniques.push(key);
  cat.registerKeyName(table, key);
}

function createType(cat: Catalog, ctx: Ctx, c: Cur): void {
  const nm = readTableName(c);
  if (!nm || !c.eat("AS")) {
    cat.skip("CREATE TYPE");
    return;
  }
  if (!c.kw("ENUM")) {
    cat.skip("CREATE TYPE (enum 以外)");
    return;
  }
  c.i++;
  const inner = readGroup(c);
  if (cat.enumsCreated.length >= MAX_ENUMS) {
    cat.note(ctx, nm.line, `enum の数が上限 (${MAX_ENUMS}) を超えたため、以降の CREATE TYPE を読みませんでした`);
    return;
  }
  const values = inner.filter((x) => x.k === "s").map((x) => x.v);
  if (values.length > MAX_ENUM_VALUES) cat.note(ctx, nm.line, `enum ${nm.name} の値が上限 (${MAX_ENUM_VALUES}) を超えたため、以降を読みませんでした`);
  const def: EnumDef = { schema: nm.schema, name: nm.name, values: values.slice(0, MAX_ENUM_VALUES), line: nm.line, dropped: false };
  cat.setEnum(def);
}

function applyDrop(cat: Catalog, c: Cur): void {
  const { kind, index } = objectOf(c.t, 1);
  if (kind === "TABLE" && !c.t.slice(1, index).some((x) => x.k === "w" && (x.u === "TEMP" || x.u === "TEMPORARY"))) {
    c.i = index + 1;
    c.eat("IF", "EXISTS");
    for (;;) {
      const n = readTableName(c);
      if (!n) break;
      const t = cat.findTable(n.schema, n.name);
      if (t) cat.dropTable(t);
      if (!c.eatSym(",")) break;
    }
    return;
  }
  if (kind === "TYPE" || kind === "DOMAIN") {
    c.i = index + 1;
    c.eat("IF", "EXISTS");
    for (;;) {
      const n = readTableName(c);
      if (!n) break;
      const e = cat.findEnum(n.schema, n.name);
      if (e) cat.removeEnum(e);
      cat.domains.delete(tableKey(n.schema, n.name));
      if (!c.eatSym(",")) break;
    }
    return;
  }
  if (kind === "INDEX") {
    c.i = index + 1;
    c.eat("CONCURRENTLY");
    c.eat("IF", "EXISTS");
    const n = readNameParts(c);
    const nm = n?.parts[n.parts.length - 1];
    if (nm) {
      const list = cat.keyNames.get(nm.toLowerCase());
      if (list) {
        for (const { table, key } of list) {
          const at = table.uniques.indexOf(key);
          if (!table.dropped && at >= 0) table.uniques.splice(at, 1);
        }
        cat.keyNames.delete(nm.toLowerCase());
      }
    }
    cat.skip("DROP INDEX");
    return;
  }
  cat.skip(kind === "" ? "DROP" : `DROP ${kind}`);
}

function applyComment(cat: Catalog, c: Cur): void {
  if (!c.eat("ON")) {
    cat.skip("COMMENT");
    return;
  }
  const isTable = c.kw("TABLE");
  const isColumn = c.kw("COLUMN");
  if (!isTable && !isColumn) {
    cat.skip("COMMENT ON (テーブル・列以外)");
    return;
  }
  c.i++;
  const n = readNameParts(c);
  if (!n || !c.eat("IS")) {
    cat.skip("COMMENT ON (読めないもの)");
    return;
  }
  const v = c.peek();
  const value = v && v.k === "s" ? v.v : v && v.k === "w" && v.u === "NULL" ? "" : undefined;
  if (value === undefined) {
    cat.skip("COMMENT ON (読めないもの)");
    return;
  }
  if (isTable) {
    const name = n.parts[n.parts.length - 1]!;
    const schema = n.parts.length >= 2 ? normSchema(n.parts[n.parts.length - 2]!) : "";
    const t = cat.findTable(schema, name);
    if (!t) {
      cat.skip("COMMENT ON (対象なし。ビューなど)");
      return;
    }
    if (value === "") delete t.comment;
    else t.comment = value;
    return;
  }
  if (n.parts.length < 2) {
    cat.skip("COMMENT ON (読めないもの)");
    return;
  }
  const colName = n.parts[n.parts.length - 1]!;
  const name = n.parts[n.parts.length - 2]!;
  const schema = n.parts.length >= 3 ? normSchema(n.parts[n.parts.length - 3]!) : "";
  const t = cat.findTable(schema, name);
  const col = t?.colMap.get(colKey(colName));
  if (!col) {
    cat.skip("COMMENT ON (対象なし。ビューなど)");
    return;
  }
  if (value === "") delete col.comment;
  else col.comment = value;
}

function applyRenameTables(cat: Catalog, st: Statement, ctx: Ctx, c: Cur): void {
  if (!c.eat("TABLE")) {
    cat.skip("RENAME");
    return;
  }
  for (;;) {
    const a = readTableName(c);
    if (!a || !c.eat("TO")) break;
    const b = readTableName(c);
    if (!b) break;
    const t = cat.findTable(a.schema, a.name);
    if (t) cat.renameTable(t, b.schema, b.name);
    else cat.note(ctx, st.line, `RENAME TABLE: テーブル ${a.name} が見つかりません`);
    if (!c.eatSym(",")) break;
  }
}

// ---------------------------------------------------------------------------------------------
// ALTER

function hasOwnerTo(st: Statement): boolean {
  const t = st.tokens;
  for (let i = 1; i < Math.min(t.length - 1, 30); i++) if (t[i]!.k === "w" && t[i]!.u === "OWNER" && t[i + 1]!.k === "w" && t[i + 1]!.u === "TO") return true;
  return false;
}

function applyAlter(cat: Catalog, st: Statement, ctx: Ctx, c: Cur): void {
  if (c.kw("TABLE")) {
    c.i++;
    c.eat("IF", "EXISTS");
    c.eat("ONLY");
    const nm = readTableName(c);
    c.eatSym("*");
    if (!nm) {
      cat.skip("ALTER TABLE (読めないもの)");
      return;
    }
    const table = cat.findTable(nm.schema, nm.name);
    if (!table) {
      cat.skip("ALTER TABLE (対象のテーブルなし)");
      return;
    }
    for (const [s, e] of splitTop(st.tokens, c.i, st.tokens.length)) alterAction(cat, table, new Cur(st.tokens, s, e, st.text), ctx);
    return;
  }
  if (c.kw("TYPE")) {
    c.i++;
    const nm = readTableName(c);
    const en = nm ? cat.findEnum(nm.schema, nm.name) : undefined;
    if (!nm || !en) {
      cat.skip("ALTER TYPE (対象なし)");
      return;
    }
    if (c.eat("ADD", "VALUE")) {
      c.eat("IF", "NOT", "EXISTS");
      const v = c.peek();
      if (v && v.k === "s") {
        c.i++;
        if (!en.values.includes(v.v) && en.values.length < MAX_ENUM_VALUES) {
          const ref = c.peek(1);
          const at = ref && (c.kw("BEFORE") || c.kw("AFTER")) ? en.values.indexOf(ref.v) : -1;
          if (at >= 0) en.values.splice(c.kw("BEFORE") ? at : at + 1, 0, v.v);
          else en.values.push(v.v);
        }
      }
      return;
    }
    if (c.eat("RENAME", "VALUE")) {
      const a = c.peek();
      c.i++;
      if (c.eat("TO")) {
        const b = c.peek();
        if (a && b && a.k === "s" && b.k === "s") {
          const at = en.values.indexOf(a.v);
          if (at >= 0) en.values[at] = b.v;
        }
      }
      return;
    }
    if (c.eat("RENAME", "TO")) {
      const n = c.peek();
      if (isIdentTok(n)) {
        cat.renameEnum(en, n.v);
      }
      return;
    }
    cat.skip(hasOwnerTo(st) ? "ALTER … OWNER TO" : "ALTER TYPE (そのほか)");
    return;
  }
  const { kind } = objectOf(st.tokens, 1);
  cat.skip(hasOwnerTo(st) ? "ALTER … OWNER TO" : kind === "" ? "ALTER" : `ALTER ${kind}`);
}

function dropColumn(table: Table, name: string): void {
  const col = table.colMap.get(colKey(name));
  if (!col) return;
  col.dropped = true;
  table.colMap.delete(colKey(name));
  table.cols = table.cols.filter((x) => x !== col);
}

function alterAction(cat: Catalog, table: Table, c: Cur, ctx: Ctx): void {
  const f = c.peek();
  if (!f || f.k !== "w") {
    cat.skip("ALTER TABLE (そのほかの変更)");
    return;
  }
  switch (f.u) {
    case "ADD": {
      c.i++;
      if (c.sym("(")) {
        const inner = readGroup(c);
        const base = c.t.indexOf(inner[0] ?? f);
        if (inner.length > 0 && base >= 0) {
          for (const [s, e] of splitTop(c.t, base, base + inner.length)) parseTableItem(cat, table, new Cur(c.t, s, e, c.text), ctx);
        }
        return;
      }
      const hadColumn = c.eat("COLUMN");
      const ine = c.eat("IF", "NOT", "EXISTS");
      const nameTok = c.peek();
      if (ine && isIdentTok(nameTok) && table.colMap.has(colKey(nameTok.v))) return;
      parseTableItem(cat, table, c, ctx, hadColumn);
      return;
    }
    case "DROP": {
      c.i++;
      if (c.eat("PRIMARY", "KEY")) {
        delete table.pk;
        return;
      }
      if (c.eat("FOREIGN", "KEY")) {
        const n = c.peek();
        if (isIdentTok(n)) table.fks = table.fks.filter((x) => (x.name ?? "").toLowerCase() !== n.v.toLowerCase());
        return;
      }
      if (c.kw("CONSTRAINT") || c.kw("INDEX") || c.kw("KEY") || c.kw("CHECK")) {
        const isCheck = c.kw("CHECK");
        c.i++;
        c.eat("IF", "EXISTS");
        const n = c.peek();
        if (isCheck || !isIdentTok(n)) return;
        const lower = n.v.toLowerCase();
        if ((table.pk?.name ?? "").toLowerCase() === lower) delete table.pk;
        table.uniques = table.uniques.filter((x) => (x.name ?? "").toLowerCase() !== lower);
        table.fks = table.fks.filter((x) => (x.name ?? "").toLowerCase() !== lower);
        return;
      }
      c.eat("COLUMN");
      c.eat("IF", "EXISTS");
      const n = c.peek();
      if (isIdentTok(n)) dropColumn(table, n.v);
      return;
    }
    case "RENAME": {
      c.i++;
      if (c.kw("COLUMN") || (isIdentTok(c.peek()) && c.kw("TO", 1) && !c.kw("CONSTRAINT") && !c.kw("INDEX") && !c.kw("KEY"))) {
        c.eat("COLUMN");
        const a = c.next();
        if (a && c.eat("TO")) {
          const b = c.next();
          const col = table.colMap.get(colKey(a.v));
          if (col && b && isIdentTok(b)) {
            table.colMap.delete(colKey(a.v));
            col.name = b.v;
            table.colMap.set(colKey(b.v), col);
          }
        }
        return;
      }
      if (c.kw("CONSTRAINT") || c.kw("INDEX") || c.kw("KEY")) {
        c.i++;
        const a = c.next();
        if (a && c.eat("TO")) {
          const b = c.next();
          if (b && isIdentTok(b)) {
            const lower = a.v.toLowerCase();
            if ((table.pk?.name ?? "").toLowerCase() === lower) table.pk!.name = b.v;
            for (const k of table.uniques) if ((k.name ?? "").toLowerCase() === lower) {
              k.name = b.v;
              cat.registerKeyName(table, k);
            }
            for (const k of table.fks) if ((k.name ?? "").toLowerCase() === lower) k.name = b.v;
          }
        }
        return;
      }
      c.eat("TO") || c.eat("AS");
      const nn = readTableName(c);
      if (nn) cat.renameTable(table, nn.schema === "" ? table.schema : nn.schema, nn.name);
      return;
    }
    case "ALTER": {
      c.i++;
      c.eat("COLUMN");
      const n = c.next();
      if (!isIdentTok(n)) return;
      const col = table.colMap.get(colKey(n.v));
      if (!col) return;
      alterColumn(cat, table, col, c, ctx);
      return;
    }
    case "MODIFY":
    case "CHANGE": {
      const isChange = f.u === "CHANGE";
      c.i++;
      c.eat("COLUMN");
      c.eat("IF", "EXISTS");
      let oldName: string | undefined;
      if (isChange) {
        const o = c.next();
        if (!isIdentTok(o)) return;
        oldName = o.v;
      }
      const nameTok = c.next();
      if (!isIdentTok(nameTok)) return;
      const existing = table.colMap.get(colKey(oldName ?? nameTok.v));
      const res = parseColumn(cat, c, ctx, nameTok);
      if (!existing) {
        addColumn(cat, table, res, ctx);
        return;
      }
      table.colMap.delete(colKey(existing.name));
      const keep = existing;
      Object.assign(keep, res.col, { dropped: false });
      table.colMap.set(colKey(keep.name), keep);
      attachInline(cat, table, { ...res, col: keep }, ctx);
      return;
    }
    case "COMMENT": {
      c.i++;
      c.eatSym("=");
      const s = c.peek();
      if (s && s.k === "s") table.comment = s.v;
      return;
    }
    default:
      cat.skip(f.u === "OWNER" ? "ALTER … OWNER TO" : "ALTER TABLE (そのほかの変更)");
  }
}

function alterColumn(cat: Catalog, table: Table, col: Col, c: Cur, ctx: Ctx): void {
  if (c.kw("TYPE") || c.eat("SET", "DATA", "TYPE")) {
    if (c.kw("TYPE")) c.i++;
    const startIdx = c.i;
    const spec = readType(c);
    if (spec) {
      col.type = spec;
      if (typeIsSerial(c, startIdx)) col.autoInc = true;
      col.dialect = ctx.dialect;
    }
    return;
  }
  if (c.eat("SET", "NOT", "NULL")) {
    col.notNull = true;
    return;
  }
  if (c.eat("DROP", "NOT", "NULL")) {
    col.notNull = false;
    return;
  }
  if (c.eat("SET", "DEFAULT")) {
    const toks: Tok[] = [];
    while (!c.done) toks.push(c.next()!);
    col.def = toks.length > 0 ? { toks, text: ctx.text } : undefined;
    return;
  }
  if (c.eat("DROP", "DEFAULT")) {
    col.def = undefined;
    col.autoInc = false;
    return;
  }
  if (c.eat("ADD", "GENERATED") || c.eat("SET", "GENERATED")) {
    col.autoInc = true;
    return;
  }
  if (c.eat("DROP", "IDENTITY")) {
    col.autoInc = false;
    return;
  }
  void table;
  void cat;
  cat.skip("ALTER COLUMN (そのほかの変更)");
}

// ---------------------------------------------------------------------------------------------
// 最後に: カタログを確定する

/** 消えた列を使う制約を落とし、外部キーの参照先を (まだなら) 名前から結ぶ。生きているテーブルの一覧を返す */
export function finalizeCatalog(cat: Catalog, ctx?: { file?: string }): Table[] {
  const live = cat.liveTables();
  void ctx;
  for (const t of live) {
    if (t.pk && t.pk.cols.some((c) => c.dropped)) delete t.pk;
    t.uniques = t.uniques.filter((k) => k.cols.every((c) => !c.dropped));
    if (t.pk) for (const c of t.pk.cols) c.notNull = true;
  }
  for (const t of live) {
    t.fks = t.fks.filter((fk) => {
      if (fk.cols.some((c) => c.dropped)) return false;
      if (fk.target && fk.target.dropped) return false;
      if (!fk.target) {
        const target = cat.findTable(fk.refSchema, fk.refName, t.schema);
        if (target) fk.target = target;
      }
      if (fk.target && fk.refCols && fk.refCols.some((c) => c.dropped)) return false;
      if (fk.target && !fk.refCols) resolveRefCols(fk);
      return true;
    });
  }
  return live;
}
