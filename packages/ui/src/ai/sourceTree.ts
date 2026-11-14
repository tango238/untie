// 「ソースコードから作成」で AI に読ませるソースコードの木 (読み取り専用)。
// 実体はブラウザで選んだフォルダ (io/sourceFolder.ts) かメモリ上の木 (テスト用)。AI に渡すのは、道具 (sourceTools.ts) が求めた範囲だけ。
// 秘密になりうるファイル・バイナリ・巨大ファイル・生成物のフォルダは、一覧にも検索にも読み取りにも出さない (このファイルの除外規則)。

export interface SourceFileInfo {
  /** 木の中の相対パス (`/` 区切り。先頭に `/` や `./` は付かない) */
  path: string;
  /** バイト数 */
  size: number;
}

export interface SourceTree {
  /** 選んだフォルダの名前 */
  name: string;
  /** 読めるファイルの一覧 (除外規則に当たるものは入れない)。並びは問わない */
  files: readonly SourceFileInfo[];
  /** 件数の上限で打ち切って、一覧が全部ではないとき true */
  truncated?: boolean;
  /** 深さの上限を超えるフォルダ (の下のファイル) を読まずに飛ばしたとき true (件数の打ち切りとは別。ほかの枝は読んである) */
  depthTruncated?: boolean;
  /** ファイルの中身を UTF-8 の文字列で読む。一覧に無いパスは Error */
  readFile(path: string): Promise<string>;
  /**
   * ラベル付きの複数のソースをまとめた木 (combineSourceTrees) のとき、ソースごとの内訳。ソースが 1 つなら 1 件 (ラベルは AI への説明にだけ使う)。
   * 普通の木では無い
   */
  sources?: readonly SourceSummary[];
  /**
   * 除外規則の当て方を差し替える (まとめた木が、ラベルを除いたもとのソースの中のパスで判定するため)。
   * 省略した木は、木の中のパスにそのまま excludeReason を当てる。道具 (sourceTools.ts) は直に excludeReason を呼ばず、treeExcludeReason を使う
   */
  excludeReasonOf?(path: string, size?: number): ExcludeReason | null;
  /** 同じフォルダを指す木か (ブラウザの isSameEntry で確かめられるとき)。確かめられなければ null (io/sourceFolder.ts) */
  sameFolderAs?(other: SourceTree): Promise<boolean | null>;
}

/** まとめた木の中の 1 つのソース (サマリー) */
export interface SourceSummary {
  /** ラベル (まとめた木では最上位のフォルダの名前。ソースが 1 つのときは AI への説明にだけ使う。空なら無し) */
  label: string;
  /** 選んだフォルダの名前 */
  folder: string;
  /** まとめた木に入れた、読めるファイルの数 (件数の上限で減らした後) */
  fileCount: number;
  /** もとのソースが、たどる時点で件数の上限で打ち切られていた (件数を分け合って減らしたことは trimmed で別に持つ) */
  truncated: boolean;
  /** もとのソースが深さの上限で一部の枝を飛ばしていた */
  depthTruncated: boolean;
  /** まとめるときの件数の上限で、このソースから減らしたファイルの数 (0 なら減らしていない) */
  trimmed: number;
}

/** ラベルを付けたソース (まとめる前) */
export interface LabeledSource {
  label: string;
  tree: SourceTree;
}

// ---- 上限 ----

/** これを超えるファイルは「巨大」として出さない (バイト) */
export const MAX_FILE_BYTES = 512 * 1024;
/** 木に入れるファイルの数の上限 (これを超えたら打ち切って truncated にする) */
export const MAX_TREE_FILES = 20000;
/** 木をたどる深さの上限 */
export const MAX_TREE_DEPTH = 24;
/** 1 回に登録できるソース (ラベル付きのフォルダ) の数 */
export const MAX_SOURCES = 8;
/** ソースのラベルの長さの上限 (文字) */
export const MAX_SOURCE_LABEL_CHARS = 40;

