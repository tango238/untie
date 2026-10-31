import { useEffect, useState } from "react";
import { ApiError, ROLE_LABELS, type InvitationInfo } from "@untie/api";
import { getApi } from "../cloud/api";
import { useFilesStore } from "../cloud/files";
import { useSessionStore } from "../cloud/session";
import { formatRoute, navigate, replaceRoute } from "../router";
import { useUntieStore } from "../store";
import { LoginPanel } from "./home/LoginPanel";
import { ToastHost } from "./Toast";

type View =
  | { kind: "loading" }
  | { kind: "ready"; info: InvitationInfo }
  | { kind: "error"; message: string; /** 別のメールアドレス宛 (別のアカウントでログインし直せば受けられる) */ mismatch?: boolean };

const isMismatch = (e: unknown) => e instanceof ApiError && e.status === 403 && e.code === "email_mismatch";

/** 招待を取れなかった・受けられなかった理由を、画面に出す文言にする */
function explain(e: unknown, loginEmail: string | undefined): string {
  if (e instanceof ApiError) {
    if (e.status === 410 && e.code === "invitation_used") return "この招待はすでに使われています";
    if (e.status === 410) return "この招待は期限切れです";
    if (e.status === 403 && e.code === "email_mismatch") return `この招待は別のメールアドレス宛です (いまのログイン: ${loginEmail ?? "不明"})`;
    if (e.status === 404) return "この招待は見つかりません";
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * 招待を受ける画面 (#/invite/<token>、設計書 8.1)。ログインが要る: 未ログインならログイン欄を出し、
 * ログイン後にこの画面へ戻る。招待の中身を確かめて、明示的に「受ける」を押したときだけメンバーになる
 * (ログインしただけでは受理しない)。受けたらそのファイルを開く
 */
export function InvitePage({ token }: { token: string }) {
  const status = useSessionStore((s) => s.status);
  const loginEmail = useSessionStore((s) => s.user?.email);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [accepting, setAccepting] = useState(false);

  // ログインしたら (token が変わったら) 招待の中身を取る
  useEffect(() => {
    if (status !== "signedIn") return;
    let cancelled = false;
    setView({ kind: "loading" });
    getApi()
      .invitations.get(token)
      .then(
        (info) => {
          if (cancelled) return;
          setView(info.expired ? { kind: "error", message: "この招待は期限切れです" } : { kind: "ready", info });
        },
        (e: unknown) => {
          if (!cancelled) setView({ kind: "error", message: explain(e, loginEmail), mismatch: isMismatch(e) });
        },
      );
    return () => {
      cancelled = true;
    };
    // loginEmail は文言にだけ使う。変わっても取り直さない
  }, [token, status]);

  const goHome = () => navigate({ name: "home" });

  const accept = async () => {
    if (accepting) return;
    setAccepting(true);
    try {
      const { fileId } = await getApi().invitations.accept(token);
      void useFilesStore.getState().refresh();
      // 招待の画面は履歴に残さない (戻るで開き直して、使い終わった招待をまた確かめさせない)
      replaceRoute({ name: "file", fileId });
    } catch (e) {
      // 期限切れ・宛先違いは、受ける前に分かっていたときと同じ画面にする。それ以外は押し直せるようトーストにする
      if (e instanceof ApiError && (e.status === 410 || e.status === 403 || e.status === 404)) {
        setView({ kind: "error", message: explain(e, loginEmail), mismatch: isMismatch(e) });
      } else {
        useUntieStore.getState().pushToast(e instanceof Error ? e.message : String(e), "error");
      }
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div className="home">
      <header className="home-header">
        <h1 className="home-title">Untie</h1>
      </header>
      <main className="home-main">
        <section className="home-section" aria-label="招待">
          <h2>招待</h2>
          {status === "unknown" && (
            <p className="home-note" role="status">
              確認中…
            </p>
          )}
          {status === "anonymous" && <LoginPanel returnTo={formatRoute({ name: "invite", token })} message="招待を受けるにはログインしてください。招待されたメールアドレスでログインします。" />}
          {status === "signedIn" && view.kind === "loading" && (
            <p className="home-note" role="status">
              招待を確認しています…
            </p>
          )}
          {status === "signedIn" && view.kind === "error" && (
            <>
              <p className="field-error" role="alert">
                {view.message}
              </p>
              <div className="home-actions">
                {view.mismatch && (
                  // ログアウトすると、この画面のログイン欄 (ログイン後はこの招待へ戻る) になる
                  <button type="button" className="primary" onClick={() => void useSessionStore.getState().logout()}>
                    別のアカウントでログインし直す
                  </button>
                )}
                <button type="button" onClick={goHome}>
                  ホームへ
                </button>
              </div>
            </>
          )}
          {status === "signedIn" && view.kind === "ready" && (
            <>
              <p className="invite-message">
                {view.info.inviterName}さんから「{view.info.fileName}」に{ROLE_LABELS[view.info.role]}として招待されています。
              </p>
              <p className="home-note">
                招待先: <span className="invite-email">{view.info.email}</span>
              </p>
              <div className="home-actions">
                <button type="button" className="primary" disabled={accepting} onClick={() => void accept()}>
                  受ける
                </button>
                <button type="button" disabled={accepting} onClick={goHome}>
                  やめる
                </button>
              </div>
            </>
          )}
        </section>
      </main>
      <ToastHost />
    </div>
  );
}
