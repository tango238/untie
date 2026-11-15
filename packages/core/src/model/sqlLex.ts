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

export type Dialect = "pg" | "mysql" | "sqlite" | "mssql" | "other";

/** 1 つの文で集めるトークンの上限 (超えたら捨てる) */
export const MAX_STATEMENT_TOKENS = 300_000;

/** 中身を読む文の最初の単語。これ以外の文は先頭の数個のトークンだけ持つ */
const COLLECT_FIRST = new Set(["CREATE", "ALTER", "DROP", "COMMENT", "RENAME", "COPY"]);
const KEEP_PREFIX = 6;

/** 閉じない文字列を読み直す回数の上限 (入力全体で) */
const MAX_REREADS = 50;
/** この長さを超える文字列は、エスケープの扱いが違うのかもしれないと疑う (CREATE・ALTER などの文だけ) */
const LONG_STRING = 1_000_000;
/** 読み直したときの、別の読み方での文字列の長さの上限 (これより短く閉じるときだけ読み直す) */
const REREAD_SHORT = 100_000;

interface DetectInput {
  /** コメントの先頭の部分 (ヘッダーの目印を探す) */
  comments: string;
  /** コメントと文字列の中身を除いた本文 */
  body: string;
  backtick: boolean;
  mysqlConditional: boolean;
  dollar: boolean;
}

/** 方言の推定のために、コメントと文字列を除く (標準の読み方で。1 回の走査) */
function stripForDetect(head: string): DetectInput {
  const n = head.length;
  const parts: string[] = [];
  let comments = "";
  let backtick = false;
  let mysqlConditional = false;
  let dollar = false;
  let seg = 0;
  let i = 0;
  const cut = (to: number, fill: string, next: number) => {
    if (to > seg) parts.push(head.slice(seg, to));
    parts.push(fill);
    seg = next;
    i = next;
  };
  while (i < n) {
    const c = head.charCodeAt(i);
    if (c === 45 && head.charCodeAt(i + 1) === 45) {
      let e = head.indexOf("\n", i);
      if (e < 0) e = n;
      if (comments.length < 20_000) comments += `${head.slice(i, Math.min(e, i + 300))}\n`;
      cut(i, " ", e);
    } else if (c === 47 && head.charCodeAt(i + 1) === 42) {
      const e = head.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      if (head.charCodeAt(i + 2) === 33 && isDigit(head.charCodeAt(i + 3))) mysqlConditional = true;
      if (comments.length < 20_000) comments += `${head.slice(i, Math.min(end, i + 300))}\n`;
      cut(i, " ", end);
    } else if (c === 39) {
      let j = i + 1;
      for (;;) {
        const at = head.indexOf("'", j);
        if (at < 0) {
          j = n;
          break;
        }
        if (head.charCodeAt(at + 1) === 39) {
          j = at + 2;
          continue;
        }
        j = at + 1;
        break;
      }
      cut(i, " '' ", j);
    } else if (c === 34 || c === 96) {
      if (c === 96) backtick = true;
      const e = head.indexOf(c === 34 ? '"' : "`", i + 1);
      const end = e < 0 ? n : e + 1;
      cut(i, c === 34 ? ' "q" ' : " `q` ", end);
    } else if (c === 36) {
      let j = i + 1;
      while (j < n && j - i < 64 && (isWordStart(head.charCodeAt(j)) || (j > i + 1 && isDigit(head.charCodeAt(j))))) j++;
      if (head.charCodeAt(j) === 36) {
        const tag = head.slice(i, j + 1);
        const close = head.indexOf(tag, j + 1);
        if (close >= 0) {
          dollar = true;
          cut(i, " '' ", close + tag.length);
          continue;
        }
      }
      i++;
    } else i++;
  }
  if (seg < n) parts.push(head.slice(seg));
  return { comments, body: parts.join(""), backtick, mysqlConditional, dollar };
}

/**
 * 方言を推定する。字句解析 (バックスラッシュ・" の扱い・ドル引用・# と入れ子のコメント) と、型の対応・引用符なしの名前の大文字小文字に使う。
 * コメントと文字列の中を除いた部分の目印と、ダンプのヘッダーに重みを付けて数え、いちばん点の高い方言にする (低すぎれば other)。
 */