// ---- 除外規則 ----

export type ExcludeReason = "folder" | "secret" | "binary" | "generated" | "large";

/** 中に降りないフォルダ (依存・キャッシュ・バージョン管理)。どの深さでも除外する。名前は小文字で比べる */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", ".next", ".nuxt", ".svelte-kit", ".output",
  ".turbo", ".cache", ".parcel-cache", ".angular", ".gradle", ".idea", ".vscode", ".vercel", ".wrangler", ".terraform",
  "__pycache__", ".venv", "venv", "site-packages", ".tox", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".yarn",
  ".pnpm-store", "coverage", ".dart_tool", "bower_components",
]);
/** build の成果物らしい名前。木の根の直下にあるときだけ除外する (`src/target/Target.java` や `k8s/pods/a.yaml` は読める) */
const ROOT_EXCLUDED_DIRS: ReadonlySet<string> = new Set(["build", "out", "target", "vendor", "pods", "deriveddata"]);
/** 秘密を置くフォルダ。どの深さでも、下のファイルは全部「秘密」として除外する */
const SECRET_DIRS: ReadonlySet<string> = new Set([".ssh", ".aws", ".gnupg", ".docker", ".kube", "secrets"]);

/** 秘密になりうるファイルの拡張子 (鍵・証明書・キーストア) */
const SECRET_EXTENSIONS = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "crt", "cer", "der", "p8", "ppk", "gpg", "kdbx", "tfvars", "tfstate"]);
/** 秘密になりうるファイル名 (小文字) */
const SECRET_NAMES = new Set([".npmrc", ".yarnrc", ".netrc", ".pgpass", ".htpasswd", ".pypirc", ".git-credentials", ".dockercfg", "authorized_keys", "known_hosts"]);

/** `secrets` / `credentials` で始まる名前を秘密として扱う拡張子 (データ形式)。ソースコード (`Credentials.ts` など) は読めるようにする */
const SECRET_DATA_EXTENSIONS = new Set(["json", "yaml", "yml", "toml", "ini", "txt", "xml", "properties", "conf", "cfg"]);

/** バイナリ (読んでも文字にならない) ファイルの拡張子 */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "webp", "avif", "tiff", "tif", "psd", "heic", "svgz",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "ear", "whl", "egg", "nupkg", "dmg", "iso",
  "exe", "dll", "so", "dylib", "a", "lib", "o", "obj", "class", "pyc", "pyo", "wasm", "bin", "dat", "db", "sqlite", "sqlite3", "mdb",
  "mp3", "mp4", "m4a", "wav", "ogg", "flac", "avi", "mov", "mkv", "webm", "woff", "woff2", "ttf", "otf", "eot",
]);

/** 生成物のファイル名 (ロックファイル・minify・ソースマップ) */
const GENERATED_NAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "composer.lock", "gemfile.lock", "poetry.lock", "cargo.lock", "go.sum", "bun.lockb", ".ds_store", "thumbs.db"]);

const extensionOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
};

/** フォルダの名前が、降りない対象か。atRoot は「木の根の直下のフォルダか」 (build・out・target などは根の直下だけ除外する) */
export const isExcludedDirName = (name: string, atRoot = false): boolean => {
  const n = name.toLowerCase();
  return EXCLUDED_DIRS.has(n) || SECRET_DIRS.has(n) || (atRoot && ROOT_EXCLUDED_DIRS.has(n));
};

