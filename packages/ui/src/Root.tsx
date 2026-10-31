import { useEffect } from "react";
import App from "./App";
import { useSessionStore } from "./cloud/session";
import { CloudFilePlaceholder } from "./components/CloudFilePlaceholder";
import Home from "./components/home/Home";
import { useCloseGuard } from "./io/useCloseGuard";
import { useRoute } from "./router";

/** 画面の切り替え。ハッシュ (router.ts) で、ホーム・ローカル編集・クラウドファイルを出し分ける */
export default function Root() {
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
      return <CloudFilePlaceholder fileId={route.fileId} />;
    // 招待・リンクで開く画面は次の段階。それまではホームを出す
    case "home":
    case "invite":
    case "link":
      return <Home />;
  }
}
