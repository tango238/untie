import { useState } from "react";
import type { ProviderId } from "@untie/api";
import { useSessionStore } from "../../cloud/session";
import { getPlatform } from "../../platform";
import { DesktopLoginWait } from "./DesktopLoginWait";

/** ログイン方法ごとのボタンの文言。サーバーが教えた方法のうち、ここに載っているものだけ出す */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  google: "Google でログイン",
  dev: "開発用ログイン (メールを入れるだけ)",
};

/** デスクトップでは、押すとブラウザが開くことを添える */
const DESKTOP_PROVIDER_LABELS: Record<ProviderId, string> = {
  google: "Google でログイン (ブラウザが開きます)",
  dev: "開発用ログイン (ブラウザが開きます)",
};

/** サーバーの設定の入力欄 (ServerSettings) の id。「サーバーを設定する」から飛ぶ */
export const SERVER_INPUT_ID = "server-origin-input";

/** ログイン方法のボタンの文言。デスクトップでは、ブラウザが開くことを添える */
export const providerLabels = (desktop: boolean) => (desktop ? DESKTOP_PROVIDER_LABELS : PROVIDER_LABELS);

/**
 * ログインの案内。サーバー未設定・確認中・未ログインの出し分けもここ。
 * `returnTo` はログイン後に戻る画面 (ハッシュ。省略するといまの画面)、`message` は案内の文言 (省略するとホームの文言)
 */
export function LoginPanel({ returnTo, message }: { returnTo?: string; message?: string } = {}) {
  const status = useSessionStore((s) => s.status);
  const hasServer = useSessionStore((s) => s.hasServer);
  const providers = useSessionStore((s) => s.providers);
  const error = useSessionStore((s) => s.error);
  const login = useSessionStore((s) => s.login);
  const load = useSessionStore((s) => s.load);
  const platform = getPlatform();
  const desktop = platform.kind === "desktop";
  // デスクトップ: ブラウザを開いて戻りを待っている間 (引換コードを貼る欄を出す)
  const [waiting, setWaiting] = useState(false);

  if (status === "unknown") return <p className="home-note">確認中…</p>;
  if (!hasServer) {
    return (
      <p className="home-note">
        サーバーが設定されていないため、クラウドの機能は使えません
        {desktop && (
          <>
            {" "}
            <button type="button" className="link" onClick={() => document.getElementById(SERVER_INPUT_ID)?.focus()}>
              サーバーを設定する
            </button>
          </>
        )}
      </p>
    );
  }

  const known = providers.filter((p) => p in PROVIDER_LABELS);
  const labels = providerLabels(desktop);

  const start = async (provider: ProviderId) => {
    const started = await login(provider, returnTo);
    if (started && desktop) setWaiting(true);
  };

  return (
    <div className="home-login">
      <p className="home-note">{message ?? "ログインすると、ファイルをクラウドに置いて、どの端末からでも開けます。"}</p>
      {error && (
        <p className="field-error">
          {error}{" "}
          <button type="button" className="link" onClick={() => void load()}>
            もう一度確かめる
          </button>
        </p>
      )}
      {known.length > 0 ? (
        <div className="home-login-buttons">
          {known.map((p) => (
            <button key={p} type="button" className={p === "google" ? "primary" : undefined} onClick={() => void start(p)}>
              {labels[p]}
            </button>
          ))}
        </div>
      ) : (
        !error && <p className="home-note">使えるログイン方法がありません。</p>
      )}
      {desktop && waiting && <DesktopLoginWait onClose={() => setWaiting(false)} />}
    </div>
  );
}
