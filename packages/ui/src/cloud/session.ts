// ログインの状態 (設計書 8.2 の session)。起動時に load() で決める。
import { create } from "zustand";
import { ApiError, type ProviderId, type User } from "@untie/api";
import { getPlatform, parseServerOrigin } from "../platform";
import { resumePendingRoute, toLoginReturn } from "../router";
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
  /** ログインを始める (Web は別のページへ移り、デスクトップは既定のブラウザを開く)。戻り先は省略するといまの画面 (ハッシュ)。始められたら true */
  login: (provider: ProviderId, returnTo?: string) => Promise<boolean>;
  /**
   * サーバーの URL を変える (デスクトップ)。不正な URL なら Error を投げる。オリジンが同じなら何もしない。
   * 変えるときは、ログイン中なら先に (いまのサーバーで) ログアウトを試す。失敗しても進める。セッションは消えるので、状態を作り直す
   */
  setServer: (url: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toast = (message: string) => useUntieStore.getState().pushToast(message, "error");

/** 手元のセッションを消す。消せなくても (キーチェーンの失敗など) 画面はログアウトさせ、理由だけ知らせる */
async function clearLocalSession(): Promise<void> {
  try {
    await getPlatform().clearSession();
  } catch (e) {
    toast(`保存していたログイン情報を消せませんでした: ${messageOf(e)}`);
  }
}

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
      if (e instanceof ApiError && e.status === 0 && getPlatform().kind === "desktop") {
        // デスクトップは、サーバーにつながらなくても、この端末のトークンは消せる(サーバー側の行は残る)
        toast("サーバーにつながらないため、この端末のログイン情報だけ消しました");
      } else if (!(e instanceof ApiError && e.status === 401)) {
        toast(messageOf(e));
        return;
      }
    } finally {
      ending = false;
    }
    // 手元のセッション (デスクトップはキーチェーンのトークン) も消す。サーバー側の行はもう無い
    await clearLocalSession();
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

    login: async (provider, returnTo) => {
      try {
        // 招待・リンクのトークンは、ログインの URL に載せない (サーバーのログに残る)。預けて、戻り先はトークンなしにする
        await getPlatform().login(provider, toLoginReturn(returnTo ?? (window.location.hash || "#/")));
        return true;
      } catch (e) {
        toast(messageOf(e));
        return false;
      }
    },

    setServer: async (url) => {
      const platform = getPlatform();
      // 検証に通らなければここで Error (ログアウトする前に)。オリジンが変わらなければ何もしない
      const origin = parseServerOrigin(url);
      if (origin === platform.serverOrigin()) return;
      // いまのサーバーにログインしているなら、先に行を消してもらう。つながらなくても進める (手元のトークンは Platform が消す)
      if (get().status === "signedIn") {
        ending = true;
        try {
          await getApi().logout();
        } catch {
          // ログアウトできなくても、サーバーを変えることはできる
        } finally {
          ending = false;
        }
      }
      // 通ればセッションは Platform が消している
      await platform.setServerOrigin?.(url);
      set({ status: "unknown", user: null, providers: [], error: null });
      notifyUnauthorized();
      await get().load();
    },

    logout: () => end(() => getApi().logout()),
    logoutAll: () => end(() => getApi().logoutAll()),
  };
});

/**
 * デスクトップ: ブラウザのログインが戻ってきたら (deep link・引換コード)、戻り先の画面へ移ってログインの状態を読み直す。
 * 失敗はトーストで知らせる。Root が起動時に 1 度つなぐ。Web には通知が無いので何もしない。戻り値で外す
 */
export function listenForPlatformLogin(): () => void {
  const off = getPlatform().onLoggedIn?.((result) => {
    if (!result.ok) {
      toast(result.message);
      return;
    }
    resumePendingRoute();
    void useSessionStore.getState().load();
  });
  return off ?? (() => {});
}

// 使っている途中で 401 を受けたら (セッション切れ・別の端末でログアウト)、ログイン欄へ戻す
onUnauthorized(() => {
  const s = useSessionStore.getState();
  if (s.status === "signedIn" && !ending) {
    toast("ログインの有効期限が切れました。もう一度ログインしてください");
    // 効かなくなったトークンを手元に残さない
    void getPlatform().clearSession().catch(() => {});
  }
  if (s.status !== "anonymous") useSessionStore.setState({ status: "anonymous", user: null });
});
