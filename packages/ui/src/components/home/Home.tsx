import { useEffect, useState } from "react";
import { SAMPLES } from "@untie/core/sample";
import { openDocument, openRecentDocument, openSampleDocument, newEmptyDocument, confirmDiscardIfDirty } from "../../io/document";
import { getPlatform, type RecentFile } from "../../platform";
import { navigate } from "../../router";
import { useSessionStore } from "../../cloud/session";
import { ToastHost } from "../Toast";
import { AccountMenu } from "./AccountMenu";
import { CloudFiles } from "./CloudFiles";
import { LoginPanel } from "./LoginPanel";
import { ServerSettings } from "./ServerSettings";

/** Web 版のホームの先頭に出す紹介 (「Untie について」と同じ一文) */
export const UNTIE_INTRO =
  "Untie は、業務整理を行いながら、現場が感じている困りごとが業務のどこに潜んでいるかを突き止めるためのツールです。";

/** ホーム画面 (設計書 8.1): ローカルファイルを開く・クラウドのファイルを一覧する */
export default function Home() {
  const status = useSessionStore((s) => s.status);
  // Web 版 (ローカル専用) はクラウドの欄もログインも出さない
  const cloud = getPlatform().cloud;
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
        {cloud && <AccountMenu />}
      </header>
      <main className="home-main">
        <section className="home-section" aria-label="ローカル">
          {cloud ? (
            <>
              <h2>ローカル</h2>
              <p className="home-note">このパソコンのファイルを開いて編集します。ログインは要りません。</p>
            </>
          ) : (
            // Web 版はローカルしか無いので、見出しの代わりに Untie の紹介を置く
            <p className="home-intro">{UNTIE_INTRO}</p>
          )}
          <div className="home-actions">
            <button type="button" className="primary" onClick={() => void thenEdit(openDocument())}>
              ローカルファイルを開く
            </button>
            <button type="button" onClick={() => void createLocal()}>
              {cloud ? "新規作成 (ローカル)" : "新規作成"}
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

        <section className="home-section" aria-label="サンプル">
          <h2>サンプル</h2>
          <p className="home-note">架空の業務を整理した例です。開いて自由に触れます (元のサンプルファイルは変更できません)。</p>
          <ul className="sample-gallery">
            {SAMPLES.map((sample) => (
              <li key={sample.id}>
                <button type="button" className="sample-card" onClick={() => void thenEdit(openSampleDocument(sample))}>
                  <span className="sample-card-title">{sample.title}</span>
                  <span className="sample-card-description">{sample.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {cloud && (
          <section className="home-section" aria-label="クラウド">
            <h2>クラウド</h2>
            {status === "signedIn" ? <CloudFiles /> : <LoginPanel />}
          </section>
        )}

        {getPlatform().kind === "desktop" && <ServerSettings />}
      </main>
      <ToastHost />
    </div>
  );
}
