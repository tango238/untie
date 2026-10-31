// サーバーの API クライアント (@untie/api の createApi) を 1 つ作って使い回す。
// サーバーの URL は Platform が持つ (デスクトップでは設定で変わる) ので、変わったら作り直す。
import { createApi, type UntieApi } from "@untie/api";
import { getPlatform } from "../platform";

let cached: { origin: string; api: UntieApi } | null = null;

const unauthorizedListeners = new Set<() => void>();

/**
 * 401 (ログインしていない・セッション切れ) を受けたときに呼ばれる購読口。
 * 使っている途中でセッションが切れたら、session ストアがログイン欄へ戻し、files ストアが一覧を空にする。
 * session と files が互いを import しないよう、両者はここだけを介してつながる
 */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** 購読者に「ログイン中ではなくなった」ことを知らせる (401 を受けたときと、ログアウトしたとき) */
export function notifyUnauthorized(): void {
  unauthorizedListeners.forEach((l) => l());
}

/** サーバーが設定されているか (serverOrigin が空なら、クラウドの機能は使えない) */
export function hasServer(): boolean {
  return getPlatform().serverOrigin() !== "";
}

/** API クライアント。呼び出しのたびに Platform を引くので、authorize は差し替えた Platform に追従する */
export function getApi(): UntieApi {
  const platform = getPlatform();
  const origin = platform.serverOrigin();
  if (!cached || cached.origin !== origin) {
    cached = {
      origin,
      api: createApi({
        baseUrl: origin,
        authorize: (init) => getPlatform().authorize(init),
        // 呼び出しのたびに globalThis.fetch を引く。401 の応答はここで 1 か所に集めて知らせる
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          if (response.status === 401) notifyUnauthorized();
          return response;
        },
      }),
    };
  }
  return cached.api;
}
