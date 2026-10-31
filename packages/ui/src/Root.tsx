import { useEffect, useRef } from "react";
import App from "./App";
import { useSessionStore } from "./cloud/session";
import { CloudEditor } from "./components/CloudEditor";
import Home from "./components/home/Home";
import { InvitePage } from "./components/InvitePage";
import { useCloseGuard } from "./io/useCloseGuard";
import { resumePendingRoute, useRoute } from "./router";

/** 画面の切り替え。ハッシュ (router.ts) で、ホーム・ローカル編集・クラウドファイル・招待・リンクで開くを出し分ける */
export default function Root() {
  // ログインから戻ってきた (#/invite・#/link だけ) ら、預けたトークンで本来の画面に直す。最初の描画の前に 1 度だけ
  const resumed = useRef(false);
  if (!resumed.current) {
    resumed.current = true;
    resumePendingRoute();
  }
  const route = useRoute();
  // 閉じる前の確認は、ホームに出ている間も効かせる (ローカルの編集が裏に残っているため)
  useCloseGuard();

  // ログインの状態は起動時に 1 度だけ確かめる
  useEffect(() => {
    void useSessionStore.getState().load();
  }, []);

  switch (route.name) {
    case "local":
      return <App />;
    case "file":
      return <CloudEditor fileId={route.fileId} />;
    case "invite":
      return <InvitePage token={route.token} />;
    case "link":
      return <CloudEditor link={route.token} />;
    case "home":
      return <Home />;
  }
}
