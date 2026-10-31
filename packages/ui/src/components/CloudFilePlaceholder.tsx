import { navigate } from "../router";
import { ToastHost } from "./Toast";

/** クラウドファイルを開く画面。同時編集は次の段階で作るので、いまは案内だけ出す */
export function CloudFilePlaceholder({ fileId }: { fileId: string }) {
  return (
    <div className="home">
      <header className="home-header">
        <h1 className="home-title">Untie</h1>
      </header>
      <main className="home-main">
        <section className="home-section" aria-label="クラウドファイル">
          <h2>クラウドファイル</h2>
          <p className="home-note">同時編集は次の段階で対応します。(ファイル ID: {fileId})</p>
          <div className="home-actions">
            <button type="button" onClick={() => navigate({ name: "home" })}>
              ホームへ戻る
            </button>
          </div>
        </section>
      </main>
      <ToastHost />
    </div>
  );
}
