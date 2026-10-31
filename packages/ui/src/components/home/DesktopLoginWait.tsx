import { useState, type FormEvent } from "react";
import { getPlatform } from "../../platform";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * デスクトップ: ブラウザを開いてログインの戻りを待っている間の案内と、引換コードを貼る欄 (設計書 8.4)。
 * deep link が開けないときの経路で、ホームのログイン欄 (LoginPanel) とリンクで閲覧中の帯 (LinkGuestNotice) が共用する。
 * `onClose` は「やめる」と、引換コードでログインできたときに呼ぶ。戻りが deep link で終わったときは、親が欄ごと消す
 */
export function DesktopLoginWait({ onClose }: { onClose: () => void }) {
  const platform = getPlatform();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!platform.completeLoginWithCode) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !platform.completeLoginWithCode) return;
    setBusy(true);
    try {
      // 成功すると Platform が onLoggedIn で知らせ、ログインの状態を読み直す
      await platform.completeLoginWithCode(code.trim());
      setCode("");
      setError(null);
      onClose();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="home-login-code" onSubmit={(e) => void submit(e)}>
      <p className="home-note" role="status">
        ブラウザでログインしています… 戻らない場合は、ブラウザの画面に出た引換コードを貼ってください。
      </p>
      <div className="home-actions">
        <input
          aria-label="引換コード"
          placeholder="引換コードを貼る"
          value={code}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy || !code.trim()}>
          ログインする
        </button>
        <button type="button" onClick={onClose}>
          やめる
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
    </form>
  );
}
