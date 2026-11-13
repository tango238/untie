// 「ソースコードから作成」で AI がソースコードを読む道具 (list_files・read_file・search_code)。
// 3 社のプロバイダーに同じ定義を渡す (ToolDef は tools.ts)。実行は SourceTree を通すだけで、モデルは触らない。
// 結果は AI に返す JSON 文字列。上限を超えたら切り詰めて、切り詰めたことと続きの読み方を結果に入れる。
import { MAX_FILE_BYTES, excludeReason, looksBinary, looksPrivateKey, normalizeTreePath, visibleFiles, type SourceFileInfo, type SourceTree } from "./sourceTree";
import type { ToolDef, ToolOutcome } from "./tools";

// ---- 上限 ----

export const SOURCE_LIMITS = {
  /** list_files: 1 回に返す項目の数 (既定と最大) */
  listDefault: 200,
  listMax: 500,
  /** list_files: 降りる深さ (既定と最大) */
  depthDefault: 1,
  depthMax: 4,
  /** read_file: 1 回に返す行数と文字数 */
  readLines: 500,
  readChars: 30000,
  /** search_code: 返す一致の数 (既定と最大)、1 件に載せる行の文字数 */
  searchDefault: 50,
  searchMax: 200,
  searchLineChars: 240,
  /** search_code: 照合する行の長さ (これより長い行は先頭だけ照合する)、照合する文字数の総量、かける時間 (ミリ秒) */
  searchScanLine: 1000,
  /** search_code: 正規表現で照合する行の長さ (遅くなりやすいので、文字列検索より短くする) */
  searchRegexLine: 300,
  /** search_code: 正規表現に書ける、際限のない量指定子 (`*` `+` `{n,}`) の数、量指定子の総数、`|` の数 */
  regexUnbounded: 2,
  regexQuantifiers: 8,
  regexAlternations: 6,
  /** 量指定子が 1 つも無く、`|` がひとつの選択 (グループの中か全体) だけに並ぶ正規表現 (語の言い換えを並べた検索 `a|b|c|…`) の `|` の数 */
  regexFlatAlternations: 30,
  searchScanChars: 20_000_000,
  searchMillis: 4000,
  /** search_code: 検索語の長さ */
  patternChars: 200,
} as const;

