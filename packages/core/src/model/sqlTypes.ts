// SQL の型と DEFAULT の式を、データベースの DSL (prisma.ts) の型・属性へ写す (sqlImport.ts の下請け)。純粋関数だけを置く。
import type { Tok } from "./sqlLex";

export type ScalarName = "String" | "Int" | "BigInt" | "Float" | "Decimal" | "Boolean" | "DateTime" | "Json" | "Bytes";

export interface ScalarMap {
  prisma: ScalarName;
  /** もとの型の情報を残す属性 (@db.VarChar(255) など) */
  native?: string;
}

/**
 * DSL の文字列に、そのまま書けない文字か。DSL の解析器 (prisma.ts) は、文字列の中の `\x` を x の 1 文字に戻すだけで (`\n` は n になる)、
 * 行ごとに読むので、改行・タブ・制御文字・行区切り・向きを変える文字は書き出せない (空白にする)
 */
// eslint-disable-next-line no-control-regex
const UNWRITABLE = /[\u0000-\u001f\u007f\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

/** quoteDsl が空白に置き換える文字を含むか */
export const hasUnwritable = (text: string): boolean => UNWRITABLE.test(text);

/**
 * DSL の文字列リテラル ("…")。DSL の解析器が読み直して同じ文字列に戻る形だけを出す:
 * `\` と `"` は `\\`・`\"` にし、改行・タブ・制御文字・行区切り・向きを変える文字は書き出せないので空白 1 つにする (hasUnwritable で知らせる)
 */
export function quoteDsl(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") out += "\\\\";
    else if (c === '"') out += '\\"';
    else if (UNWRITABLE.test(c)) out += " ";
    else out += c;
  }
  return `${out}"`;
}

const nativeOf = (name: string, ...args: (number | undefined)[]): string => {
  const a = args.filter((x): x is number => x !== undefined);
  return `@db.${name}${a.length > 0 ? `(${a.join(", ")})` : ""}`;
};

