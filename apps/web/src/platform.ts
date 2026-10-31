// Platform の Web 実装。
// ファイルは、File System Access API があれば (Chrome・Edge) 開いたファイルに上書きし、無ければファイル選択とダウンロードを使う。
// 最近開いたファイルのハンドルは IndexedDB に置く (ハンドルは localStorage には入らない)。
// API キーは、ふだんはこのタブの間だけメモリに持ち、「このブラウザに保存する」を選んだときだけ localStorage にも置く。
import {
  FILE_EXTENSION,
  RECENT_LIMIT,
  type OpenedFile,
  type Platform,
  type RecentFile,
  type RecentFileStore,
  type SavedFile,
  type SecretStore,
} from "@untie/ui/platform";

// ---- ファイル ----

// File System Access API (lib.dom に型が無いので、使う分だけ書く)
interface FilePickerWindow {
  showOpenFilePicker?: (options: object) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options: object) => Promise<FileSystemFileHandle>;
}
const pickerWindow = () => window as unknown as FilePickerWindow;
const PICKER_TYPES = [{ description: "Untie モデル", accept: { "application/json": [`.${FILE_EXTENSION}`] } }];
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** 開いた・保存したファイルのハンドル。ストアの path にはハンドルの代わりに "browser:<番号>" を入れる */
class HandleTable {
  private handles = new Map<string, FileSystemFileHandle>();
  private seq = 0;

  remember(handle: FileSystemFileHandle): string {
    const key = `browser:${++this.seq}`;
    this.handles.set(key, handle);
    return key;
  }

  get(path: string): FileSystemFileHandle | undefined {
    return this.handles.get(path);
  }
}

async function writeHandle(handle: FileSystemFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

// ---- 最近開いたファイル (IndexedDB) ----

const DB_NAME = "untie";
const DB_STORE = "recentFiles";
const DB_KEY = "list";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// requestPermission は lib.dom に型が無いので、使う分だけ書く
interface PermissionedHandle {
  queryPermission?: (d: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
}

function recentFileStore(handles: HandleTable, canReopen: () => boolean): RecentFileStore {
  const usable = () => canReopen() && typeof indexedDB !== "undefined";

  // 読めないとき (プライベートウィンドウなど) は「一覧が空」とみなす
  async function readList(): Promise<RecentFile[]> {
    try {
      if (!usable()) return [];
      const list = await withStore<RecentFile[] | undefined>("readonly", (s) => s.get(DB_KEY));
      return Array.isArray(list) ? list.filter((e) => e.handle) : [];
    } catch {
      return [];
    }
  }

  // 書けないときは覚えないだけにする (ファイルを開く・保存すること自体は止めない)
  async function writeList(list: RecentFile[]): Promise<void> {
    try {
      if (!usable()) return;
      await withStore("readwrite", (s) => s.put(list, DB_KEY));
    } catch {
      // 覚えられなくても困らない
    }
  }

  async function sameFile(a: RecentFile, b: RecentFile): Promise<boolean> {
    if (!a.handle || !b.handle) return false;
    try {
      return await a.handle.isSameEntry(b.handle);
    } catch {
      return false;
    }
  }

  async function without(list: RecentFile[], target: RecentFile): Promise<RecentFile[]> {
    const out: RecentFile[] = [];
    for (const e of list) if (!(await sameFile(e, target))) out.push(e);
    return out;
  }

  return {
    load: readList,
    async add(file) {
      if (!file.path) return;
      const handle = handles.get(file.path);
      if (!handle) return;
      const entry: RecentFile = { name: file.name, handle };
      const rest = await without(await readList(), entry);
      await writeList([entry, ...rest].slice(0, RECENT_LIMIT));
    },
    async remove(file) {
      await writeList(await without(await readList(), file));
    },
    async clear() {
      await writeList([]);
    },
    // 上書き保存できるよう、読み書きの許可を求める (メニューのクリックの中で呼ぶ)
    async read(file): Promise<OpenedFile> {
      const handle = file.handle!;
      const p = handle as unknown as PermissionedHandle;
      if (p.queryPermission && (await p.queryPermission({ mode: "readwrite" })) !== "granted") {
        if (p.requestPermission && (await p.requestPermission({ mode: "readwrite" })) !== "granted") {
          throw new Error("ファイルを読み書きする許可がありません");
        }
      }
      const f = await handle.getFile();
      return { path: handles.remember(handle), name: f.name, text: await f.text() };
    },
  };
}

// ---- API キー (メモリ + localStorage) ----

const STORAGE_PREFIX = "untie.apiKey.";

// localStorage はプライベートウィンドウなどで使えないことがあるので、読むときの失敗は「無い」とみなす
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null;
  }
}