export const SOURCE_TOOLS: ToolDef[] = [
  {
    name: "list_files",
    description: `選んだソースコードのフォルダの中身を返す。path は木の根からの相対パス (省略か空で根)。depth (既定 ${SOURCE_LIMITS.depthDefault}、最大 ${SOURCE_LIMITS.depthMax}) まで降りて、フォルダ (末尾 /) とファイル (バイト数) を返す。${SOURCE_LIMITS.listMax} 件までで、超えたら truncated になる (path を絞って呼び直す)。依存・build の成果物・バイナリ・秘密になりうるファイルは出ない。`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "フォルダの相対パス (例: src/routes)。省略で根" },
        depth: { type: "integer", minimum: 1, maximum: SOURCE_LIMITS.depthMax, description: "降りる深さ" },
        limit: { type: "integer", minimum: 1, maximum: SOURCE_LIMITS.listMax, description: "返す項目の数" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: `ファイルの中身を読む。start_line・end_line (1 始まり、end_line を含む) で行を絞れる。1 回に ${SOURCE_LIMITS.readLines} 行・${SOURCE_LIMITS.readChars} 文字までで、超えたら truncated になり、続きを読む nextStartLine を返す。`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "ファイルの相対パス (例: src/routes/orders.ts)" },
        start_line: { type: "integer", minimum: 1, description: "読み始める行" },
        end_line: { type: "integer", minimum: 1, description: "読み終える行 (含む)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_code",
    description: `ソースコードの全体から文字列を探す。regex を true にすると pattern を正規表現として扱う (不正な正規表現や、重くなりうる正規表現 (量指定子の付いたグループ・後方参照・繰り返しの多用) は失敗として返すので、書き直すか文字列検索にする)。glob (例: src/**/*.ts、*.prisma) でファイルを絞れる。1 行ごとに照合する。既定では大文字小文字を区別しない。${SOURCE_LIMITS.searchMax} 件まで (既定 ${SOURCE_LIMITS.searchDefault})。超えたら truncated になる (語や glob を絞る)。`,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: `探す文字列か正規表現 (${SOURCE_LIMITS.patternChars} 文字まで)` },
        regex: { type: "boolean", description: "true で正規表現。省略は文字列" },
        glob: { type: "string", description: "対象のファイルの絞り込み。`/` を含まなければファイル名に、含めばパス全体に当てる。{a,b} も使える" },
        case_sensitive: { type: "boolean", description: "true で大文字小文字を区別する" },
        limit: { type: "integer", minimum: 1, maximum: SOURCE_LIMITS.searchMax, description: "返す一致の数" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
];

const SOURCE_TOOL_NAMES: ReadonlySet<string> = new Set(SOURCE_TOOLS.map((t) => t.name));
export const isSourceTool = (name: string): boolean => SOURCE_TOOL_NAMES.has(name);

// ---- 共通 ----

type Input = Record<string, unknown>;
const okJson = (data: unknown): ToolOutcome => ({ ok: true, content: JSON.stringify(data), changed: false });
const fail = (reason: string): ToolOutcome => ({ ok: false, content: JSON.stringify({ error: reason }), changed: false });
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const int = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;

/** 木が全部ではないときの知らせ (理由ごと)。件数の打ち切りと深さの打ち切りは別 */
function treeNoteFields(tree: SourceTree): Record<string, unknown> {
  const reasons: string[] = [];
  if (tree.truncated) reasons.push("ファイルが多すぎて、件数の上限で読むのをやめたので、一覧は全部ではない");
  if (tree.depthTruncated) reasons.push("深さの上限を超えるフォルダは読んでいないので、その下のファイルは一覧に無い");
  return reasons.length > 0 ? { treeTruncated: true, treeNote: reasons.join("。") } : {};
}

/** 文字列を n 文字までに切る。サロゲートペアの途中では切らない */
const clip = (text: string, n: number): string => {
  if (text.length <= n) return text;
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
};

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** 道具を 1 回実行する。入力はモデルの出力なので、型を確かめてから使う。木の外・除外対象のパスは「ありません」と同じ扱いにする */
export async function executeSourceTool(tree: SourceTree, name: string, rawInput: unknown): Promise<ToolOutcome> {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Input;
  try {
    switch (name) {
      case "list_files":
        return listFiles(tree, input);
      case "read_file":
        return await readFile(tree, input);
      case "search_code":
        return await searchCode(tree, input);
      default:
        return fail(`不明な道具です: ${name}`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ---- list_files ----

function listFiles(tree: SourceTree, input: Input): ToolOutcome {
  const normalized = normalizeTreePath(str(input.path) ?? "");
  if (!normalized.ok) return fail(normalized.reason);
  const dir = normalized.path;
  const depth = int(input.depth, SOURCE_LIMITS.depthDefault, 1, SOURCE_LIMITS.depthMax);
  const limit = int(input.limit, SOURCE_LIMITS.listDefault, 1, SOURCE_LIMITS.listMax);
  const prefix = dir === "" ? "" : `${dir}/`;
  const inside = visibleFiles(tree).filter((f) => f.path.startsWith(prefix));
  if (dir !== "" && inside.length === 0) {
    const isFile = tree.files.some((f) => f.path === dir && excludeReason(f.path, f.size) === null);
    return fail(isFile ? `${dir} はファイルです (read_file で読んでください)` : `フォルダがありません: ${dir}`);
  }
  // フォルダ (depth までの途中も含む) は、その下のファイルの数と一緒に出す
  const dirs = new Map<string, number>();
  const files: SourceFileInfo[] = [];
  for (const f of inside) {
    const rel = f.path.slice(prefix.length).split("/");
    if (rel.length <= depth) files.push(f);
    for (let i = 1; i <= Math.min(rel.length - 1, depth); i++) {
      const d = `${prefix}${rel.slice(0, i).join("/")}`;
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
  }
  // 浅い階層から順に並べ、limit で切るときも、その階層のファイルがフォルダに押し出されて全部落ちないようにする
  const levelOf = (p: string) => p.slice(prefix.length).replace(/\/$/, "").split("/").length;
  const dirEntries = [...dirs.keys()].sort().map((d) => ({ path: `${d}/`, files: dirs.get(d)! }));
  const fileEntries = files.sort(byPath).map((f) => ({ path: f.path, bytes: f.size }));
  const entries: ({ path: string; files: number } | { path: string; bytes: number })[] = [];
  const shown: typeof entries = [];
  for (let level = 1; level <= depth; level++) {
    const ds = dirEntries.filter((e) => levelOf(e.path) === level);
    const fs = fileEntries.filter((e) => levelOf(e.path) === level);
    const room = limit - shown.length;
    entries.push(...ds, ...fs);
    if (room <= 0) continue;
    if (ds.length + fs.length <= room) shown.push(...ds, ...fs);
    else {
      const fileQuota = Math.min(fs.length, Math.max(Math.ceil(room / 2), room - ds.length));
      shown.push(...ds.slice(0, room - fileQuota), ...fs.slice(0, fileQuota));
    }
  }
  const truncated = entries.length > shown.length;
  return okJson({
    path: dir === "" ? "." : dir,
    depth,
    total: entries.length,
    entries: shown,
    ...(truncated ? { truncated: true, note: `${entries.length} 件のうち ${shown.length} 件だけ返した。path を絞るか limit を増やして、見たいフォルダを呼び直す` } : {}),
    ...treeNoteFields(tree),
  });
}

// ---- read_file ----

async function readVisible(tree: SourceTree, path: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const info = tree.files.find((f) => f.path === path);
  // 除外対象・木に無いものは、存在を知らせない (秘密のファイル名を確かめさせない)
  if (!info || excludeReason(info.path, info.size) !== null) return { ok: false, reason: `ファイルがありません (または読めない種類です): ${path}` };
  const text = await tree.readFile(path);
  // 木の実装が大きさを確かめ損ねても、ここで断る (文字数は UTF-8 のバイト数以下なので、超えていれば確実に巨大)
  if (text.length > MAX_FILE_BYTES) return { ok: false, reason: `ファイルが大きすぎます: ${path}` };
  if (looksBinary(text)) return { ok: false, reason: `バイナリのファイルは読めません: ${path}` };
  // 名前で分からない秘密鍵は、存在を知らせずに断る
  if (looksPrivateKey(text)) return { ok: false, reason: `ファイルがありません (または読めない種類です): ${path}` };
  return { ok: true, text };
}

async function readFile(tree: SourceTree, input: Input): Promise<ToolOutcome> {
  const raw = str(input.path);
  if (!raw) return fail("path が必要です");
  const normalized = normalizeTreePath(raw);
  if (!normalized.ok) return fail(normalized.reason);
  const read = await readVisible(tree, normalized.path);
  if (!read.ok) return fail(read.reason);
  const lines = read.text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const start = int(input.start_line, 1, 1, Number.MAX_SAFE_INTEGER);
  const wantedEnd = int(input.end_line, total, 1, Number.MAX_SAFE_INTEGER);
  if (start > total) return fail(`${normalized.path} は ${total} 行です (start_line=${start} は範囲の外)`);
  if (wantedEnd < start) return fail("end_line は start_line 以上にしてください");
  const end = Math.min(wantedEnd, total, start + SOURCE_LIMITS.readLines - 1);
  // 文字数の上限は、行の切れ目で切る (1 行だけで超えるときはその行の先頭を返す)
  const picked: string[] = [];
  let chars = 0;
  let cutInLine = false;
  let omittedChars = 0;
  for (let i = start - 1; i < end; i++) {
    const line = lines[i]!;
    if (chars + line.length + 1 > SOURCE_LIMITS.readChars) {
      if (picked.length === 0) {
        const head = clip(line, SOURCE_LIMITS.readChars);
        picked.push(head);
        cutInLine = true;
        omittedChars = line.length - head.length;
      }
      break;
    }
    picked.push(line);
    chars += line.length + 1;
  }
  const lastLine = start + picked.length - 1;
  const truncated = cutInLine || (lastLine < wantedEnd && lastLine < total);
  return okJson({
    path: normalized.path,
    startLine: start,
    endLine: lastLine,
    totalLines: total,
    content: picked.join("\n"),
    ...(truncated
      ? {
          truncated: true,
          ...(lastLine < total ? { nextStartLine: lastLine + 1 } : {}),
          note: `${total} 行のうち ${start}〜${lastLine} 行を返した。${lastLine < total ? `続きは start_line=${lastLine + 1} で読む` : "これで最後の行"}${cutInLine ? ` (行 ${start} は 1 行が長すぎて、先頭の ${picked[0]!.length} 文字だけ返した。その行の残り ${omittedChars} 文字は read_file では読めない。必要なら search_code で近くを探す)` : ""}`,
          ...(cutInLine ? { omittedChars } : {}),
        }
      : {}),
  });
}

// ---- search_code ----

/** glob を正規表現にする (`**`・`*`・`?`・`{a,b}`)。`/` を含まなければファイル名に、含めばパス全体に当てる */
export function globMatcher(glob: string): (path: string) => boolean {
  const g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "";
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) re += "|";
    else re += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  re += ")".repeat(braces);
  const matcher = new RegExp(`^${re}$`, "i");
  const wholePath = g.includes("/");
  return (path) => matcher.test(wholePath ? path : (path.split("/").pop() ?? path));
}

/**
 * 正規表現を実行してよいか調べる。実行するのは「安全な部分集合」だけ。断るときは書き直し方を返し、通すときは null。
 * 断るもの: 量指定子 (`*` `+` `?` `{…}`) の付いたグループ・後方参照 (`\1`・`\k<名>`)・際限のない量指定子 (`*` `+` `{n,}`) が多すぎるもの・量指定子や `|` の使いすぎ (量指定子が無く、選択がひとつだけの `a|b|c|…` は 30 個まで)。
 * 通すもの: 名前付きグループ・非捕捉グループ・先読み/後読み (量指定子が付かないもの)、文字クラス、数の少ない量指定子。
 * 文法エラーは new RegExp で先に見つけている前提
 */
export function regexRefusal(pattern: string): string | null {
  const hint = "量指定子の付いたグループ (…)* や (…)+ は使わず、文字クラスや単純な繰り返しに書き直すか、regex を付けずに文字列検索を使ってください";
  let unbounded = 0;
  let quantifiers = 0;
  let alternations = 0;
  let afterGroup = false; // 直前が「閉じたグループ」
  let afterQuantifier = false; // 直前が量指定子 (次の `?` は遅延の印)
  // `|` を持つ選択がいくつあるか (全体は 0、グループは開いた順の番号)。`(a|a)(a|a)…` のように選択が並ぶと、組み合わせが掛け算で増える
  const groupStack: number[] = [0];
  let groupCount = 0;
  const alternationGroups = new Set<number>();
  const n = pattern.length;
  const quantifierAt = (i: number): { len: number; unbounded: boolean } | null => {
    const c = pattern[i];
    if (c === "*" || c === "+") return { len: 1, unbounded: true };
    if (c === "?") return { len: 1, unbounded: false };
    if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i, i + 24));
      if (!m) return null;
      const variable = m[2] !== undefined && m[3] !== m[1];
      return { len: m[0].length, unbounded: variable };
    }
    return null;
  };
  for (let i = 0; i < n; ) {
    const c = pattern[i]!;
    const q = afterQuantifier && c === "?" ? null : quantifierAt(i);
    if (q) {
      if (afterGroup) return `量指定子の付いたグループは使えません (${pattern.slice(Math.max(0, i - 8), i + q.len)} の付近)。${hint}`;
      quantifiers++;
      if (q.unbounded) unbounded++;
      i += q.len;
      afterQuantifier = true;
      afterGroup = false;
      continue;
    }
    afterQuantifier = false;
    afterGroup = false;
    if (c === "\\") {
      const next = pattern[i + 1] ?? "";
      if (/[1-9]/.test(next) || (next === "k" && pattern[i + 2] === "<")) return "後方参照 (\\1 や \\k<名前>) は使えません。後方参照を使わない書き方にするか、文字列検索を使ってください";
      i += 2;
      continue;
    }
    if (c === "[") {
      i++;
      while (i < n && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "(") {
      // (?: (?= (?! (?<= (?<! (?<名前> の「?」は量指定子ではない
      const prefix = /^\?(?::|=|!|<=|<!|<[^>]*>)/.exec(pattern.slice(i + 1));
      i += 1 + (prefix ? prefix[0].length : 0);
      groupStack.push(++groupCount);
      continue;
    }
    if (c === ")") {
      afterGroup = true;
      if (groupStack.length > 1) groupStack.pop();
    } else if (c === "|") {
      alternations++;
      alternationGroups.add(groupStack[groupStack.length - 1]!);
    }
    i++;
  }
  if (unbounded > SOURCE_LIMITS.regexUnbounded) return `際限のない繰り返し (* + {n,}) が ${unbounded} 個あります (${SOURCE_LIMITS.regexUnbounded} 個まで)。繰り返しを減らすか、文字列検索を使ってください`;
  if (quantifiers > SOURCE_LIMITS.regexQuantifiers) return `量指定子が ${quantifiers} 個あります (${SOURCE_LIMITS.regexQuantifiers} 個まで)。パターンを短くするか、文字列検索を使ってください`;
  // 量指定子が無く、選択がひとつだけなら、行の長さに比例して終わる (各位置で語を 1 つずつ試すだけ) ので、`|` を多めに許す
  const flat = quantifiers === 0 && alternationGroups.size <= 1;
  const alternationMax = flat ? SOURCE_LIMITS.regexFlatAlternations : SOURCE_LIMITS.regexAlternations;
  if (alternations > alternationMax) {
    return `「|」が ${alternations} 個あります (${alternationMax} 個まで${flat ? "" : `。量指定子が無く、選択がひとつだけなら ${SOURCE_LIMITS.regexFlatAlternations} 個まで`})。検索を分けて呼ぶか、文字列検索を使ってください`;
  }
  return null;
}

async function searchCode(tree: SourceTree, input: Input): Promise<ToolOutcome> {
  const pattern = str(input.pattern);
  if (!pattern) return fail("pattern が必要です");
  if (pattern.length > SOURCE_LIMITS.patternChars) return fail(`pattern は ${SOURCE_LIMITS.patternChars} 文字までです`);
  const caseSensitive = input.case_sensitive === true;
  const limit = int(input.limit, SOURCE_LIMITS.searchDefault, 1, SOURCE_LIMITS.searchMax);
  const notes: string[] = [];

  let test: (line: string) => boolean;
  const isRegex = input.regex === true;
  if (isRegex) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, caseSensitive ? "" : "i");
    } catch (e) {
      return fail(`pattern を正規表現として読めませんでした (${e instanceof Error ? e.message : String(e)})。書き直すか、regex を付けずに文字列検索にしてください`);
    }
    // 重い正規表現は黙って別の検索にせず、書き直し方を返す
    const refusal = regexRefusal(pattern);
    if (refusal) return fail(`この正規表現は実行できません: ${refusal}`);
    test = (line) => re.test(line);
  } else {
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    test = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
  }
  const scanLine = isRegex ? SOURCE_LIMITS.searchRegexLine : SOURCE_LIMITS.searchScanLine;
  let clippedLines = false;

  let inGlob: (path: string) => boolean = () => true;
  const globText = str(input.glob);
  if (globText && globText.trim() !== "") {
    try {
      inGlob = globMatcher(globText);
    } catch {
      return fail(`glob を読めませんでした: ${globText}`);
    }
  }

  const candidates = visibleFiles(tree).filter((f) => inGlob(f.path)).sort(byPath);
  const matches: { path: string; line: number; text: string }[] = [];
  const started = Date.now();
  let scannedChars = 0;
  let scannedFiles = 0;
  let examined = 0;
  let stopped: string | null = null;
  let more = false;
  outer: for (const f of candidates) {
    if (Date.now() - started > SOURCE_LIMITS.searchMillis) {
      stopped = "時間の上限に達したので、途中で打ち切った";
      break;
    }
    if (scannedChars > SOURCE_LIMITS.searchScanChars) {
      stopped = "照合した量の上限に達したので、途中で打ち切った";
      break;
    }
    examined++;
    let text: string;
    try {
      text = await tree.readFile(f.path);
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES || looksBinary(text) || looksPrivateKey(text)) continue;
    scannedFiles++;
    scannedChars += text.length;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > scanLine) clippedLines = true;
      // 1 つの行で時間を使い切ることもあるので、時間は行ごとに見る
      if (i % 16 === 15 && Date.now() - started > SOURCE_LIMITS.searchMillis) {
        stopped = "時間の上限に達したので、途中で打ち切った";
        break outer;
      }
      if (!test(line.length > scanLine ? clip(line, scanLine) : line)) continue;
      if (matches.length >= limit) {
        more = true;
        break outer;
      }
      const trimmed = line.trim();
      matches.push({
        path: f.path,
        line: i + 1,
        text: trimmed.length > SOURCE_LIMITS.searchLineChars ? `${clip(trimmed, SOURCE_LIMITS.searchLineChars)}…` : trimmed,
      });
    }
  }
  const truncated = more || stopped !== null;
  if (more) notes.push(`一致が ${limit} 件を超えたので、先頭の ${limit} 件だけ返した。語を具体的にするか glob で絞って呼び直す`);
  if (stopped) notes.push(stopped);
  if (truncated) notes.push(`対象 ${candidates.length} ファイルのうち、先頭から ${examined} 個目まで探した`);
  if (isRegex && clippedLines) notes.push(`正規表現は各行の先頭 ${scanLine} 文字だけ照合した`);
  return okJson({
    pattern,
    mode: isRegex ? "regex" : "literal",
    searchedFiles: scannedFiles,
    candidateFiles: candidates.length,
    ...(truncated ? { examinedFiles: examined } : {}),
    matches,
    ...(truncated ? { truncated: true } : {}),
    ...treeNoteFields(tree),
    ...(notes.length > 0 ? { note: notes.join("。") } : {}),
  });
}