/** 方言ごとの native 属性の名前の違い (MySQL とそれ以外) */
export function mapScalar(base: string, nums: number[], unsigned: boolean, dialect: string): ScalarMap | null {
  const mysql = dialect === "mysql";
  const n0 = nums[0];
  const n1 = nums[1];
  const S = (prisma: ScalarName, native?: string): ScalarMap => (native ? { prisma, native } : { prisma });
  switch (base) {
    case "smallint":
    case "int2":
      return S("Int", nativeOf(unsigned ? "UnsignedSmallInt" : "SmallInt"));
    case "tinyint":
      if (n0 === 1) return S("Boolean");
      return S("Int", nativeOf(unsigned ? "UnsignedTinyInt" : "TinyInt"));
    case "mediumint":
      return S("Int", nativeOf(unsigned ? "UnsignedMediumInt" : "MediumInt"));
    case "int":
    case "integer":
    case "int4":
    case "mediumserial":
      return S("Int", unsigned ? nativeOf("UnsignedInt") : undefined);
    case "bigint":
    case "int8":
      return S("BigInt", unsigned ? nativeOf("UnsignedBigInt") : undefined);
    case "year":
      return S("Int", nativeOf("Year"));
    case "real":
    case "float4":
      return S("Float", mysql ? undefined : nativeOf("Real"));
    case "float":
      return S("Float", mysql ? nativeOf("Float") : undefined);
    case "double":
    case "double precision":
    case "float8":
      return S("Float");
    case "numeric":
    case "decimal":
    case "dec":
    case "fixed":
    case "number":
      return S("Decimal", n0 !== undefined ? nativeOf("Decimal", n0, n1 ?? 0) : undefined);
    case "money":
    case "smallmoney":
      return S("Decimal", nativeOf("Money"));
    case "boolean":
    case "bool":
      return S("Boolean");
    case "bit":
      if (mysql) return n0 === undefined || n0 === 1 ? S("Boolean") : S("Bytes", nativeOf("Bit", n0));
      return n0 === undefined || n0 === 1 ? S("Boolean") : S("String", nativeOf("Bit", n0));
    case "char":
    case "character":
    case "bpchar":
    case "national char":
    case "national character":
      return S("String", n0 !== undefined ? nativeOf("Char", n0) : undefined);
    case "nchar":
      return S("String", n0 !== undefined ? nativeOf("NChar", n0) : undefined);
    case "varchar":
    case "character varying":
    case "char varying":
    case "varchar2":
    case "nvarchar2":
    case "national varchar":
    case "national character varying":
    case "varying character":
      return S("String", n0 !== undefined ? nativeOf("VarChar", n0) : undefined);
    case "text":
      return S("String", mysql ? nativeOf("Text") : undefined);
    case "tinytext":
      return S("String", nativeOf("TinyText"));
    case "mediumtext":
      return S("String", nativeOf("MediumText"));
    case "longtext":
      return S("String", nativeOf("LongText"));
    case "nvarchar":
      return S("String", n0 !== undefined ? nativeOf("NVarChar", n0) : nativeOf("NVarChar"));
    case "ntext":
      return S("String", nativeOf("NText"));
    case "clob":
    case "nclob":
    case "name":
    case "string":
      return S("String");
    case "citext":
      return S("String", nativeOf("Citext"));
    case "uuid":
      return S("String", nativeOf("Uuid"));
    case "uniqueidentifier":
      return S("String");
    case "xml":
      return S("String", nativeOf("Xml"));
    case "inet":
      return S("String", nativeOf("Inet"));
    case "json":
      return S("Json", mysql ? undefined : nativeOf("Json"));
    case "jsonb":
      return S("Json", nativeOf("JsonB"));
    case "bytea":
      return S("Bytes", nativeOf("ByteA"));
    case "blob":
      return S("Bytes", mysql ? nativeOf("Blob") : undefined);
    case "tinyblob":
      return S("Bytes", nativeOf("TinyBlob"));
    case "mediumblob":
      return S("Bytes", nativeOf("MediumBlob"));
    case "longblob":
      return S("Bytes", nativeOf("LongBlob"));
    case "binary":
      return S("Bytes", nativeOf("Binary", n0));
    case "varbinary":
      return S("Bytes", nativeOf("VarBinary", n0));
    case "image":
    case "raw":
    case "bytes":
    case "longvarbinary":
      return S("Bytes");
    case "date":
      return S("DateTime", nativeOf("Date"));
    case "time":
    case "time without time zone":
      return S("DateTime", nativeOf("Time", n0));
    case "timetz":
    case "time with time zone":
      return S("DateTime", nativeOf("Timetz", n0));
    case "rowversion":
      return S("Bytes");
    case "timestamp":
    case "timestamp without time zone":
      // SQL Server の timestamp は日時ではなく、行のバージョン (rowversion と同じ 8 バイト)
      if (base === "timestamp" && dialect === "mssql") return S("Bytes");
      // PostgreSQL の既定 (Prisma の DateTime は timestamp(3)) と同じなら付けない
      return S("DateTime", mysql ? nativeOf("Timestamp", n0 ?? 0) : n0 !== undefined && n0 !== 3 ? nativeOf("Timestamp", n0) : undefined);
    case "datetime":
      return S("DateTime", mysql && n0 !== undefined ? nativeOf("DateTime", n0) : undefined);
    case "timestamptz":
    case "timestamp with time zone":
      return S("DateTime", nativeOf("Timestamptz", n0));
    case "datetime2":
    case "smalldatetime":
    case "datetimeoffset":
    case "timestamp with local time zone":
      return S("DateTime");
    default:
      return null;
  }
}

/** 連番になる型 (serial 系) の、もとの整数型 */
export const SERIAL_BASE: Readonly<Record<string, string>> = {
  serial: "integer",
  serial4: "integer",
  smallserial: "smallint",
  serial2: "smallint",
  bigserial: "bigint",
  serial8: "bigint",
};

export interface DefaultTarget {
  prisma: ScalarName | "enum";
  isList: boolean;
  /** enum の列: SQL の値 → DSL の値の名前 */
  enumValues?: ReadonlyMap<string, string>;
}

export type DefaultResult = { kind: "none" } | { kind: "auto" } | { kind: "attr"; attr: string } | { kind: "drop"; reason: string };

const NOW_FUNCS = new Set(["now", "current_timestamp", "localtimestamp", "statement_timestamp", "transaction_timestamp", "clock_timestamp", "getdate", "getutcdate", "sysdatetime", "sysutcdatetime", "sysdate", "systimestamp", "current_timestamp_utc", "utc_timestamp", "localtime", "unix_timestamp"]);
const UUID_FUNCS = new Set(["gen_random_uuid", "uuid_generate_v4", "uuid", "newid", "uuid_generate_v1", "uuid_generate_v1mc", "uuidv4", "uuidv7", "newsequentialid"]);
const DBGEN_MAX = 300;
const DEFAULT_STRING_MAX = 1000;

