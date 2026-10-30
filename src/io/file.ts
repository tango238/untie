// ファイルの読み書きと、外部リンクを開く処理。
// デスクトップアプリ (Tauri) ではダイアログとネイティブのファイル操作を使う。
// ブラウザでは、File System Access API があれば (Chrome・Edge) 開いたファイルに上書きし、無ければファイル選択とダウンロードを使う。
import { invoke } from "@tauri-apps/api/core";

export const FILE_EXTENSION = "json";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface OpenedFile {
  path: string | null;
  name: string;
  text: string;
}

export const baseName = (path: string) => path.split(/[\\\\/]/).pop() ?? path;

// File System Access API (lib.dom に型が無いので、使う分だけ書く)
interface FilePickerWindow {
  showOpenFilePicker?: (options: object) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options: object) => Promise<FileSystemFileHandle>;
}
const pickerWindow = () => window as unknown as FilePickerWindow;
const PICKER_TYPES = [{ description: "Untie モデル", accept: { "application/json": [`.${FILE_EXTENSION}`] } }];
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

// ブラウザで開いた・保存したファイルのハンドル。ストアの path にはハンドルの代わりに "browser:<番号>" を入れる
const handles = new Map<string, FileSystemFileHandle>();
let handleSeq = 0;
export function rememberHandle(handle: FileSystemFileHandle): string {
  const key = `browser:${++handleSeq}`;
  handles.set(key, handle);
  return key;
}

/** rememberHandle で覚えたハンドル */
export function handleOf(path: string): FileSystemFileHandle | undefined {
  return handles.get(path);
}

/** ファイルを開く・保存する場所をあとから指し直せるか (Tauri か、File System Access API のあるブラウザ) */
export function canReopenFiles(): boolean {
  return isTauri() || !!pickerWindow().showOpenFilePicker;
}

async function writeHandle(handle: FileSystemFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

/** ファイルを選んで中身を読む。取り消したら null */
export async function openTextFile(): Promise<OpenedFile | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Untie モデル", extensions: [FILE_EXTENSION] }] });
    if (typeof path !== "string") return null;
    const text = await invoke<string>("read_model_file", { path });
    return { path, name: baseName(path), text };
  }
  // window から外して呼ぶと Illegal invocation になるので、window.showOpenFilePicker として呼ぶ
  const picker = pickerWindow();
  if (picker.showOpenFilePicker) {
    try {
      const [handle] = await picker.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
      if (!handle) return null;
      const file = await handle.getFile();
      return { path: rememberHandle(handle), name: file.name, text: await file.text() };
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
}

/**
 * 中身を書き出す。path があればそこへ上書きし、無ければ保存先を選ぶ
 * (File System Access API の無いブラウザでは、いつもダウンロード)。
 * 保存先を選ぶのを取り消したら null
 */
export async function saveTextFile(text: string, path: string | null, suggestedName: string): Promise<{ path: string | null; name: string } | null> {
  if (isTauri()) {
    let target = path;
    if (!target) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      target = await save({ defaultPath: suggestedName, filters: [{ name: "Untie モデル", extensions: [FILE_EXTENSION] }] });
      if (!target) return null;
    }
    await invoke("write_model_file", { path: target, contents: text });
    return { path: target, name: baseName(target) };
  }
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
    return { path: rememberHandle(handle), name: handle.name };
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { path: null, name: suggestedName };
}

/** 未保存の変更を捨ててよいかを聞く */
export async function confirmDiscard(message: string, okLabel = "破棄して続ける"): Promise<boolean> {
  if (isTauri()) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(message, { title: "Untie", kind: "warning", okLabel, cancelLabel: "キャンセル" });
  }
  return window.confirm(message);
}

/** 文字列をクリップボードに写す */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** 外部リンクを既定のブラウザで開く */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}
