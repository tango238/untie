// API キーの読み書き。デスクトップアプリでは OS のキーチェーン (Rust のコマンド) に置く。
// ブラウザ (開発用) ではキーチェーンが無いので、このタブの間だけメモリに持つ。
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../io/file";
import type { ProviderId } from "./providers";

const memory = new Map<ProviderId, string>();

export async function getApiKey(provider: ProviderId): Promise<string | null> {
  if (isTauri()) return (await invoke<string | null>("get_api_key", { provider })) ?? null;
  return memory.get(provider) ?? null;
}

export async function setApiKey(provider: ProviderId, key: string): Promise<void> {
  if (isTauri()) {
    await invoke("set_api_key", { provider, key });
    return;
  }
  memory.set(provider, key.trim());
}

export async function deleteApiKey(provider: ProviderId): Promise<void> {
  if (isTauri()) {
    await invoke("delete_api_key", { provider });
    return;
  }
  memory.delete(provider);
}