const closeOf = (toks: readonly Tok[], open: number): number => {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k !== "p") continue;
    if (t.v === "(" || t.v === "[") depth++;
    else if (t.v === ")" || t.v === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** 全体を囲む () を外す */
function stripParens(toks: readonly Tok[]): readonly Tok[] {
  let a = toks;
  while (a.length >= 2 && a[0]!.k === "p" && a[0]!.v === "(" && closeOf(a, 0) === a.length - 1) a = a.slice(1, -1);
  return a;
}

const isoOf = (v: string): string | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(?:\s*(Z|[+-]\d{2}(?::?\d{2})?))?$/i.exec(v.trim());
  if (!m) return null;
  if (m[1] === "0000" || m[2] === "00" || m[3] === "00") return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const time = `${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}${m[7] ? `.${m[7]}` : ""}`;
  let zone = "Z";
  if (m[8] && m[8].toUpperCase() !== "Z") zone = m[8].length === 3 ? `${m[8]}:00` : m[8].length === 5 ? `${m[8].slice(0, 3)}:${m[8].slice(3)}` : m[8];
  return `${date}T${time}${zone}`;
};

/**
 * 列の DEFAULT の式を DSL の @default(…) へ写す。
 * 受けられる形 (定数・now()・uuid()・連番) は専用の形に、ほかの式は dbgenerated("…") として生の文字列で残す。長すぎるものは落とす
 */
