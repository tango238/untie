// API キーの読み書き。デスクトップアプリでは OS のキーチェーン (Rust のコマンド) に置く。
// ブラウザではキーチェーンが無いので、ふだんはこのタブの間だけメモリに持ち、
// 「このブラウザに保存する」を選んだときだけ localStorage にも置く。
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../io/file";
import type { ProviderId } from "./providers";

const memory = new Map<ProviderId, string>();

const STORAGE_PREFIX = "untie.apiKey.";

// localStorage はプライベートウィンドウなどで使えないことがあるので、読むときの失敗は「無い」とみなす
function readStored(provider: ProviderId): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + provider);
  } catch {
    return null;
  }
}

function removeStored(provider: ProviderId): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + provider);
  } catch {
    // 使えないなら、もともと置かれていない
  }
}

export async function getApiKey(provider: ProviderId): Promise<string | null> {
  if (isTauri()) return (await invoke<string | null>("get_api_key", { provider })) ?? null;
  return memory.get(provider) ?? readStored(provider);
}

/** remember はブラウザだけで使う: true ならこのブラウザに保存し、false ならこのタブの間だけ覚える */
export async function setApiKey(provider: ProviderId, key: string, { remember = false }: { remember?: boolean } = {}): Promise<void> {
  if (isTauri()) {
    await invoke("set_api_key", { provider, key });
    return;
  }
  const trimmed = key.trim();
  memory.set(provider, trimmed);
  if (!remember) {
    removeStored(provider);
    return;
  }
  try {
    localStorage.setItem(STORAGE_PREFIX + provider, trimmed);
  } catch (e) {
    throw new Error(`このブラウザには保存できませんでした。このタブを閉じるまでは使えます。(${String(e)})`);
  }
}

export async function deleteApiKey(provider: ProviderId): Promise<void> {
  if (isTauri()) {
    await invoke("delete_api_key", { provider });
    return;
  }
  memory.delete(provider);
  removeStored(provider);
}

/** ブラウザで、この API キーをブラウザに保存しているか */
export function isApiKeyRemembered(provider: ProviderId): boolean {
  return !isTauri() && readStored(provider) !== null;
}
