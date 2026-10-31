import type { ProviderId } from "@untie/api";
import { useSessionStore } from "../../cloud/session";

/** ログイン方法ごとのボタンの文言。サーバーが教えた方法のうち、ここに載っているものだけ出す */
const PROVIDER_LABELS: Record<ProviderId, string> = {
  google: "Google でログイン",
  dev: "開発用ログイン (メールを入れるだけ)",
};

/** ホームのクラウド欄: ログインの案内。サーバー未設定・確認中・未ログインの出し分けもここ */
export function LoginPanel() {
  const status = useSessionStore((s) => s.status);
  const hasServer = useSessionStore((s) => s.hasServer);
  const providers = useSessionStore((s) => s.providers);
  const error = useSessionStore((s) => s.error);
  const login = useSessionStore((s) => s.login);
  const load = useSessionStore((s) => s.load);

  if (status === "unknown") return <p className="home-note">確認中…</p>;
  if (!hasServer) return <p className="home-note">サーバーが設定されていないため、クラウドの機能は使えません</p>;

  const known = providers.filter((p) => p in PROVIDER_LABELS);
  return (
    <div className="home-login">
      <p className="home-note">ログインすると、ファイルをクラウドに置いて、どの端末からでも開けます。</p>
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
            <button key={p} type="button" className={p === "google" ? "primary" : undefined} onClick={() => void login(p)}>
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
      ) : (
        !error && <p className="home-note">使えるログイン方法がありません。</p>
      )}
    </div>
  );
}
