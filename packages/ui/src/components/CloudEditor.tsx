import { useEffect, useRef, useState } from "react";
import { ApiError, CLOSE_ROLE_CHANGED, CLOSE_UNAUTHENTICATED, ROLE_LABELS } from "@untie/api";
import App from "../App";
import { useAgentStore } from "../ai/agentStore";
import { getApi } from "../cloud/api";
import { closeCloudFile, openCloudFile } from "../cloud/collab";
import { confirmDiscardIfDirty, exportModelToFile } from "../io/document";
import { useSessionStore } from "../cloud/session";
import { navigate, replaceRoute } from "../router";
import { useUntieStore, type Selection } from "../store";
import { ToastHost } from "./Toast";

/** 読み込みがこの時間を過ぎても終わらないときは、つながっていないことを伝える */
const SLOW_MS = 15_000;

/** つなぎ直す前に、送れていない変更をどうするか聞いた答え */
type UnsentChoice = "export" | "discard";

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
  // つなぎ直す前の「送れていない変更があります」の確認を待っているとき、その答えを返す関数
  const [unsent, setUnsent] = useState<{ answer: (choice: UnsentChoice) => void } | null>(null);
  // 「保存していない変更があります。破棄して…」の確認を出している最中の答え。
  // 開発モード (StrictMode) は effect を 2 回走らせるので、2 回目は新しく聞かず、この答えを待つ (確認ダイアログが 2 回出ない)
  const confirming = useRef<Promise<boolean> | null>(null);

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
    const connect = (id: string, keepUi?: { currentBoardId: string; selection: Selection }) => {
      const options = { ...(link === undefined ? {} : { link }), ...(keepUi ? { keepUi } : {}) };
      return Object.keys(options).length > 0 ? openCloudFile(id, options) : openCloudFile(id);
    };
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
        confirming.current ??= confirmDiscardIfDirty("保存していない変更があります。破棄してクラウドのファイルを開きますか？", "破棄して開く").finally(() => {
          confirming.current = null;
        });
        if (!(await confirming.current)) {
          if (!cancelled) navigate({ name: "local" });
          return;
        }
        if (cancelled) return;
        openedId = id!;
        reopen.current = async () => {
          const before = useUntieStore.getState();
          // 送れていない変更 (つながっていない間の自分の編集) は、つなぎ直すと古い Doc ごと失われる。先に書き出すか聞く
          if (before.cloud?.dirtySinceOffline) {
            for (;;) {
              const choice = await new Promise<UnsentChoice>((answer) => setUnsent({ answer }));
              if (cancelled) return;
              setUnsent(null);
              // 書き出せなかった (取り消し・失敗) ときは、もう一度聞く
              if (choice === "discard" || (await exportModelToFile())) break;
            }
          }
          const beforeRole = before.cloud?.role;
          // 開いているボードと選択は引き継ぐ (参照先が無ければ最初の同期のあとストアが直す)
          const { currentBoardId, selection } = useUntieStore.getState().ui;
          try {
            await connect(openedId!, { currentBoardId, selection });
            if (cancelled) return;
            const role = useUntieStore.getState().cloud?.role;
            // 実際に役割が変わったときだけ知らせる
            if (role && role !== beforeRole) toast(`役割が${ROLE_LABELS[role]}に変わりました`, "info");
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
      setUnsent(null);
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
    // 認証が切れた (ログアウト・セッションの削除) ときは、ログインの状態を取り直す。ホームがログイン欄を出す
    if (closed.code === CLOSE_UNAUTHENTICATED) void useSessionStore.getState().load();
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
  return (
    <>
      <App />
      {unsent && <UnsentChangesDialog onChoose={unsent.answer} />}
    </>
  );
}

/** 役割が変わってつなぎ直す前に、まだサーバーに送れていない変更をどうするか聞く。つなぎ直すと古い Doc ごと失われる (設計書 8.3) */
function UnsentChangesDialog({ onChoose }: { onChoose: (choice: UnsentChoice) => void }) {
  const exportRef = useRef<HTMLButtonElement>(null);
  useEffect(() => exportRef.current?.focus(), []);
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="送れていない変更">
        <h2>送れていない変更があります</h2>
        <p>送れていない変更があります。JSON に書き出しますか</p>
        <p className="hint">役割が変わったため、つなぎ直します。書き出さずに続けると、サーバーに届いていない変更は失われます。</p>
        <div className="dialog-actions">
          <button type="button" className="primary" ref={exportRef} onClick={() => onChoose("export")}>
            書き出す
          </button>
          <button type="button" className="danger" onClick={() => onChoose("discard")}>
            捨てて続ける
          </button>
        </div>
      </div>
    </div>
  );
}