export function detectDialect(text: string): Dialect {
  const head = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  const d = stripForDetect(head);
  const score = { pg: 0, mysql: 0, sqlite: 0, mssql: 0 };
  const hit = (re: RegExp, s: string, kind: keyof typeof score, w: number) => {
    if (re.test(s)) score[kind] += w;
  };
  const cm = d.comments;
  hit(/PostgreSQL database dump|\bpg_dump\b/i, cm, "pg", 100);
  hit(/MySQL dump|\bmysqldump\b|MariaDB dump/i, cm, "mysql", 100);
  hit(/\bsqlite3?\b/i, cm, "sqlite", 10);
  hit(/Script Date:|SQL Server Management Studio/i, cm, "mssql", 10);
  const b = d.body;
  if (d.backtick) score.mysql += 5;
  if (d.mysqlConditional) score.mysql += 8;
  if (d.dollar) score.pg += 3;
  hit(/\bAUTO_INCREMENT\b/i, b, "mysql", 5);
  hit(/\bENGINE\s*=/i, b, "mysql", 5);
  hit(/\bDELIMITER\s/i, b, "mysql", 5);
  hit(/\bLOCK\s+TABLES\b/i, b, "mysql", 4);
  hit(/\bUNSIGNED\b/i, b, "mysql", 3);
  hit(/\bUNIQUE\s+KEY\b/i, b, "mysql", 3);
  hit(/\b(?:TINY|MEDIUM|LONG)(?:INT|TEXT|BLOB)\b/i, b, "mysql", 3);
  hit(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b/i, b, "mysql", 3);
  hit(/\bCHARSET\b|\bCHARACTER\s+SET\b/i, b, "mysql", 1);
  hit(/\bAUTOINCREMENT\b/i, b, "sqlite", 8);
  hit(/\bWITHOUT\s+ROWID\b/i, b, "sqlite", 8);
  hit(/\bsqlite_(?:sequence|master|schema)\b/i, b, "sqlite", 8);
  hit(/\bPRAGMA\b/i, b, "sqlite", 8);
  hit(/::/, b, "pg", 3);
  hit(/\bpg_catalog\b/i, b, "pg", 5);
  hit(/\bCREATE\s+EXTENSION\b/i, b, "pg", 4);
  hit(/\bnextval\s*\(/i, b, "pg", 4);
  hit(/\b(?:BIG|SMALL)?SERIAL\b/i, b, "pg", 3);
  hit(/\bTIMESTAMPTZ\b|\bTIMESTAMP\s+WITH(?:OUT)?\s+TIME\s+ZONE\b/i, b, "pg", 3);
  hit(/\bRETURNING\b/i, b, "pg", 2);
  hit(/\bALTER\s+TABLE\s+ONLY\b/i, b, "pg", 4);
  hit(/\bOWNER\s+TO\b/i, b, "pg", 3);
  hit(/\bFROM\s+stdin\b/i, b, "pg", 4);
  hit(/\bgen_random_uuid\s*\(/i, b, "pg", 3);
  hit(/\b(?:JSONB|BYTEA)\b/i, b, "pg", 2);
  hit(/\bCREATE\s+TYPE\s+\S+\s+AS\s+ENUM\b/i, b, "pg", 2);
  hit(/\[dbo\]/i, b, "mssql", 6);
  hit(/^[ \t]*GO[ \t;]*$/im, b, "mssql", 5);
  hit(/\bIDENTITY\s*\(\s*\d/i, b, "mssql", 4);
  hit(/\bSET\s+ANSI_NULLS\b/i, b, "mssql", 6);
  hit(/\b(?:NON)?CLUSTERED\b/i, b, "mssql", 4);
  hit(/\b(?:N?VARCHAR|NCHAR)\s*\(\s*MAX\s*\)/i, b, "mssql", 3);
  hit(/\b(?:UNIQUEIDENTIFIER|DATETIME2)\b/i, b, "mssql", 2);
  // 同点のときは sqlite > mysql > pg > mssql の順 (以前の判定の優先順)
  const order: (keyof typeof score)[] = ["sqlite", "mysql", "pg", "mssql"];
  let best: keyof typeof score | "" = "";
  let bestScore = 1;
  for (const k of order) {
    if (score[k] > bestScore) {
      best = k;
      bestScore = score[k];
    }
  }
  return best === "" ? "other" : best;
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

export interface ScanResult {
  /** 閉じない文字列のために、エスケープの扱いを変えて読み直した文の行 (1 始まり) */
  rereads: number[];
}

/** 文を 1 つずつ切り出して onStatement に渡す */
export function scanStatements(text: string, dialect: Dialect, onStatement: (s: Statement) => void): ScanResult {
  const n = text.length;
  const mysql = dialect === "mysql";
  // 方言で変わる字句: " を文字列にするか・# のコメント・入れ子のコメント・ドル引用・引用符なしの名前の小文字化
  const dqString = mysql;
  const hashComment = mysql;
  const nestedComments = dialect === "pg";
  const dollarQuote = !mysql;
  const lowerWords = dialect === "pg";
  /** 文字列のバックスラッシュをエスケープとして読むか (方言で決めるが、閉じない文字列があれば読み直して変える) */
  let backslash = mysql;
  let nestedBroken = false;
  const rereads: number[] = [];
  /** 読み直したことがある文の先頭の位置 (同じ文を読み直すのは 1 回だけ) */
  let retriedAt = -1;
  /** 読み直して確かめている途中の文の先頭の位置 (文が終わるまで、また閉じない文字列が出なければ読み直しを採る) と、読み直す前の読み方・行 */
  let verifying = -1;
  let verifyOriginal = false;
  let verifyLine = 0;
  let i = 0;
  // 行番号は位置が増える向きにだけ数える (改行の位置を 1 つ先まで覚えて、毎回 indexOf で末尾まで探さない)。読み直しのときだけ戻す
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
  let stmtStart = 0;
  let snapLine = 1;
  let snapNl = nextNl;
  let truncated = false;
  // CREATE TRIGGER / FUNCTION / PROCEDURE の BEGIN … END の入れ子 (CREATE の文だけ数える)
  let depth = 0;
  let pendingEnd = false;
  let firstU = "";
  let metaFlag = false;
  // 文の中のかっこの深さ (CREATE TABLE のかっこの中の go を GO の区切りにしない)
  let parenDepth = 0;

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
    // 読み直した文が最後まで読めたら、読み直しを採る (以降もこの読み方)
    if (verifying >= 0) {
      rereads.push(verifyLine);
      verifying = -1;
    }
    resetStatement();
  };

  const resetStatement = () => {
    toks = [];
    count = 0;
    collecting = false;
    truncated = false;
    depth = 0;
    pendingEnd = false;
    firstU = "";
    metaFlag = false;
    parenDepth = 0;
  };

  const add = (k: TokKind, s: number, e: number, v: string, d?: string, pre?: string) => {
    if (count === 0) {
      stmtLine = lineOf(s);
      stmtStart = s;
      snapLine = lineNo;
      snapNl = nextNl;
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

  /**
   * 文字列が閉じないまま終わりまで (CREATE・ALTER などの文では、極端に長く) 続くとき、エスケープの扱いを変えて、その文の先頭から読み直す
   * (エスケープの扱いの推定が外れたとき、残り全部が文字列に飲まれないようにする)。
   * 閉じないときは、変えた読み方でその文が最後まで読めるか確かめ (確かめている間は verifying)、また閉じない文字列が出たら元の読み方に戻す。
   * 極端に長い (が閉じる) ときは、変えた読み方のほうが短く閉じるときだけ。読み直すときは true (i を文の先頭に戻してある)
   */
  const tryReread = (strStart: number, end: number, q: string): boolean => {
    const startPos = count === 0 ? strStart : stmtStart;
    if (verifying === startPos) {
      // 変えた読み方でも閉じない: 元に戻して、もう読み直さない
      backslash = verifyOriginal;
      verifying = -1;
      restartAt(startPos);
      return true;
    }
    if (rereads.length >= MAX_REREADS || retriedAt === startPos) return false;
    if (end >= 0) {
      const long = end - strStart > LONG_STRING && (count === 0 || collecting);
      if (!long) return false;
      const alt = findQuoteEnd(text, strStart + 1, q, !backslash);
      if (alt < 0 || alt >= end || alt - strStart > REREAD_SHORT) return false;
    }
    retriedAt = startPos;
    verifying = startPos;
    verifyOriginal = backslash;
    verifyLine = count === 0 ? lineOf(strStart) : stmtLine;
    backslash = !backslash;
    restartAt(startPos);
    return true;
  };

  /** 文の外の GO の行を読み飛ばす (読み飛ばした文として数えるため、GO だけの文にする) */
  const cleanGo = () => {
    add("w", i - 2, i, "GO");
    finish(false);
  };

  /** 文を先頭から読み直す */
  const restartAt = (startPos: number) => {
    if (count > 0) {
      lineNo = snapLine;
      nextNl = snapNl;
    }
    resetStatement();
    i = startPos;
  };

  /** /* から始まるコメントの終わりの次の位置。PostgreSQL は入れ子にできる (閉じないときは入れ子なしで読み直す) */
  const blockCommentEnd = (from: number): number => {
    const start = from + 2;
    if (nestedComments && !nestedBroken) {
      let d = 1;
      let j = start;
      let e = text.indexOf("*/", j);
      let o = text.indexOf("/*", j);
      while (e >= 0) {
        if (o >= 0 && o < e) {
          d++;
          j = o + 2;
          o = text.indexOf("/*", j);
          if (e < j) e = text.indexOf("*/", j);
        } else {
          d--;
          j = e + 2;
          if (d === 0) return j;
          e = text.indexOf("*/", j);
          if (o >= 0 && o < j) o = text.indexOf("/*", j);
        }
      }
      // 入れ子を数えると閉じない: このファイルの /* */ は入れ子にしないとみなす
      nestedBroken = true;
    }
    const e = text.indexOf("*/", start);
    return e < 0 ? n : e + 2;
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
    if (c === 35 && hashComment) {
      const e = text.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      // /* … */ (MySQL の /*! … */ も丸ごとコメントとして読み飛ばす)
      i = blockCommentEnd(i);
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
    if (c === 39 || (c === 34 && dqString)) {
      const q = c === 39 ? "'" : '"';
      const end = findQuoteEnd(text, i + 1, q, backslash);
      if ((end < 0 || end - i > LONG_STRING) && tryReread(i, end, q)) continue;
      const e = end < 0 ? n : end;
      if (want()) add("s", i, Math.min(e + 1, n), decodeQuoted(text.slice(i + 1, e), q, backslash), q);
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
        // 閉じる ] を探す。改行・[ ・, ・( ・) が先に出るか、200 文字先までに無ければ名前ではない (探す範囲を限るので線形)
        let close = -1;
        const lim = Math.min(n, i + 200);
        for (let k = i + 1; k < lim; k++) {
          const ch = text.charCodeAt(k);
          if (ch === 93) {
            close = k;
            break;
          }
          if (ch === 10 || ch === 91 || ch === 44 || ch === 40 || ch === 41) break;
        }
        if (close > i + 1) {
          const inner = text.slice(i + 1, close);
          if (!/^\s*\d*\s*$/.test(inner)) {
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
    if (c === 36 && dollarQuote) {
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
        if (want()) add("w", i, j, lowerWords ? text.slice(i, Math.min(j, i + 1000)).toLowerCase() : text.slice(i, Math.min(j, i + 1000)));
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
        const bs = pre === "e" || (backslash && pre !== "b" && pre !== "x");
        const end = findQuoteEnd(text, j + 1, "'", bs);
        const e = end < 0 ? n : end;
        if (want()) add("s", i, Math.min(e + 1, n), decodeQuoted(text.slice(j + 1, e), "'", bs), "'", pre);
        else count++;
        i = end < 0 ? n : end + 1;
        continue;
      }
      // SQL Server の GO (行に GO だけ。かっこの外) は文の区切り
      if (j - i === 2 && parenDepth === 0 && (c === 71 || c === 103) && (text.charCodeAt(i + 1) === 79 || text.charCodeAt(i + 1) === 111) && isGoLine(text, i, j)) {
        i = j;
        if (count > 0) finish(false);
        else cleanGo();
        continue;
      }
      if (want()) {
        const w = j - i > 1000 ? text.slice(i, i + 1000) : text.slice(i, j);
        add("w", i, j, lowerWords ? w.toLowerCase() : w);
      } else count++;
      i = j;
      continue;
    }
    if (c === 58 && text.charCodeAt(i + 1) === 58) {
      if (want()) add("p", i, i + 2, "::");
      else count++;
      i += 2;
      continue;
    }
    if (c === 40) parenDepth++;
    else if (c === 41 && parenDepth > 0) parenDepth--;
    if (want()) add("p", i, i + 1, text[i]!);
    else count++;
    i++;
  }
  finish(count > 0);
  return { rereads };
}
