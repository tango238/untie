// ブラウザの API だけで、ソースコードのフォルダを選んで SourceTree にする (Web 版・クラウド版・デスクトップの WebView で共通)。
// showDirectoryPicker (Chrome・Edge) があれば読み取り専用で使い、無ければ <input type="file" webkitdirectory>。
// 除外するフォルダ (node_modules など) には降りない。秘密になりうるファイル・バイナリ・巨大ファイルは木に入れない。
import {
  MAX_FILE_BYTES,
  MAX_TREE_DEPTH,
  MAX_TREE_FILES,
  excludeReason,
  isExcludedDirName,
  type SourceFileInfo,
  type SourceTree,
} from "../ai/sourceTree";

// File System Access API (lib.dom に型が無いので、使う分だけ書く)
interface DirHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<DirHandle | FileEntryHandle>;
  /** 同じフォルダか (Chrome・Edge)。無い環境もある */
  isSameEntry?(other: unknown): Promise<boolean>;
}
interface FileEntryHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
interface DirectoryPickerWindow {
  showDirectoryPicker?: (options: { mode: "read" }) => Promise<DirHandle>;
}

/** 木を作ったフォルダのハンドル (同じフォルダを 2 回選んだかを isSameEntry で確かめる用) */
const rootHandles = new WeakMap<SourceTree, DirHandle>();

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** 木をたどる上限 (テストで小さな値に差し替えるため、引数で渡せる) */
export interface TreeLimits {
  maxFiles?: number;
  maxDepth?: number;
}

/**
 * ディレクトリのハンドルから木を作る。除外フォルダには降りず、件数と深さの上限で打ち切る。
 * 深さの上限を超えたフォルダはその枝だけ飛ばして (depthTruncated)、兄弟や親の残りは読み続ける。件数の上限に達したら全体を打ち切る (truncated)。
 * 読めない項目 (一覧や getFile が投げるもの) はその項目だけ飛ばす
 */
export async function treeFromDirectoryHandle(root: DirHandle, limits: TreeLimits = {}): Promise<SourceTree> {
  const maxFiles = limits.maxFiles ?? MAX_TREE_FILES;
  const maxDepth = limits.maxDepth ?? MAX_TREE_DEPTH;
  const files: SourceFileInfo[] = [];
  const handles = new Map<string, FileEntryHandle>();
  let truncated = false;
  let depthTruncated = false;

  async function walk(dir: DirHandle, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      depthTruncated = true;
      return;
    }
    const entries: (DirHandle | FileEntryHandle)[] = [];
    try {
      for await (const entry of dir.values()) entries.push(entry);
    } catch {
      // 途中で読めなくなったフォルダは、そこまでに読めた分だけ使う
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      const path = `${prefix}${entry.name}`;
      if (entry.kind === "directory") {
        if (isExcludedDirName(entry.name, depth === 0)) continue;
        await walk(entry, `${path}/`, depth + 1);
      } else {
        // 名前で決まる除外は、中身を開く前に決める
        if (excludeReason(path) !== null) continue;
        let size: number;
        try {
          size = (await entry.getFile()).size;
        } catch {
          continue;
        }
        if (excludeReason(path, size) !== null) continue;
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        files.push({ path, size });
        handles.set(path, entry);
      }
    }
  }
  await walk(root, "", 0);

  const tree: SourceTree = {
    name: root.name,
    files,
    ...(truncated ? { truncated: true } : {}),
    ...(depthTruncated ? { depthTruncated: true } : {}),
    async readFile(path) {
      const handle = handles.get(path);
      if (!handle) throw new Error(`ファイルがありません: ${path}`);
      const file = await handle.getFile();
      // 選んだあとに大きくなったかもしれないので、読む前に確かめ直す
      if (file.size > MAX_FILE_BYTES) throw new Error(`ファイルが大きすぎます: ${path}`);
      return file.text();
    },
    async sameFolderAs(other) {
      const theirs = rootHandles.get(other);
      if (!theirs || !root.isSameEntry) return null;
      try {
        return await root.isSameEntry(theirs);
      } catch {
        return null;
      }
    },
  };
  rootHandles.set(tree, root);
  return tree;
}

/**
 * <input webkitdirectory> で選んだ File の一覧から木を作る。webkitRelativePath の先頭はフォルダ名なので取り除く。
 * ブラウザは全ファイルを渡してくるので、除外フォルダの下のファイルはここで捨てる (読まない)
 */
export function treeFromFileList(list: ArrayLike<File>, limits: TreeLimits = {}): SourceTree {
  const maxFiles = limits.maxFiles ?? MAX_TREE_FILES;
  const maxDepth = limits.maxDepth ?? MAX_TREE_DEPTH;
  const files: SourceFileInfo[] = [];
  const byPath = new Map<string, File>();
  let name = "";
  let truncated = false;
  let depthTruncated = false;
  for (let i = 0; i < list.length; i++) {
    const file = list[i]!;
    const segments = (file.webkitRelativePath || file.name).split("/");
    if (segments.length > 1) name = name || segments[0]!;
    const path = (segments.length > 1 ? segments.slice(1) : segments).join("/");
    if (excludeReason(path, file.size) !== null) continue;
    if (path.split("/").length > maxDepth + 1) {
      depthTruncated = true;
      continue;
    }
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    files.push({ path, size: file.size });
    byPath.set(path, file);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    name: name || "(フォルダ)",
    files,
    ...(truncated ? { truncated: true } : {}),
    ...(depthTruncated ? { depthTruncated: true } : {}),
    async readFile(path) {
      const file = byPath.get(path);
      if (!file) throw new Error(`ファイルがありません: ${path}`);
      if (file.size > MAX_FILE_BYTES) throw new Error(`ファイルが大きすぎます: ${path}`);
      return file.text();
    },
  };
}

/** <input webkitdirectory> でフォルダを選ばせる。取り消したら null */
function pickWithInput(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.style.display = "none";
    input.addEventListener("change", () => resolve(input.files && input.files.length > 0 ? Array.from(input.files) : null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** ソースコードのフォルダを選んで読み取り専用の木にする。取り消したら null。Platform.pickSourceFolder の実装に使う */
export async function pickSourceFolderInBrowser(): Promise<SourceTree | null> {
  const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker;
  if (picker) {
    let dir: DirHandle;
    try {
      dir = await picker.call(window, { mode: "read" });
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
    return treeFromDirectoryHandle(dir);
  }
  const picked = await pickWithInput();
  return picked ? treeFromFileList(picked) : null;
}