function removeStored(key: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // 使えないなら、もともと置かれていない
  }
}

function webSecrets(): SecretStore {
  const memory = new Map<string, string>();
  return {
    async get(key) {
      return memory.get(key) ?? readStored(key);
    },
    async set(key, value, { remember = false } = {}) {
      const trimmed = value.trim();
      memory.set(key, trimmed);
      if (!remember) {
        removeStored(key);
        return;
      }
      try {
        localStorage.setItem(STORAGE_PREFIX + key, trimmed);
      } catch (e) {
        throw new Error(`このブラウザには保存できませんでした。このタブを閉じるまでは使えます。(${String(e)})`);
      }
    },
    async delete(key) {
      memory.delete(key);
      removeStored(key);
    },
    isRemembered: (key) => readStored(key) !== null,
  };
}

// ---- Platform ----

export function webPlatform(): Platform {
  const handles = new HandleTable();
  const canReopenFiles = () => !!pickerWindow().showOpenFilePicker;

  return {
    kind: "web",

    async openTextFile(): Promise<OpenedFile | null> {
      // window から外して呼ぶと Illegal invocation になるので、window.showOpenFilePicker として呼ぶ
      const picker = pickerWindow();
      if (picker.showOpenFilePicker) {
        try {
          const [handle] = await picker.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
          if (!handle) return null;
          const file = await handle.getFile();
          return { path: handles.remember(handle), name: file.name, text: await file.text() };
        } catch (e) {
          if (isAbort(e)) return null;
          throw e;
        }
      }
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = `.${FILE_EXTENSION},application/json`;
        input.addEventListener("change", async () => {
          const f = input.files?.[0];
          resolve(f ? { path: null, name: f.name, text: await f.text() } : null);
        });
        input.addEventListener("cancel", () => resolve(null));
        input.click();
      });
    },

    async saveTextFile(text, path, suggestedName): Promise<SavedFile | null> {
      const opened = path ? handles.get(path) : undefined;
      if (opened) {
        await writeHandle(opened, text);
        return { path, name: opened.name };
      }
      const picker = pickerWindow();
      if (picker.showSaveFilePicker) {
        let handle: FileSystemFileHandle;
        try {
          handle = await picker.showSaveFilePicker({ types: PICKER_TYPES, suggestedName });
        } catch (e) {
          if (isAbort(e)) return null;
          throw e;
        }
        await writeHandle(handle, text);
        return { path: handles.remember(handle), name: handle.name };
      }
      // File System Access API の無いブラウザでは、いつもダウンロード
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = suggestedName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { path: null, name: suggestedName };
    },

    canReopenFiles,

    async confirmDiscard(message) {
      return window.confirm(message);
    },

    async openExternalUrl(url) {
      window.open(url, "_blank", "noopener");
    },

    // beforeunload は同期でしか止められないので、確認のダイアログはブラウザに任せる
    onCloseRequested(hasUnsavedChanges) {
      const onBeforeUnload = (e: BeforeUnloadEvent) => {
        if (!hasUnsavedChanges()) return;
        e.preventDefault();
        e.returnValue = "";
      };
      window.addEventListener("beforeunload", onBeforeUnload);
      return () => window.removeEventListener("beforeunload", onBeforeUnload);
    },

    secrets: webSecrets(),
    recentFiles: recentFileStore(handles, canReopenFiles),

    // サーバーは自分のオリジン (Vite の開発サーバーは /api・/auth を wrangler dev へ渡す)
    serverOrigin: () => location.origin,
    // 同じタブでログインへ移る。戻り先はハッシュ (#/...)
    async login(provider, returnTo) {
      location.assign(`/auth/login?provider=${encodeURIComponent(provider)}&return=${encodeURIComponent(returnTo)}`);
    },
    // Cookie で認証するので、リクエストはそのまま
    authorize: async (init) => init,
  };
}