/** ファイル名 (パスの最後) だけで決まる除外。当たらなければ null */
function excludedFileNameReason(fileName: string): ExcludeReason | null {
  const name = fileName.toLowerCase();
  // .env / .envrc / .env-prod / .env_dev / .env~ / .env.local / app.env.local / prod.env
  if (/^\.env(rc)?($|[._~-])/.test(name) || /\.env($|[._~-])/.test(name)) return "secret";
  if (SECRET_NAMES.has(name) || /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\..*)?$/.test(name)) return "secret";
  // terraform.tfstate.backup のように名前の途中に拡張子が来るもの
  if (name.includes(".tfstate") || name.includes(".tfvars")) return "secret";
  if (/^(service[-_]?account|client[-_]?secrets?)[^/]*\.json$/.test(name)) return "secret";
  const credentialLike = /^(secrets?|credentials?)(\.(.*))?$/.exec(name);
  if (credentialLike) {
    // 拡張子なし、または名前のどこかにデータ形式の拡張子がある (credentials.json.bak も)
    if (credentialLike[3] === undefined || credentialLike[3].split(".").some((e) => SECRET_DATA_EXTENSIONS.has(e))) return "secret";
  }
  if (name.endsWith(".secret") || name.endsWith(".secrets")) return "secret";
  if (SECRET_EXTENSIONS.has(extensionOf(name))) return "secret";
  if (BINARY_EXTENSIONS.has(extensionOf(name))) return "binary";
  if (GENERATED_NAMES.has(name) || name.endsWith(".min.js") || name.endsWith(".min.css") || name.endsWith(".map")) return "generated";
  return null;
}

/** 相対パス (と、分かればバイト数) が、AI に見せない対象か。見せてよければ null */
export function excludeReason(path: string, size?: number): ExcludeReason | null {
  const segments = path.split("/");
  const fileName = segments[segments.length - 1] ?? "";
  const dirs = segments.slice(0, -1);
  for (let i = 0; i < dirs.length; i++) {
    if (SECRET_DIRS.has(dirs[i]!.toLowerCase())) return "secret";
    if (isExcludedDirName(dirs[i]!, i === 0)) return "folder";
  }
  const byName = excludedFileNameReason(fileName);
  if (byName) return byName;
  if (size !== undefined && size > MAX_FILE_BYTES) return "large";
  return null;
}

/** 文字列がバイナリらしいか (NUL を含む)。拡張子では分からないものの最後の砦 */
export const looksBinary = (text: string): boolean => text.slice(0, 8000).includes("\0");

/** 秘密鍵の中身 (`-----BEGIN … PRIVATE KEY-----`) を含むか。名前で分からない鍵を AI に出さない最後の砦 */
export const looksPrivateKey = (text: string): boolean => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/.test(text);

// ---- パスの正規化 ----

export type NormalizedPath = { ok: true; path: string } | { ok: false; reason: string };

/**
 * AI や利用者が渡したパスを、木の中の相対パスにそろえる。
 * `\` は `/` にし、`.`・空の区間・先頭の `./` は取る。`..`・絶対パス (`/`・`C:`)・NUL を含むものは断る。
 * 木の根は空文字。
 */
export function normalizeTreePath(input: string): NormalizedPath {
  if (input.includes("\0")) return { ok: false, reason: "パスに使えない文字が含まれています" };
  const raw = input.trim().replace(/\\/g, "/");
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) return { ok: false, reason: "絶対パスは使えません。選んだフォルダからの相対パスで指定してください" };
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return { ok: false, reason: "「..」を含むパスは使えません。選んだフォルダの外は読めません" };
    out.push(seg);
  }
  return { ok: true, path: out.join("/") };
}

// ---- 木の見え方 ----

/** 木のパスが AI に見せない対象か。まとめた木はラベルを除いたもとのソースの中のパスで判定する (excludeReasonOf) */
export function treeExcludeReason(tree: SourceTree, path: string, size?: number): ExcludeReason | null {
  return tree.excludeReasonOf ? tree.excludeReasonOf(path, size) : excludeReason(path, size);
}

/** 除外規則を通したファイルの一覧 (木の実装が除外し忘れても、AI には出さない) */
export function visibleFiles(tree: SourceTree): SourceFileInfo[] {
  return tree.files.filter((f) => treeExcludeReason(tree, f.path, f.size) === null);
}

/**
 * ソースの呼び名 (依頼・履歴・サマリー・会話の最初の発言で同じ形)。1 つなら「ソースコード「フォルダ名」」、
 * 複数なら「ソースコード 3 か所 (ラベル (フォルダ名)、…)」
 */
