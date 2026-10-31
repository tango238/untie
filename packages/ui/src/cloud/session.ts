// ログインの状態 (設計書 8.2 の session)。起動時に load() で決める。
import { create } from "zustand";
import { ApiError, type ProviderId, type User } from "@untie/api";
import { getPlatform } from "../platform";
import { useUntieStore } from "../store";
import { getApi, hasServer, notifyUnauthorized, onUnauthorized } from "./api";

export type SessionStatus = "unknown" | "anonymous" | "signedIn";

export interface SessionState {
  status: SessionStatus;
  user: User | null;
  /** 使えるログイン方法 (サーバーが教える) */
  providers: ProviderId[];
  /** サーバーが設定されているか */
  hasServer: boolean;
  /** 直近の失敗 (つながらないなど) */
  error: string | null;

  /** サーバーに聞いて状態を決める。サーバー未設定なら anonymous で providers は空。実行中に重ねて呼んでも 1 回だけ叩く */
  load: () => Promise<void>;
  /** ログインを始める (Web は別のページへ移る) */
  login: (provider: ProviderId) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toast = (message: string) => useUntieStore.getState().pushToast(message, "error");

/** ログアウトの API を呼んでいる間か (このときの 401 は「期限切れ」の知らせにしない) */
let ending = false;

/** 実行中の load。重なった呼び出しはこれを待つ */
let loading: Promise<void> | null = null;

export const useSessionStore = create<SessionState>()((set, get) => {
  async function doLoad(): Promise<void> {
    if (!hasServer()) {
      set({ status: "anonymous", user: null, providers: [], hasServer: false, error: null });
      return;
    }
    set({ hasServer: true, error: null });
    const api = getApi();
    // ログイン方法は未ログインの画面に出すもの。取れなくても、ログイン済みかどうかは別に確かめる
    const [providers, me] = await Promise.all([
      api.providers().then(
        (r) => ({ list: r.providers }),
        () => ({ list: [] as ProviderId[], failed: true }),
      ),
      api.me().then(
        (user) => ({ user }),
        (error: unknown) => ({ error }),
      ),
    ]);
    if ("user" in me) {
      set({ status: "signedIn", user: me.user, providers: providers.list, error: null });
      return;
    }
    // 401 は「ログインしていない」だけで、失敗ではない
    const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
    const error = unauthenticated ? ("failed" in providers ? "ログイン方法を取得できませんでした" : null) : messageOf(me.error);
    set({ status: "anonymous", user: null, providers: providers.list, error });
  }

  /** ログアウトの API を呼ぶ。401 (もうログインしていない) は成功とみなし、手元の状態を消す */
  async function end(call: () => Promise<void>): Promise<void> {
    ending = true;
    try {
      await call();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) {
        toast(messageOf(e));
        return;
      }
    } finally {
      ending = false;
    }
    set({ status: "anonymous", user: null, error: null });
    notifyUnauthorized();
    await get().load();
  }

  return {
    status: "unknown",
    user: null,
    providers: [],
    hasServer: false,
    error: null,

    load: () => {
      loading ??= doLoad().finally(() => {
        loading = null;
      });
      return loading;
    },

    login: async (provider) => {
      try {
        await getPlatform().login(provider, window.location.hash || "#/");
      } catch (e) {
        toast(messageOf(e));
      }
    },

    logout: () => end(() => getApi().logout()),
    logoutAll: () => end(() => getApi().logoutAll()),
  };
});

// 使っている途中で 401 を受けたら (セッション切れ・別の端末でログアウト)、ログイン欄へ戻す
onUnauthorized(() => {
  const s = useSessionStore.getState();
  if (s.status === "signedIn" && !ending) toast("ログインの有効期限が切れました。もう一度ログインしてください");
  if (s.status !== "anonymous") useSessionStore.setState({ status: "anonymous", user: null });
});
