import { useEffect, useRef, useState } from "react";
import { ApiError } from "@untie/api";
import App from "../App";
import { useAgentStore } from "../ai/agentStore";
import { closeCloudFile, openCloudFile } from "../cloud/collab";
import { confirmDiscardIfDirty } from "../io/document";
import { useSessionStore } from "../cloud/session";
import { navigate } from "../router";
import { useUntieStore } from "../store";
import { ToastHost } from "./Toast";

/** 読み込みがこの時間を過ぎても終わらないときは、つながっていないことを伝える */
const SLOW_MS = 15_000;

const goHome = () => navigate({ name: "home" });
const toast = (message: string) => useUntieStore.getState().pushToast(message, "error");

/**
 * チケットを取れなかったときの扱い。ホームへ戻し、理由を出す (設計書 8.3)。
 * 401 は session ストアがログイン欄へ戻して知らせるので、ここでは何も出さない
 */
function failToOpen(e: unknown): void {
  if (e instanceof ApiError && e.status === 401) {
    // ホームのログイン欄へ
  } else if (e instanceof ApiError && e.status === 409) {
    toast("ゴミ箱の中のファイルです");
  } else if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
    toast("このファイルは開けません");
  } else {
    toast(e instanceof Error ? e.message : String(e));
  }
  goHome();
}

/** クラウドファイルを開く画面 (#/f/<id>)。開いている間だけ接続し、読み込めたらエディタ (App) を出す */
export function CloudEditor({ fileId }: { fileId: string }) {
  const sessionStatus = useSessionStore((s) => s.status);
  const loaded = useUntieStore((s) => s.cloud !== null && s.cloud.fileId === fileId && s.cloud.status !== "loading");
  const closed = useUntieStore((s) => (s.cloud?.fileId === fileId ? s.cloud.closed : undefined));
  const [slow, setSlow] = useState(false);

  // この画面の間にログインしていたか。使っている途中で anonymous になった (401・ログアウト) ときは、
  // session ストアが理由を出すので、ここでは重ねて出さない
  const wasSignedIn = useRef(false);

  // ログインしていなければホームへ (ログイン欄を出す)。ログインの状態が分かるまでは待つ
  useEffect(() => {
    if (sessionStatus === "signedIn") wasSignedIn.current = true;
    if (sessionStatus !== "anonymous") return;
    if (!wasSignedIn.current) toast("クラウドのファイルを開くにはログインしてください");
    goHome();
  }, [sessionStatus]);

  // 開いている間だけつなぐ。離れたら (別の画面・別のファイル・ログアウト) 閉じてサンプルに戻す
  useEffect(() => {
    if (sessionStatus !== "signedIn") return;
    let cancelled = false;
    void (async () => {
      // 開くとストアのローカルの編集中のモデルは置き換わる。戻る/進む・URL の直打ちで来たときも守るため、
      // 保存していない変更があれば先に確かめ、断られたらローカルの編集へ戻す
      if (!(await confirmDiscardIfDirty("保存していない変更があります。破棄してクラウドのファイルを開きますか？", "破棄して開く"))) {
        if (!cancelled) navigate({ name: "local" });
        return;
      }
      if (cancelled) return;
      try {
        await openCloudFile(fileId);
      } catch (e) {
        if (!cancelled) failToOpen(e);
      }
    })();
    return () => {
      cancelled = true;
      // 走っている AI エージェントはモデルを書き換え続けてしまうので止める
      useAgentStore.getState().cancel();
      closeCloudFile();
    };
  }, [fileId, sessionStatus]);

  // サーバーに閉じられた (外された・ゴミ箱・リンクの無効化・認証切れ) ら、理由を出してホームへ
  useEffect(() => {
    if (!closed) return;
    toast(closed.reason);
    goHome();
  }, [closed]);

  useEffect(() => {
    if (loaded) return;
    setSlow(false);
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [loaded, fileId]);

  if (!loaded) {
    return (
      <div className="home">
        <header className="home-header">
          <h1 className="home-title">Untie</h1>
        </header>
        <main className="home-main">
          <section className="home-section" aria-label="クラウドファイル">
            <p className="home-note" role="status">
              読み込み中…
            </p>
            {slow && <p className="home-note">サーバーにつながっていません。つながるまで再接続を続けます。</p>}
            <div className="home-actions">
              <button type="button" onClick={goHome}>
                ホームへ戻る
              </button>
            </div>
          </section>
        </main>
        <ToastHost />
      </div>
    );
  }
  return <App />;
}
