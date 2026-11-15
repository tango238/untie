// SQL の字句解析と文の切り出し (sqlImport.ts の下請け)。純粋関数だけを置く。
// 正規表現の後戻りで固まらないよう、1 文字ずつ走査する。入力の長さに対して線形で、例外を投げない。
// 文字列・引用符付きの識別子・コメント・ドル引用・DELIMITER・COPY のデータ・BEGIN … END の中の ; を正しく読み飛ばす。

export type TokKind = "w" | "q" | "s" | "n" | "p";

export interface Tok {
  /** w: 単語 (引用符なしの識別子・キーワード)、q: 引用符付きの識別子、s: 文字列、n: 数値、p: 記号 */
  k: TokKind;
  /** 単語はそのまま、q・s は引用符を外して解いた中身、p は記号 */
  v: string;
  /** 単語の大文字 (w のときだけ) */
  u: string;
  /** 元の文字列での位置 */
  s: number;
  e: number;
  /** 1 始まりの行番号 */
  line: number;
  /** s・q の引用符の文字 (' " ` [ $) */
  d?: string;
  /** 文字列の接頭辞 (b・x・n・e) */
  pre?: string;
}

export interface Statement {
  /** 集めたトークン。読み飛ばす種類の文は先頭の数個だけ */
  tokens: Tok[];
  /** 文の最初のトークンの行 (1 始まり) */
  line: number;
  /** トークンの位置が指す元の文字列 */
  text: string;
  /** トークンをすべて集めたか (読み飛ばす種類の文は false) */
  full: boolean;
  /** トークンの数が上限を超えて、あとを切り捨てた */
  truncated: boolean;
  /** 文が区切りで終わらずに入力が終わった */
  unterminated: boolean;
  /** psql のメタコマンド (\connect など) */
  meta: boolean;
  /** COPY … FROM stdin のデータを読み飛ばした */
  copyData: boolean;
  /** COPY のデータが \. で終わっていない */
  copyUnterminated: boolean;
}

export type Dialect = "pg" | "mysql" | "sqlite" | "other";

/** 1 つの文で集めるトークンの上限 (超えたら捨てる) */
export const MAX_STATEMENT_TOKENS = 300_000;

/** 中身を読む文の最初の単語。これ以外の文は先頭の数個のトークンだけ持つ */
const COLLECT_FIRST = new Set(["CREATE", "ALTER", "DROP", "COMMENT", "RENAME", "COPY"]);
const KEEP_PREFIX = 6;

/** 方言を推定する。字句解析 (バックスラッシュの扱い) と型の対応に使う */
export function detectDialect(text: string): Dialect {
  const head = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  if (/PostgreSQL database dump|pg_dump/i.test(head)) return "pg";
  if (/\bAUTOINCREMENT\b|\bWITHOUT\s+ROWID\b|sqlite_sequence|sqlite_master|\bPRAGMA\b/i.test(head)) return "sqlite";
  if (head.includes("`") || /\bENGINE\s*=|\bAUTO_INCREMENT\b|\/\*!\d|\bDELIMITER\s|\bLOCK\s+TABLES\b|\bUNSIGNED\b/i.test(head)) return "mysql";
  if (head.includes("::") || /\bpg_catalog\b|\bCREATE\s+EXTENSION\b|\bnextval\s*\(|\bBIGSERIAL\b|\bSERIAL\b|\bTIMESTAMPTZ\b|\bTIMESTAMP\s+WITH(OUT)?\s+TIME\s+ZONE\b|\bRETURNING\b/i.test(head)) return "pg";
  return "other";
}

const isWordStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isWordChar = (c: number): boolean => isWordStart(c) || isDigit(c) || c === 36;
const isSpace = (c: number): boolean => c <= 32 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029 || c === 0x85;

/** 文字列リテラルの中身を解く ('' の重ね・MySQL のバックスラッシュのエスケープ) */
function decodeQuoted(raw: string, quote: string, backslash: boolean): string {
  if (!raw.includes(quote) && !(backslash && raw.includes("\\"))) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === quote && raw[i + 1] === quote) {
      out += quote;
      i++;
    } else if (backslash && c === "\\" && i + 1 < raw.length) {
      const n = raw[++i]!;
      out += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n === "0" ? "\0" : n === "b" ? "\b" : n === "Z" ? "\x1a" : n === "%" || n === "_" ? `\\${n}` : n;
    } else out += c;
  }
  return out;
}

