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

/** 中に降りないフォルダ (依存・build の成果物・キャッシュ・バージョン管理)。名前は小文字で比べる */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target", ".next", ".nuxt", ".svelte-kit", ".output",
  ".turbo", ".cache", ".parcel-cache", ".angular", ".gradle", ".idea", ".vscode", ".vercel", ".wrangler", ".terraform",
  "__pycache__", ".venv", "venv", "site-packages", ".tox", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".yarn",
  ".pnpm-store", "coverage", "vendor", "pods", "deriveddata", ".dart_tool", "bower_components",
]);

/** 秘密になりうるファイルの拡張子 (鍵・証明書・キーストア) */
const SECRET_EXTENSIONS = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "crt", "cer", "der", "p8", "ppk", "gpg", "asc", "kdbx", "tfvars", "tfstate"]);
/** 秘密になりうるファイル名 (小文字) */
const SECRET_NAMES = new Set([".npmrc", ".yarnrc", ".netrc", ".pgpass", ".htpasswd", ".pypirc", ".git-credentials", ".dockercfg", "authorized_keys", "known_hosts"]);

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

/** フォルダの名前が、降りない対象か */
export const isExcludedDirName = (name: string): boolean => EXCLUDED_DIRS.has(name.toLowerCase());

/** ファイル名 (パスの最後) だけで決まる除外。当たらなければ null */
export function excludedFileNameReason(fileName: string): ExcludeReason | null {
  const name = fileName.toLowerCase();
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return "secret";
  if (SECRET_NAMES.has(name) || /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/.test(name)) return "secret";
  if (/^(secrets?|credentials?)(\.[^/]*)?$/.test(name) || name.endsWith(".secret") || name.endsWith(".secrets")) return "secret";
  if (SECRET_EXTENSIONS.has(extensionOf(name))) return "secret";
  if (BINARY_EXTENSIONS.has(extensionOf(name))) return "binary";
  if (GENERATED_NAMES.has(name) || name.endsWith(".min.js") || name.endsWith(".min.css") || name.endsWith(".map")) return "generated";
  return null;
}

/** 相対パス (と、分かればバイト数) が、AI に見せない対象か。見せてよければ null */
export function excludeReason(path: string, size?: number): ExcludeReason | null {
  const segments = path.split("/");
  const fileName = segments[segments.length - 1] ?? "";
  for (const dir of segments.slice(0, -1)) if (isExcludedDirName(dir)) return "folder";
  const byName = excludedFileNameReason(fileName);
  if (byName) return byName;
  if (size !== undefined && size > MAX_FILE_BYTES) return "large";
  return null;
}

/** 文字列がバイナリらしいか (NUL を含む)。拡張子では分からないものの最後の砦 */
export const looksBinary = (text: string): boolean => text.slice(0, 8000).includes("\0");

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
