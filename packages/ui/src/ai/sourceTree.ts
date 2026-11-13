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
}

// ---- 上限 ----

/** これを超えるファイルは「巨大」として出さない (バイト) */
export const MAX_FILE_BYTES = 512 * 1024;
/** 木に入れるファイルの数の上限 (これを超えたら打ち切って truncated にする) */
export const MAX_TREE_FILES = 20000;
/** 木をたどる深さの上限 */
export const MAX_TREE_DEPTH = 24;

// ---- 除外規則 ----

export type ExcludeReason = "folder" | "secret" | "binary" | "generated" | "large";

/** 中に降りないフォルダ (依存・キャッシュ・バージョン管理)。どの深さでも除外する。名前は小文字で比べる */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", ".next", ".nuxt", ".svelte-kit", ".output",
  ".turbo", ".cache", ".parcel-cache", ".angular", ".gradle", ".idea", ".vscode", ".vercel", ".wrangler", ".terraform",
  "__pycache__", ".venv", "venv", "site-packages", ".tox", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".yarn",
  ".pnpm-store", "coverage", ".dart_tool", "bower_components",
]);
/** build の成果物らしい名前。木の根の直下にあるときだけ除外する (`src/target/Target.java` や `k8s/pods/a.yaml` は読める) */
export const ROOT_EXCLUDED_DIRS: ReadonlySet<string> = new Set(["build", "out", "target", "vendor", "pods", "deriveddata"]);
/** 秘密を置くフォルダ。どの深さでも、下のファイルは全部「秘密」として除外する */
export const SECRET_DIRS: ReadonlySet<string> = new Set([".ssh", ".aws", ".gnupg", ".docker", ".kube", "secrets"]);

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
export function excludedFileNameReason(fileName: string): ExcludeReason | null {
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

/** 除外規則を通したファイルの一覧 (木の実装が除外し忘れても、AI には出さない) */
export function visibleFiles(tree: SourceTree): SourceFileInfo[] {
  return tree.files.filter((f) => excludeReason(f.path, f.size) === null);
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
