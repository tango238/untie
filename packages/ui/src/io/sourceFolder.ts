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
}
interface FileEntryHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
interface DirectoryPickerWindow {
  showDirectoryPicker?: (options: { mode: "read" }) => Promise<DirHandle>;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** ディレクトリのハンドルから木を作る。除外フォルダには降りず、件数と深さの上限で打ち切る */
export async function treeFromDirectoryHandle(root: DirHandle): Promise<SourceTree> {
  const files: SourceFileInfo[] = [];
  const handles = new Map<string, FileEntryHandle>();
  let truncated = false;

  async function walk(dir: DirHandle, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_TREE_DEPTH) {
      truncated = true;
      return;
    }
    const entries: (DirHandle | FileEntryHandle)[] = [];
    for await (const entry of dir.values()) entries.push(entry);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      const path = `${prefix}${entry.name}`;
      if (entry.kind === "directory") {
        if (isExcludedDirName(entry.name)) continue;
        await walk(entry, `${path}/`, depth + 1);
      } else {
        // 名前で決まる除外は、中身を開く前に決める
        if (excludeReason(path) !== null) continue;
        const file = await entry.getFile();
        if (excludeReason(path, file.size) !== null) continue;
        if (files.length >= MAX_TREE_FILES) {
          truncated = true;
          return;
        }
        files.push({ path, size: file.size });
        handles.set(path, entry);
      }
    }
  }
  await walk(root, "", 0);

  return {
    name: root.name,
    files,
    ...(truncated ? { truncated: true } : {}),
    async readFile(path) {
      const handle = handles.get(path);
      if (!handle) throw new Error(`ファイルがありません: ${path}`);
      return (await handle.getFile()).text();
    },
  };
}

/**
 * <input webkitdirectory> で選んだ File の一覧から木を作る。webkitRelativePath の先頭はフォルダ名なので取り除く。
 * ブラウザは全ファイルを渡してくるので、除外フォルダの下のファイルはここで捨てる (読まない)
 */
export function treeFromFileList(list: ArrayLike<File>): SourceTree {
  const files: SourceFileInfo[] = [];
  const byPath = new Map<string, File>();
  let name = "";
  let truncated = false;
  for (let i = 0; i < list.length; i++) {
    const file = list[i]!;
    const segments = (file.webkitRelativePath || file.name).split("/");
    if (segments.length > 1) name = name || segments[0]!;
    const path = (segments.length > 1 ? segments.slice(1) : segments).join("/");
    if (segments.length > MAX_TREE_DEPTH + 1 || excludeReason(path, file.size) !== null) continue;
    if (files.length >= MAX_TREE_FILES) {
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
