// 最近開いたファイルの一覧 (新しい順に最大 RECENT_LIMIT 件)。
// デスクトップアプリ (Tauri) ではファイルのパスを localStorage に置く。
// ブラウザでは File System Access API のハンドルを IndexedDB に置く (ハンドルは localStorage には入らない)。
// File System Access API の無いブラウザでは、開き直す手段が無いので一覧を持たない。
import { invoke } from "@tauri-apps/api/core";
import { baseName, canReopenFiles, handleOf, isTauri, rememberHandle, type OpenedFile } from "./file";

export const RECENT_LIMIT = 5;

export interface RecentFile {
  name: string;
  /** Tauri: ファイルのパス */
  path?: string;
  /** ブラウザ: File System Access API のハンドル */
  handle?: FileSystemFileHandle;
}

const STORAGE_KEY = "untie.recentFiles";

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

// 読めないとき (プライベートウィンドウなど) は「一覧が空」とみなす
async function readList(): Promise<RecentFile[]> {
  try {
    if (isTauri()) {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((e): e is RecentFile => typeof e?.path === "string" && typeof e?.name === "string") : [];
    }
    if (!canReopenFiles() || typeof indexedDB === "undefined") return [];
    const list = await withStore<RecentFile[] | undefined>("readonly", (s) => s.get(DB_KEY));
    return Array.isArray(list) ? list.filter((e) => e.handle) : [];
  } catch {
    return [];
  }
}

// 書けないときは覚えないだけにする (ファイルを開く・保存すること自体は止めない)
async function writeList(list: RecentFile[]): Promise<void> {
  try {
    if (isTauri()) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list.map(({ name, path }) => ({ name, path }))));
      return;
    }
    if (!canReopenFiles() || typeof indexedDB === "undefined") return;
    await withStore("readwrite", (s) => s.put(list, DB_KEY));
  } catch {
    // 覚えられなくても困らない
  }
}

async function sameFile(a: RecentFile, b: RecentFile): Promise<boolean> {
  if (a.path !== undefined || b.path !== undefined) return a.path === b.path;
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

/** 最近開いたファイル (新しい順) */
export function loadRecentFiles(): Promise<RecentFile[]> {
  return readList();
}

/** 開いた・保存したファイルを一覧の先頭に足す。path は Tauri ではパス、ブラウザでは "browser:<番号>" */
export async function addRecentFile(file: { path: string | null; name: string }): Promise<void> {
  if (!file.path) return;
  let entry: RecentFile;
  if (isTauri()) entry = { name: file.name, path: file.path };
  else {
    const handle = handleOf(file.path);
    if (!handle) return;
    entry = { name: file.name, handle };
  }
  const rest = await without(await readList(), entry);
  await writeList([entry, ...rest].slice(0, RECENT_LIMIT));
}

/** 一覧から外す (消えたファイルなど) */
export async function removeRecentFile(file: RecentFile): Promise<void> {
  await writeList(await without(await readList(), file));
}

export async function clearRecentFiles(): Promise<void> {
  await writeList([]);
}

// requestPermission は lib.dom に型が無いので、使う分だけ書く
interface PermissionedHandle {
  queryPermission?: (d: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
}

/** 一覧のファイルを読み直す。ブラウザでは、上書き保存できるよう読み書きの許可を求める (メニューのクリックの中で呼ぶ) */
export async function readRecentFile(file: RecentFile): Promise<OpenedFile> {
  if (file.path !== undefined) {
    const text = await invoke<string>("read_model_file", { path: file.path });
    return { path: file.path, name: baseName(file.path), text };
  }
  const handle = file.handle!;
  const p = handle as unknown as PermissionedHandle;
  if (p.queryPermission && (await p.queryPermission({ mode: "readwrite" })) !== "granted") {
    if (p.requestPermission && (await p.requestPermission({ mode: "readwrite" })) !== "granted") {
      throw new Error("ファイルを読み書きする許可がありません");
    }
  }
  const f = await handle.getFile();
  return { path: rememberHandle(handle), name: f.name, text: await f.text() };
}