export function sourcesTitle(sources: readonly { label: string; folder: string }[]): string {
  return sources.length === 1 ? `ソースコード「${sources[0]!.folder}」` : `ソースコード ${sources.length} か所 (${sources.map((s) => `${s.label} (${s.folder})`).join("、")})`;
}

/** ソースが 2 つ以上のまとめた木か (パスの先頭がラベルになっている) */
export const isMultiSourceTree = (tree: SourceTree): boolean => (tree.sources?.length ?? 0) > 1 && tree.sources!.every((s) => s.label !== "");

// ---- ソースのラベル ----

/** ラベルの重複を見るためのそろえ方 (大文字小文字・全角半角・結合文字の違いだけの重複も同じとみなす) */
export const labelKey = (label: string): string => label.normalize("NFKC").toLowerCase();

// eslint-disable-next-line no-control-regex
const LABEL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
/** 見えない文字: 書式文字 (ソフトハイフン U+00AD・タグ文字 U+E0000 台などの \p{Cf}) と、空白に見えるハングルの埋め字・点字の空白 */
const LABEL_INVISIBLE = /[\p{Cf}\u115f\u1160\u3164\uffa0\u2800]/u;
/**
 * glob の記号 (sourceTools.ts の globMatcher で実際に効くもの)。ラベルが search_code の glob (ラベル付きの絞り込み) でワイルドカードとして扱われないよう、ラベルには使えない。
 * `[` `]` は globMatcher では文字どおりなので使える (「[admin]」など)。`,` は `{}` の中でだけ区切りとして効き、ラベルに `{}` は使えないので、ラベルの `,` も文字どおり使える
 */
const LABEL_GLOB = /[*?{}]/;
/** 見えない文字のうち、書式文字 (\p{Cf}) では拾えないもの: 結合文字の書記素接合子 (U+034F) */
const LABEL_INVISIBLE_EXTRA = /\u034f/;
/** 孤立したサロゲート (対にならない半分。画面や API に出すと壊れる) */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** 絵文字と絵文字の間の ZWJ (U+200D。👨‍👩‍👧 のような絵文字の組み合わせ)。見えない文字ではあるが、絵文字を作るので許す */
const EMOJI_JOINER = /(?<=\p{Extended_Pictographic}[\ufe0f\u{1f3fb}-\u{1f3ff}]?)\u200d(?=\p{Extended_Pictographic})/gu;
/** 絵文字の間の ZWJ を除く (ほかの検査にかける前に) */
const withoutEmojiJoiners = (label: string): string => label.replace(EMOJI_JOINER, "");

/**
 * ラベルの形の検査。使えるなら null、使えないなら理由 (画面にそのまま出す)。
 * パスの 1 階層としてそのまま使えること: `/`・`\`・`:`・制御文字・見えない文字 (絵文字の間の ZWJ は除く)・孤立したサロゲート・glob の記号 (`* ? { }`)・先頭や末尾の空白・`.`・`..`・先頭の `~` は使えない。空も不可。長さは MAX_SOURCE_LABEL_CHARS まで
 */
export function sourceLabelProblem(label: string): string | null {
  if (label === "") return "ラベルを入力してください";
  if (label !== label.trim()) return "ラベルの先頭と末尾に空白は使えません";
  if (label === "." || label === "..") return "「.」「..」はラベルに使えません";
  if ([...label].length > MAX_SOURCE_LABEL_CHARS) return `ラベルは ${MAX_SOURCE_LABEL_CHARS} 文字までです`;
  if (/[/\\:]/.test(label)) return "ラベルに「/」「\\」「:」は使えません";
  const plain = withoutEmojiJoiners(label);
  if (LABEL_CONTROL.test(plain)) return "ラベルに制御文字は使えません";
  if (LONE_SURROGATE.test(label)) return "ラベルに、文字として読めない文字 (対になっていないサロゲート) は使えません";
  if (LABEL_INVISIBLE.test(plain) || LABEL_INVISIBLE_EXTRA.test(plain)) return "ラベルに見えない文字 (ソフトハイフン・書式文字・空白に見える文字など) は使えません";
  if (LABEL_GLOB.test(label)) return "ラベルに「* ? { }」は使えません (検索の絞り込みの記号と混ざるため)";
  if (label.startsWith("~")) return "ラベルを「~」で始めることはできません";
  return null;
}

