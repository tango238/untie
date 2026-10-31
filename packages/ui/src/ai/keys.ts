// API キーの読み書き。置き場所は Platform の secrets が決める
// (デスクトップアプリは OS のキーチェーン、ブラウザはタブの間のメモリと、選んだときだけ localStorage)。
import { getPlatform } from "../platform";
import type { ProviderId } from "./providers";

export async function getApiKey(provider: ProviderId): Promise<string | null> {
  return getPlatform().secrets.get(provider);
}

/** remember はブラウザだけで使う: true ならこのブラウザに保存し、false ならこのタブの間だけ覚える */
export async function setApiKey(provider: ProviderId, key: string, { remember = false }: { remember?: boolean } = {}): Promise<void> {
  await getPlatform().secrets.set(provider, key, { remember });
}

export async function deleteApiKey(provider: ProviderId): Promise<void> {
  await getPlatform().secrets.delete(provider);
}

/** ブラウザで、この API キーをブラウザに保存しているか */
export function isApiKeyRemembered(provider: ProviderId): boolean {
  return getPlatform().secrets.isRemembered(provider);
}
