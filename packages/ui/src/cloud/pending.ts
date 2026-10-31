// ログインの往復のあいだ、招待・リンクのトークンを預ける置き場 (設計書 8.1)。
// トークンをログインの URL (`/auth/login?return=...`) に載せるとサーバーのログに残るので、
// returnTo には `#/invite` `#/link` (トークンなし) だけを渡し、トークンは sessionStorage に置いて、戻ってから読んで消す。

/** 預けられるもの。値は sessionStorage のキー */
const KEYS = { invite: "untie.pendingInvite", link: "untie.pendingLink" } as const;
export type PendingKind = keyof typeof KEYS;

const storage = (): Storage | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // ストレージを使えないブラウザ設定
    return null;
  }
};

/** トークンを預ける。預けられなければ false (戻ったあと、画面はホームのまま) */
export function stashPending(kind: PendingKind, token: string): boolean {
  try {
    storage()?.setItem(KEYS[kind], token);
    return storage() !== null;
  } catch {
    return false;
  }
}

/** 預けたトークンを取り出して消す。無ければ null */
export function takePending(kind: PendingKind): string | null {
  try {
    const s = storage();
    const token = s?.getItem(KEYS[kind]) ?? null;
    s?.removeItem(KEYS[kind]);
    return token;
  } catch {
    return null;
  }
}
