import { useEffect, useState } from "react";
import { openDocument, openRecentDocument, openSampleDocument, newEmptyDocument, confirmDiscardIfDirty } from "../../io/document";
import { getPlatform, type RecentFile } from "../../platform";
import { navigate } from "../../router";
import { useSessionStore } from "../../cloud/session";
import { ToastHost } from "../Toast";
import { AccountMenu } from "./AccountMenu";
import { CloudFiles } from "./CloudFiles";
import { LoginPanel } from "./LoginPanel";

/** ホーム画面 (設計書 8.1): ローカルファイルを開く・クラウドのファイルを一覧する */
export default function Home() {
  const status = useSessionStore((s) => s.status);
  const [recent, setRecent] = useState<RecentFile[]>([]);

  useEffect(() => {
    let alive = true;
    void getPlatform()
      .recentFiles.load()
      .then((list) => alive && setRecent(list));
    return () => {
      alive = false;
    };
  }, []);

  // 開けたら (取り消し・失敗でなければ) エディタへ移る
  const thenEdit = async (open: Promise<boolean>) => {
    if (await open) navigate({ name: "local" });
  };
  const createLocal = async () => {
    if (!(await confirmDiscardIfDirty())) return;
    newEmptyDocument();
    navigate({ name: "local" });
  };

  return (
    <div className="home">
      <header className="home-header">
        <h1 className="home-title">Untie</h1>
        <div className="toolbar-spacer" />
        <AccountMenu />
      </header>
      <main className="home-main">
        <section className="home-section" aria-label="ローカル">
          <h2>ローカル</h2>
          <p className="home-note">このパソコンのファイルを開いて編集します。ログインは要りません。</p>
          <div className="home-actions">
            <button type="button" className="primary" onClick={() => void thenEdit(openDocument())}>
              ローカルファイルを開く
            </button>
            <button type="button" onClick={() => void createLocal()}>
              新規作成 (ローカル)
            </button>
            <button type="button" onClick={() => void thenEdit(openSampleDocument())}>
              サンプルを開く
            </button>
          </div>
          {recent.length > 0 && (
            <div className="home-recent">
              <h3>最近開いたローカルファイル</h3>
              <ul>
                {recent.map((f, i) => (
                  <li key={`${i}:${f.path ?? f.name}`}>
                    <button type="button" className="link" title={f.path ?? f.name} onClick={() => void thenEdit(openRecentDocument(f))}>
                      {f.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="home-section" aria-label="クラウド">
          <h2>クラウド</h2>
          {status === "signedIn" ? <CloudFiles /> : <LoginPanel />}
        </section>
      </main>
      <ToastHost />
    </div>
  );
}