/** text の中の、閉じる引用符の位置 (見つからなければ -1)。start は開く引用符の次。重ね (''・"") は中身とみなす */
function findQuoteEnd(text: string, start: number, quote: string, backslash: boolean): number {
  let i = start;
  const n = text.length;
  if (!backslash) {
    for (;;) {
      const at = text.indexOf(quote, i);
      if (at < 0) return -1;
      if (text[at + 1] === quote) {
        i = at + 2;
        continue;
      }
      return at;
    }
  }
  while (i < n) {
    const c = text[i]!;
    if (c === "\\") i += 2;
    else if (c === quote) {
      if (text[i + 1] === quote) i += 2;
      else return i;
    } else i++;
  }
  return -1;
}

/** text[from, to) の GO が、行の中でほかに何も無い (空白だけ) か */
function isGoLine(text: string, from: number, to: number): boolean {
  for (let k = from - 1; k >= 0; k--) {
    const ch = text.charCodeAt(k);
    if (ch === 10) break;
    if (ch !== 32 && ch !== 9 && ch !== 13) return false;
  }
  for (let k = to; k < text.length; k++) {
    const ch = text.charCodeAt(k);
    if (ch === 10) return true;
    if (ch !== 32 && ch !== 9 && ch !== 13 && ch !== 59) return false;
  }
  return true;
}

