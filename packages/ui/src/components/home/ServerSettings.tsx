import { useState, type FormEvent } from "react";
import { useSessionStore } from "../../cloud/session";
import { getPlatform } from "../../platform";
import { SERVER_INPUT_ID } from "./LoginPanel";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * サーバーの設定 (設計書 8.4。デスクトップだけ)。使うサーバーの URL を入れて保存する。
 * 変えるとログアウトする (別のサーバーにトークンを送らないため)。Web は自分のオリジンなので出さない
 */
export function ServerSettings() {
  const platform = getPlatform();
  const status = useSessionStore((s) => s.status);
  const [value, setValue] = useState(platform.serverOrigin());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (platform.kind !== "desktop" || !platform.setServerOrigin) return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await useSessionStore.getState().setServer(value.trim());
      // 保存された形 (パスなどを落としたオリジン) に直す
      setValue(getPlatform().serverOrigin());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const current = platform.serverOrigin();
  return (
    <section className="home-section" aria-label="サーバーの設定">
      <h2>サーバーの設定</h2>
      <p className="home-note">
        クラウドの機能で使うサーバーの URL です{current ? `(いま: ${current})` : "(まだ設定されていません)"}。
        {status === "signedIn" && "変えるとログアウトします。"}
      </p>
      <form className="home-actions" onSubmit={(e) => void save(e)}>
        <input
          id={SERVER_INPUT_ID}
          aria-label="サーバーの URL"
          placeholder="https://untie.example.com"
          value={value}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" disabled={busy || !value.trim()}>
          保存
        </button>
      </form>
      {error && <p className="field-error">{error}</p>}
    </section>
  );
}