export function convertDefault(all: readonly Tok[], text: string, target: DefaultTarget): DefaultResult {
  if (all.length === 0) return { kind: "none" };
  if (all.length > 200) return { kind: "drop", reason: "DEFAULT の式が長すぎます" };
  // 全体を囲む () を外した式の、もとの書き方 (dbgenerated に残す)
  let a = stripParens(all);
  const rawToks = a;
  const whole = () => (rawToks.length === 0 ? "" : text.slice(rawToks[0]!.s, rawToks[rawToks.length - 1]!.e).replace(/\s+/g, " ").trim());
  const dbgen = (): DefaultResult => {
    const raw = whole();
    if (raw.length > DBGEN_MAX) return { kind: "drop", reason: `DEFAULT の式が長すぎます (${DBGEN_MAX} 文字まで): ${raw.slice(0, 40)}…` };
    return { kind: "attr", attr: `@default(dbgenerated(${quoteDsl(raw)}))` };
  };
  if (a.length === 0) return { kind: "none" };
  // MySQL の文字セットの指定つきの文字列 (_utf8mb4'abc')
  if (a.length === 2 && a[0]!.k === "w" && a[0]!.v.startsWith("_") && a[1]!.k === "s" && a[1]!.s === a[0]!.e) a = [a[1]!];
  // ::型 のキャスト。キャストのあとに演算子などが続くときは複雑な式
  let castArray = false;
  let castText = "";
  const castAt = a.findIndex((t, i) => {
    if (t.k !== "p" || t.v !== "::") return false;
    let depth = 0;
    for (let j = 0; j < i; j++) {
      const x = a[j]!;
      if (x.k === "p" && (x.v === "(" || x.v === "[")) depth++;
      else if (x.k === "p" && (x.v === ")" || x.v === "]")) depth--;
    }
    return depth === 0;
  });
  if (castAt >= 0) {
    const tail = a.slice(castAt + 1);
    for (const t of tail) {
      if (t.k === "p" && !["(", ")", ",", ".", "[", "]", "::"].includes(t.v)) return dbgen();
      if (t.k === "p" && t.v === "[") castArray = true;
      if (t.k === "w") castText += `${t.v.toLowerCase()} `;
    }
    a = stripParens(a.slice(0, castAt));
    if (a.length === 0) return dbgen();
  }
  const first = a[0]!;
  // 数値 (符号つき)
  let numText: string | null = null;
  if (a.length === 1 && first.k === "n") numText = first.v;
  else if (a.length === 2 && first.k === "p" && (first.v === "-" || first.v === "+") && a[1]!.k === "n") numText = `${first.v === "-" ? "-" : ""}${a[1]!.v}`;
  const isNumber = (s: string) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s);
  const isInt = (s: string) => /^-?\d+$/.test(s) || /^-?\d+\.0+$/.test(s);
  const intOf = (s: string) => s.replace(/\.0+$/, "");
  const str = (v: string): string => quoteDsl(v);

  // NULL は既定なし
  if (a.length === 1 && first.k === "w" && first.u === "NULL") return { kind: "none" };

  // 空の配列 ('{}'::t[]・ARRAY[]::t[])
  if (target.isList) {
    if (a.length === 1 && first.k === "s" && first.v.trim() === "{}") return { kind: "attr", attr: "@default([])" };
    if (a.length === 3 && first.k === "w" && first.u === "ARRAY" && a[1]!.v === "[" && a[2]!.v === "]") return { kind: "attr", attr: "@default([])" };
    return dbgen();
  }
  if (castArray) return dbgen();

  // 文字列
  if (a.length === 1 && first.k === "s") {
    const v = first.v;
    if (first.pre === "b" || first.pre === "x") {
      if (target.prisma === "Boolean" && first.pre === "b") return { kind: "attr", attr: `@default(${/^0*$/.test(v) ? "false" : "true"})` };
      return dbgen();
    }
    if (v.length > DEFAULT_STRING_MAX) return { kind: "drop", reason: `DEFAULT の文字列が長すぎます (${DEFAULT_STRING_MAX} 文字まで)` };
    switch (target.prisma) {
      case "enum": {
        const name = target.enumValues?.get(v);
        return name ? { kind: "attr", attr: `@default(${name})` } : { kind: "drop", reason: `DEFAULT の値 '${v.slice(0, 40)}' が enum にありません` };
      }
      case "Boolean": {
        const l = v.trim().toLowerCase();
        if (["t", "true", "1", "y", "yes", "on"].includes(l)) return { kind: "attr", attr: "@default(true)" };
        if (["f", "false", "0", "n", "no", "off"].includes(l)) return { kind: "attr", attr: "@default(false)" };
        return dbgen();
      }
      case "Int":
      case "BigInt":
        return isInt(v.trim()) ? { kind: "attr", attr: `@default(${intOf(v.trim())})` } : dbgen();
      case "Float":
      case "Decimal":
        return isNumber(v.trim()) ? { kind: "attr", attr: `@default(${v.trim()})` } : dbgen();
      case "DateTime": {
        if (/^(now|today|current_timestamp)$/i.test(v.trim()) && castText.startsWith("timestamp")) return { kind: "attr", attr: "@default(now())" };
        if (/^now$/i.test(v.trim())) return { kind: "attr", attr: "@default(now())" };
        const iso = isoOf(v);
        return iso ? { kind: "attr", attr: `@default(${str(iso)})` } : dbgen();
      }
      case "Bytes":
        return dbgen();
      default:
        return { kind: "attr", attr: `@default(${str(v)})` };
    }
  }
  if (numText !== null) {
    switch (target.prisma) {
      case "Int":
      case "BigInt":
        return isInt(numText) ? { kind: "attr", attr: `@default(${intOf(numText)})` } : dbgen();
      case "Float":
      case "Decimal":
        return isNumber(numText) ? { kind: "attr", attr: `@default(${numText})` } : dbgen();
      case "Boolean":
        return numText === "0" ? { kind: "attr", attr: "@default(false)" } : numText === "1" ? { kind: "attr", attr: "@default(true)" } : dbgen();
      case "String":
        return isNumber(numText) ? { kind: "attr", attr: `@default(${str(numText)})` } : dbgen();
      default:
        return dbgen();
    }
  }
  // true / false
  if (a.length === 1 && first.k === "w" && (first.u === "TRUE" || first.u === "FALSE")) {
    const b = first.u === "TRUE";
    if (target.prisma === "Boolean") return { kind: "attr", attr: `@default(${b})` };
    if (target.prisma === "Int" || target.prisma === "BigInt") return { kind: "attr", attr: `@default(${b ? 1 : 0})` };
    return dbgen();
  }
  // 関数 (now()・uuid()・nextval(…))。名前は スキーマ.名前 でもよい。かっこの中は定数だけ
  if (first.k === "w" || first.k === "q") {
    let j = 0;
    let fname = first.v.toLowerCase();
    while (a[j + 1]?.k === "p" && a[j + 1]!.v === "." && (a[j + 2]?.k === "w" || a[j + 2]?.k === "q")) {
      fname = a[j + 2]!.v.toLowerCase();
      j += 2;
    }
    const rest = a.slice(j + 1);
    const bare = rest.length === 0;
    const call = rest.length >= 2 && rest[0]!.v === "(" && closeOf(rest, 0) === rest.length - 1;
    const argToks = call ? rest.slice(1, -1) : [];
    if (bare || call) {
      if (fname === "nextval" && call) return { kind: "auto" };
      if (NOW_FUNCS.has(fname) && (bare || argToks.every((t) => t.k === "n"))) {
        if (fname === "unix_timestamp") return dbgen();
        return target.prisma === "DateTime" ? { kind: "attr", attr: "@default(now())" } : dbgen();
      }
      if (fname === "datetime" && call && argToks.length >= 1 && argToks[0]!.k === "s" && argToks[0]!.v.toLowerCase() === "now" && target.prisma === "DateTime") return { kind: "attr", attr: "@default(now())" };
      if (UUID_FUNCS.has(fname) && (bare ? false : argToks.length === 0)) return target.prisma === "String" ? { kind: "attr", attr: "@default(uuid())" } : dbgen();
      if (fname === "cuid" && call && argToks.length === 0 && target.prisma === "String") return { kind: "attr", attr: "@default(cuid())" };
    }
  }
  return dbgen();
}