/** 文を 1 つずつ切り出して onStatement に渡す */
export function scanStatements(text: string, dialect: Dialect, onStatement: (s: Statement) => void): void {
  const n = text.length;
  const mysql = dialect === "mysql";
  let i = 0;
  // 行番号は位置が増える向きにだけ数える (改行の位置を 1 つ先まで覚えて、毎回 indexOf で末尾まで探さない)
  let lineNo = 1;
  let nextNl = text.indexOf("\n");
  const lineOf = (pos: number): number => {
    while (nextNl >= 0 && nextNl < pos) {
      lineNo++;
      nextNl = text.indexOf("\n", nextNl + 1);
    }
    return lineNo;
  };

  let delim = ";";
  let toks: Tok[] = [];
  let count = 0;
  let collecting = false;
  let stmtLine = 0;
  let truncated = false;
  // CREATE TRIGGER / FUNCTION / PROCEDURE の BEGIN … END の入れ子 (CREATE の文だけ数える)
  let depth = 0;
  let pendingEnd = false;
  let firstU = "";
  let metaFlag = false;

  const finish = (unterminated: boolean) => {
    if (count > 0 || metaFlag) {
      const stmt: Statement = {
        tokens: toks,
        line: stmtLine,
        text,
        full: collecting,
        truncated,
        unterminated,
        meta: metaFlag,
        copyData: false,
        copyUnterminated: false,
      };
      if (!unterminated && firstU === "COPY" && toks.some((t) => t.k === "w" && t.u === "STDIN")) {
        // COPY … FROM stdin; のあとの、\. だけの行までがデータ
        let p = text.indexOf("\n", i);
        let found = false;
        while (p >= 0 && p < n) {
          const ls = p + 1;
          if (text.charCodeAt(ls) === 92 && text.charCodeAt(ls + 1) === 46 && (ls + 2 >= n || text.charCodeAt(ls + 2) === 10 || text.charCodeAt(ls + 2) === 13)) {
            i = ls + 2;
            found = true;
            break;
          }
          p = text.indexOf("\n", ls);
        }
        if (!found) i = n;
        stmt.copyData = true;
        stmt.copyUnterminated = !found;
      }
      onStatement(stmt);
    }
    toks = [];
    count = 0;
    collecting = false;
    truncated = false;
    depth = 0;
    pendingEnd = false;
    firstU = "";
    metaFlag = false;
  };

  const add = (k: TokKind, s: number, e: number, v: string, d?: string, pre?: string) => {
    if (count === 0) {
      stmtLine = lineOf(s);
      if (k === "w") {
        firstU = v.toUpperCase();
        collecting = COLLECT_FIRST.has(firstU);
      } else {
        firstU = "";
        collecting = false;
      }
    }
    count++;
    if (!(collecting || count <= KEEP_PREFIX)) return;
    if (toks.length >= MAX_STATEMENT_TOKENS) {
      truncated = true;
      return;
    }
    const tok: Tok = { k, v, u: k === "w" ? v.toUpperCase() : "", s, e, line: lineOf(s) };
    if (d !== undefined) tok.d = d;
    if (pre !== undefined) tok.pre = pre;
    toks.push(tok);
    if (firstU === "CREATE" && k === "w") {
      const u = tok.u;
      if (pendingEnd) {
        pendingEnd = false;
        if (!(u === "IF" || u === "LOOP" || u === "WHILE" || u === "REPEAT" || u === "FOR")) depth--;
      }
      if (u === "END") pendingEnd = true;
      else if (u === "BEGIN" || u === "CASE") depth++;
    }
  };

  /** CREATE TRIGGER / FUNCTION / PROCEDURE / EVENT か (最初の数トークンで見る) */
  const isRoutine = (): boolean => {
    for (let t = 1; t < Math.min(toks.length, 10); t++) {
      const x = toks[t]!;
      if (x.k !== "w") continue;
      if (x.u === "TABLE" && t <= 4) return false;
      if (x.u === "TRIGGER" || x.u === "FUNCTION" || x.u === "PROCEDURE" || x.u === "EVENT") return true;
    }
    return false;
  };

  /** トークンを作る必要があるか (読み飛ばす文の途中では作らない) */
  const want = (): boolean => collecting || count < KEEP_PREFIX;

  while (i < n) {
    const c = text.charCodeAt(i);
    if (isSpace(c)) {
      i++;
      continue;
    }
    // DELIMITER の変更: 文の先頭で、行末まで
    if (count === 0 && (c === 68 || c === 100) && /^delimiter[ \t]/i.test(text.slice(i, i + 11))) {
      let e = text.indexOf("\n", i);
      if (e < 0) e = n;
      const arg = text.slice(i + 9, e).trim();
      if (arg !== "") delim = arg.length > 16 ? arg.slice(0, 16) : arg;
      // DELIMITER 自体は読み飛ばす文として数える
      add("w", i, i + 9, "DELIMITER");
      finish(false);
      i = e;
      continue;
    }
    if (delim !== ";" && text.startsWith(delim, i)) {
      i += delim.length;
      finish(false);
      continue;
    }
    // コメント
    if (c === 45 && text.charCodeAt(i + 1) === 45) {
      const e = text.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === 35) {
      const e = text.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      // /* … */ (MySQL の /*! … */ も丸ごとコメントとして読み飛ばす)。PostgreSQL は入れ子にできる
      let d = 1;
      let j = i + 2;
      while (j < n && d > 0) {
        const e = text.indexOf("*/", j);
        if (!mysql) {
          const o = text.indexOf("/*", j);
          if (o >= 0 && (e < 0 || o < e)) {
            d++;
            j = o + 2;
            continue;
          }
        }
        if (e < 0) {
          j = n;
          break;
        }
        d--;
        j = e + 2;
      }
      i = j;
      continue;
    }
    // psql のメタコマンド (\connect など)。文の途中でなければ行末まで
    if (c === 92 && count === 0) {
      let e = text.indexOf("\n", i);
      if (e < 0) e = n;
      stmtLine = lineOf(i);
      metaFlag = true;
      finish(false);
      i = e;
      continue;
    }
    // 文の区切り
    if (c === 59 && delim === ";") {
      if (pendingEnd) {
        pendingEnd = false;
        depth--;
      }
      if (firstU === "CREATE" && depth > 0 && isRoutine()) {
        add("p", i, i + 1, ";");
        i++;
        continue;
      }
      i++;
      finish(false);
      continue;
    }
    // 文字列
    if (c === 39 || (c === 34 && mysql)) {
      const q = c === 39 ? "'" : '"';
      const end = findQuoteEnd(text, i + 1, q, mysql);
      const e = end < 0 ? n : end;
      if (want()) add("s", i, Math.min(e + 1, n), decodeQuoted(text.slice(i + 1, e), q, mysql), q);
      else count++;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === 34 || c === 96) {
      const q = c === 34 ? '"' : "`";
      const end = findQuoteEnd(text, i + 1, q, false);
      const e = end < 0 ? n : end;
      if (want()) add("q", i, Math.min(e + 1, n), decodeQuoted(text.slice(i + 1, Math.min(e, i + 1 + 100_000)), q, false), q);
      else count++;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === 91) {
      // [名前] (SQL Server・SQLite)。type[] や ARRAY[…] の [ は識別子にしない
      const prev = i > 0 ? text.charCodeAt(i - 1) : 32;
      if (!(isWordChar(prev) || prev === 93 || prev === 41 || prev === 34 || prev === 96 || prev === 39)) {
        const close = text.indexOf("]", i + 1);
        if (close > i + 1 && close - i < 200) {
          const inner = text.slice(i + 1, close);
          if (!inner.includes("\n") && /^[^\][,()]+$/.test(inner) && !/^\s*\d*\s*$/.test(inner)) {
            if (want()) add("q", i, close + 1, inner, "[");
            else count++;
            i = close + 1;
            continue;
          }
        }
      }
      if (want()) add("p", i, i + 1, "[");
      else count++;
      i++;
      continue;
    }
    // ドル引用 ($$ … $$ / $tag$ … $tag$)
    if (c === 36 && !mysql) {
      let j = i + 1;
      while (j < n && j - i < 64 && (isWordStart(text.charCodeAt(j)) || (j > i + 1 && isDigit(text.charCodeAt(j))))) j++;
      if (text.charCodeAt(j) === 36) {
        const tag = text.slice(i, j + 1);
        const close = text.indexOf(tag, j + 1);
        const e = close < 0 ? n : close;
        if (want()) add("s", i, close < 0 ? n : close + tag.length, text.slice(j + 1, Math.min(e, j + 1 + 100_000)), "$");
        else count++;
        i = close < 0 ? n : close + tag.length;
        continue;
      }
    }
    if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(i + 1)))) {
      let j = i;
      while (j < n && isDigit(text.charCodeAt(j))) j++;
      if (text.charCodeAt(j) === 46) {
        j++;
        while (j < n && isDigit(text.charCodeAt(j))) j++;
      }
      const ex = text.charCodeAt(j);
      if (ex === 101 || ex === 69) {
        let m = j + 1;
        if (text.charCodeAt(m) === 43 || text.charCodeAt(m) === 45) m++;
        if (isDigit(text.charCodeAt(m))) {
          while (m < n && isDigit(text.charCodeAt(m))) m++;
          j = m;
        }
      }
      if (j < n && isWordStart(text.charCodeAt(j))) {
        // 数字で始まる名前 (2fa_enabled など)
        while (j < n && isWordChar(text.charCodeAt(j)) && !(delim !== ";" && text.startsWith(delim, j))) j++;
        if (want()) add("w", i, j, text.slice(i, Math.min(j, i + 1000)));
        else count++;
      } else if (want()) add("n", i, j, text.slice(i, Math.min(j, i + 100)));
      else count++;
      i = j;
      continue;
    }
    if (isWordStart(c) || c === 36) {
      let j = i + 1;
      while (j < n && isWordChar(text.charCodeAt(j)) && !(delim !== ";" && text.startsWith(delim, j))) j++;
      // b'1'・x'ff'・N'…'・E'…' (接頭辞つきの文字列)
      if (j - i === 1 && text.charCodeAt(j) === 39 && "bBxXnNeE".includes(text[i]!)) {
        const pre = text[i]!.toLowerCase();
        const backslash = mysql || pre === "e";
        const end = findQuoteEnd(text, j + 1, "'", backslash);
        const e = end < 0 ? n : end;
        if (want()) add("s", i, Math.min(e + 1, n), decodeQuoted(text.slice(j + 1, e), "'", backslash), "'", pre);
        else count++;
        i = end < 0 ? n : end + 1;
        continue;
      }
      // SQL Server の GO (行に GO だけ) は文の区切り
      if (j - i === 2 && count > 0 && (c === 71 || c === 103) && (text.charCodeAt(i + 1) === 79 || text.charCodeAt(i + 1) === 111) && isGoLine(text, i, j)) {
        i = j;
        finish(false);
        continue;
      }
      if (want()) add("w", i, j, j - i > 1000 ? text.slice(i, i + 1000) : text.slice(i, j));
      else count++;
      i = j;
      continue;
    }
    if (c === 58 && text.charCodeAt(i + 1) === 58) {
      if (want()) add("p", i, i + 2, "::");
      else count++;
      i += 2;
      continue;
    }
    if (want()) add("p", i, i + 1, text[i]!);
    else count++;
    i++;
  }
  finish(count > 0);
}
