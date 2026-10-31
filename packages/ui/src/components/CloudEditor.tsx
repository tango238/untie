import { useEffect, useRef, useState } from "react";
import { ApiError, CLOSE_ROLE_CHANGED, ROLE_LABELS } from "@untie/api";
import App from "../App";
import { useAgentStore } from "../ai/agentStore";
import { getApi } from "../cloud/api";
import { closeCloudFile, openCloudFile } from "../cloud/collab";
import { confirmDiscardIfDirty } from "../io/document";
import { useSessionStore } from "../cloud/session";
import { navigate, replaceRoute } from "../router";
import { useUntieStore } from "../store";
import { ToastHost } from "./Toast";

/** 読み込みがこの時間を過ぎても終わらないときは、つながっていないことを伝える */
const SLOW_MS = 15_000;

const goHome = () => navigate({ name: "home" });
const toast = (message: string, tone: "info" | "error" = "error") => useUntieStore.getState().pushToast(message, tone);

/**
 * チケットを取れなかったときの扱い。ホームへ戻し、理由を出す (設計書 8.3)。
 * 401 は session ストアがログイン欄へ戻して知らせるので、ここでは何も出さない。
 * リンクで開いたとき (link) の 404 は、リンクが無効になっている (無効にされた・作り直された)
 */
function failToOpen(e: unknown, link: boolean): void {
  if (link && e instanceof ApiError && e.status === 404) {
    toast("このリンクは無効です");
  } else if (e instanceof ApiError && e.status === 401) {
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

/**
 * クラウドファイルを開く画面。開いている間だけ接続し、読み込めたらエディタ (App) を出す。
 * `fileId` は #/f/<id> (メンバーとして開く。ログインが要る)、`link` は #/link/<token>
 * (リンクを知っている人の閲覧。ログインしていなくてもよい。メンバーならその役割で開く)
 */
export function CloudEditor({ fileId, link }: { fileId?: string; link?: string }) {
  const sessionStatus = useSessionStore((s) => s.status);
  // リンクで開くときは、トークンからファイルの id を引いてから接続する
  const [linked, setLinked] = useState<{ token: string; fileId: string } | null>(null);
  const targetId = link !== undefined ? (linked?.token === link ? linked.fileId : undefined) : fileId;
  const loaded = useUntieStore((s) => targetId !== undefined && s.cloud !== null && s.cloud.fileId === targetId && s.cloud.status !== "loading");
  const closed = useUntieStore((s) => (targetId !== undefined && s.cloud?.fileId === targetId ? s.cloud.closed : undefined));
  const [slow, setSlow] = useState(false);
  // 役割が変わって閉じられたとき (4001) に、その場でつなぎ直す処理。開く effect が差し込む
  const reopen = useRef<(() => Promise<void>) | null>(null);

  // この画面の間にログインしていたか。使っている途中で anonymous になった (401・ログアウト) ときは、
  // session ストアが理由を出すので、ここでは重ねて出さない
  const wasSignedIn = useRef(false);

  // ログインしていなければホームへ (ログイン欄を出す)。ログインの状態が分かるまでは待つ。リンクで開くときは不要
  useEffect(() => {
    if (sessionStatus === "signedIn") wasSignedIn.current = true;
    if (link !== undefined || sessionStatus !== "anonymous") return;
    if (!wasSignedIn.current) toast("クラウドのファイルを開くにはログインしてください");
    goHome();
  }, [sessionStatus, link]);

  // 開いている間だけつなぐ。離れたら (別の画面・別のファイル・ログアウト) 閉じてサンプルに戻す
  useEffect(() => {
    // リンクはログインしていなくても開ける。どちらもログインの状態が分かってから始める (名前と役割が決まるため)
    if (link === undefined ? sessionStatus !== "signedIn" : sessionStatus === "unknown") return;
    let cancelled = false;
    let openedId: string | undefined;
    const connect = (id: string) => (link === undefined ? openCloudFile(id) : openCloudFile(id, { link }));
    void (async () => {
      try {
        let id = fileId;
        if (link !== undefined) {
          const info = await getApi().links.get(link);
          if (cancelled) return;
          // メンバー (所有者を含む) がリンクで開いても、リンクのままだと閲覧のチケット (via: "link") になり、
          // リンクの無効化でも切られてしまう。メンバーとして開き直し、アドレスバーからトークンも消す
          // (確認はこの先の #/f/<id> が行う。ここで聞くと二度聞くことになる)
          if (info.role !== "guest") {
            replaceRoute({ name: "file", fileId: info.fileId });
            return;
          }
          setLinked({ token: link, fileId: info.fileId });
          id = info.fileId;
        }
        // 開くとストアのローカルの編集中のモデルは置き換わる。戻る/進む・URL の直打ちで来たときも守るため、
        // 保存していない変更があれば先に確かめ、断られたらローカルの編集へ戻す
        if (!(await confirmDiscardIfDirty("保存していない変更があります。破棄してクラウドのファイルを開きますか？", "破棄して開く"))) {
          if (!cancelled) navigate({ name: "local" });
          return;
        }
        if (cancelled) return;
        openedId = id!;
        reopen.current = async () => {
          try {
            await connect(openedId!);
            if (cancelled) return;
            const role = useUntieStore.getState().cloud?.role;
            if (role) toast(`役割が${ROLE_LABELS[role]}に変わりました`, "info");
          } catch (e) {
            if (!cancelled) failToOpen(e, link !== undefined);
          }
        };
        await connect(openedId);
      } catch (e) {
        if (!cancelled) failToOpen(e, link !== undefined);
      }
    })();
    return () => {
      cancelled = true;
      reopen.current = null;
      // 走っている AI エージェントはモデルを書き換え続けてしまうので止める
      useAgentStore.getState().cancel();
      closeCloudFile();
    };
  }, [fileId, link, sessionStatus]);

  // サーバーに閉じられた (外された・ゴミ箱・リンクの無効化・認証切れ) ら、理由を出してホームへ。
  // 役割が変わっただけ (4001) なら、ホームへは戻さず、新しい役割でその場につなぎ直す
  useEffect(() => {
    if (!closed) return;
    if (closed.code === CLOSE_ROLE_CHANGED && reopen.current) {
      void reopen.current();
      return;
    }
    toast(closed.reason);
    goHome();
  }, [closed]);

  useEffect(() => {
    if (loaded) return;
    setSlow(false);
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [loaded, targetId]);

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