/**
 * 複数のラベルの検査。行ごとの理由 (問題が無ければ null) を返す。
 * 空のラベルは必須として扱う (ソースが 1 つのときの「任意」は呼ぶ側が決める)。重複は後ろの行に「他の行と重なっています」を付ける
 */
export function sourceLabelProblems(labels: readonly string[]): (string | null)[] {
  const seen = new Map<string, number>();
  return labels.map((label, i) => {
    const own = sourceLabelProblem(label);
    if (own) return own;
    const key = labelKey(label);
    const first = seen.get(key);
    if (first !== undefined) return `ラベルが ${first + 1} 番目のソースと重なっています (大文字小文字・全角半角の違いは同じとみなします)`;
    seen.set(key, i);
    return null;
  });
}

/**
 * フォルダ名を、ラベルの規則に合う形に整える (2 つ目のソースを足したとき、空のラベルへ入れる)。
 * 使えない文字 (`/ \\ :`・制御文字・見えない文字・glob の記号 `* ? { }`) を取り、前後の空白・先頭の `~` と `.` を取り、MAX_SOURCE_LABEL_CHARS までに切る。
 * 何も残らなければ空 (呼ぶ側が候補を入れる)
 */
export function tidySourceLabel(name: string): string {
  let t = name.replace(/[/\\:*?{}]/g, " ");
  // 見えない文字を取る (絵文字の間の ZWJ は残す)。孤立したサロゲートも取る
  t = t.replace(new RegExp(`${LABEL_CONTROL.source}|${LABEL_INVISIBLE.source}|${LABEL_INVISIBLE_EXTRA.source}|[\\ud800-\\udfff]`, "gu"), (m, offset: number, whole: string) =>
    m === "\u200d" && /\p{Extended_Pictographic}[\ufe0f\u{1f3fb}-\u{1f3ff}]?$/u.test(whole.slice(0, offset)) && /^\p{Extended_Pictographic}/u.test(whole.slice(offset + 1)) ? m : "",
  );
  t = t.replace(/\s+/g, " ").trim().replace(/^[~.\s]+/, "");
  t = [...t].slice(0, MAX_SOURCE_LABEL_CHARS).join("").trim();
  return sourceLabelProblem(t) === null ? t : "";
}

/**
 * 同じフォルダを 2 回選んだらしいか。同じ木 (同じ実体)、または、フォルダ名とファイルの一覧 (パスと大きさ) がすべて同じ。
 * 確かなのは isSameEntry (io/sourceFolder.ts の sameFolderAs) で、これは使えない環境の手がかり (内容が同じ別のコピーでも真になる)
 */
export function looksSameSource(a: SourceTree, b: SourceTree): boolean {
  if (a === b) return true;
  if (a.name !== b.name || a.files.length !== b.files.length) return false;
  const sizes = new Map(a.files.map((f) => [f.path, f.size]));
  return b.files.every((f) => sizes.get(f.path) === f.size);
}

// ---- ソースをまとめる ----

/**
 * 件数の上限を、ソースの数で公平に分ける。少ないソースはそのまま、多いソースだけが上限を使い切らないように、余りを多いソースへ回す。
 * counts の合計が max 以下なら、そのまま返す
 */
