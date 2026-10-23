// ファイルの読み書きと、外部リンクを開く処理。
// デスクトップアプリ (Tauri) ではダイアログとネイティブのファイル操作を、ブラウザではファイル選択とダウンロードを使う。
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

const baseName = (path: string) => path.split(/[\\\\/]/).pop() ?? path;

/** ファイルを選んで中身を読む。取り消したら null */
export async function openTextFile(): Promise<OpenedFile | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Untie モデル", extensions: [FILE_EXTENSION] }] });
    if (typeof path !== "string") return null;
    const text = await invoke<string>("read_model_file", { path });
    return { path, name: baseName(path), text };
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
 * 中身を書き出す。path があればそこへ上書きし、無ければ保存先を選ぶ (ブラウザではダウンロード)。
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
export async function confirmDiscard(message: string): Promise<boolean> {
  if (isTauri()) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(message, { title: "Untie", kind: "warning", okLabel: "破棄して続ける", cancelLabel: "キャンセル" });
  }
  return window.confirm(message);
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