export function shareFileQuota(counts: readonly number[], max: number): number[] {
  const quota = counts.map(() => 0);
  let left = max;
  let open = counts.map((_, i) => i);
  while (open.length > 0 && left > 0) {
    const share = Math.floor(left / open.length);
    if (share === 0) break;
    const small = open.filter((i) => counts[i]! - quota[i]! <= share);
    if (small.length === 0) {
      for (const i of open) quota[i]! += share;
      left -= share * open.length;
      break;
    }
    for (const i of small) {
      left -= counts[i]! - quota[i]!;
      quota[i] = counts[i]!;
    }
    open = open.filter((i) => !small.includes(i));
  }
  // 割り切れずに余った分は、まだ入りきっていないソースの先頭から 1 つずつ
  for (let i = 0; left > 0 && i < counts.length * 2; i++) {
    const j = i % counts.length;
    if (quota[j]! < counts[j]!) {
      quota[j]!++;
      left--;
    }
  }
  return quota;
}

const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** パスの depth 番目 (0 始まり) の階層の名前。そこがファイルの名前 (それより下が無い) なら "" */
const segmentAt = (path: string, depth: number): string => {
  const parts = path.split("/");
  return depth < parts.length - 1 ? parts[depth]! : "";
};

/**
 * ファイルを quota 件に減らす。フォルダごとに順番に 1 件ずつ取る (どのフォルダも少しずつ残る。パスの名前順で後ろから落とすと、
 * `docs/` が残って `src/` が 0 件になる)。最上位のフォルダが 1 つだけ (`src/` の下に全部) のときは、その中の次の階層で分ける (1 つでなくなるまで繰り返す)。
 * フォルダの中は名前順。返す一覧は、減らさないときも名前順
 */
export function takeFairly<T extends { path: string }>(files: readonly T[], quota: number): T[] {
  const sorted = [...files].sort(byPath);
  if (quota >= sorted.length) return sorted;
  // 1 つのフォルダの下に全部あるあいだは、次の階層へ降りて分ける
  let depth = 0;
  for (;;) {
    const keys = new Set(sorted.map((f) => segmentAt(f.path, depth)));
    if (keys.size === 1 && !keys.has("")) depth++;
    else break;
  }
  const groups = new Map<string, T[]>();
  for (const f of sorted) {
    const k = segmentAt(f.path, depth);
    const g = groups.get(k);
    if (g) g.push(f);
    else groups.set(k, [f]);
  }
  const lists = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, g]) => g);
  const kept: T[] = [];
  for (let round = 0; kept.length < quota; round++) {
    let took = false;
    for (const g of lists) {
      if (kept.length >= quota) break;
      const f = g[round];
      if (f) {
        kept.push(f);
        took = true;
      }
    }
    if (!took) break;
  }
  return kept.sort(byPath);
}

export interface CombineOptions {
  /** まとめた木に入れるファイルの数の上限 (テストで小さな値に差し替える) */
  maxFiles?: number;
}

/**
 * ラベル付きの複数のソースを、1 つの SourceTree にまとめる。
 * - ソースが 1 つなら、ラベルがあってもなくても今までどおりの木 (ラベルのフォルダを挟まない)。ラベルは sources に残り、AI への説明にだけ使う
 * - 2 つ以上なら、各ソースがラベルを名前にした最上位のフォルダになる (`バックエンド/src/routes/orders.ts`)。
 *   除外規則はラベルを除いた、もとのソースの中のパスで当てる (ラベルが build・secrets・.env でも、そのソース全体が除外されたり、除外すべきものが通ったりしない。
 *   根の直下だけ除外するフォルダ (build・out・target など) は、各ソースの根の直下で効く)。
 * - 件数の上限 (MAX_TREE_FILES) はソースで分け合う (shareFileQuota)。1 つのソースが使い切って、ほかが見えなくなることはない。減らしたソースは sources[].trimmed に出る (木の truncated も真になる)。
 *   ソースの中で減らすときは、フォルダごとに順番に取る (takeFairly。最上位が 1 つだけなら、その下の階層で分ける)。減らしたファイルは、一覧だけでなく読み取りも検索もできない
 * ラベルが使えない・重なる・数が 0 または MAX_SOURCES を超えるときは Error (画面で先に検査する)
 */
export function combineSourceTrees(sources: readonly LabeledSource[], options: CombineOptions = {}): SourceTree {
  const maxFiles = options.maxFiles ?? MAX_TREE_FILES;
  if (sources.length === 0) throw new Error("ソースが 1 つもありません");
  if (sources.length > MAX_SOURCES) throw new Error(`ソースは ${MAX_SOURCES} 個までです`);
  if (sources.length === 1) {
    const { label, tree } = sources[0]!;
    if (label !== "") {
      const problem = sourceLabelProblem(label);
      if (problem) throw new Error(problem);
    }
    const visible = visibleFiles(tree);
    return {
      name: tree.name,
      get files() {
        return tree.files;
      },
      ...(tree.truncated ? { truncated: true } : {}),
      ...(tree.depthTruncated ? { depthTruncated: true } : {}),
      readFile: (path) => tree.readFile(path),
      sources: [{ label, folder: tree.name, fileCount: visible.length, truncated: !!tree.truncated, depthTruncated: !!tree.depthTruncated, trimmed: 0 }],
    };
  }
  const problems = sourceLabelProblems(sources.map((s) => s.label));
  const bad = problems.findIndex((p) => p !== null);
  if (bad >= 0) throw new Error(`${bad + 1} 番目のソース: ${problems[bad]}`);

  const visible = sources.map((s) => visibleFiles(s.tree).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  const quota = shareFileQuota(visible.map((v) => v.length), maxFiles);
  const byLabel = new Map<string, SourceTree>();
  const files: SourceFileInfo[] = [];
  const summaries: SourceSummary[] = sources.map((s, i) => {
    byLabel.set(s.label, s.tree);
    const kept = takeFairly(visible[i]!, quota[i]!);
    for (const f of kept) files.push({ path: `${s.label}/${f.path}`, size: f.size });
    const trimmed = visible[i]!.length - kept.length;
    return { label: s.label, folder: s.tree.name, fileCount: kept.length, truncated: !!s.tree.truncated, depthTruncated: !!s.tree.depthTruncated, trimmed };
  });
  const split = (path: string): { tree: SourceTree; rest: string } | null => {
    const i = path.indexOf("/");
    if (i <= 0) return null;
    const tree = byLabel.get(path.slice(0, i));
    return tree ? { tree, rest: path.slice(i + 1) } : null;
  };
  return {
    name: sources.map((s) => s.label).join("・"),
    files,
    ...(summaries.some((s) => s.truncated || s.trimmed > 0) ? { truncated: true } : {}),
    ...(summaries.some((s) => s.depthTruncated) ? { depthTruncated: true } : {}),
    sources: summaries,
    // ラベルを除いた、もとのソースの中のパスで判定する。ラベルだけのパス (フォルダ) や、知らないラベルは「フォルダ」として出さない
    excludeReasonOf: (path, size) => {
      const part = split(path);
      return part ? treeExcludeReason(part.tree, part.rest, size) : "folder";
    },
    async readFile(path) {
      const part = split(path);
      if (!part) throw new Error(`ファイルがありません: ${path}`);
      return part.tree.readFile(part.rest);
    },
  };
}

// ---- メモリ上の木 (テストと、後続のフィクスチャ用) ----

/**
 * パス → 中身 のメモリ上の木。除外規則は適用しない (道具が除外することをテストで確かめられるように、そのまま持つ)。
 * size は UTF-8 のバイト数
 */
export function memorySourceTree(name: string, contents: Record<string, string>): SourceTree {
  const encoder = new TextEncoder();
  const files = Object.entries(contents).map(([path, text]) => ({ path, size: encoder.encode(text).length }));
  return {
    name,
    files,
    async readFile(path) {
      const text = contents[path];
      if (text === undefined) throw new Error(`ファイルがありません: ${path}`);
      return text;
    },
  };
}
