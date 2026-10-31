/// <reference types="vite/client" />
// Web・デスクトップ共通の画面の入り口。各 app の main.tsx が、自分の Platform を渡して呼ぶ。
import React from "react";
import ReactDOM from "react-dom/client";
import "@xyflow/react/dist/style.css";
import Root from "./Root";
import { setPlatform, type Platform } from "./platform";
import "./styles/app.css";

/** Platform を差し込んでから、画面を root に描画する */
export function createApp(platform: Platform, root: HTMLElement = document.getElementById("root") as HTMLElement): void {
  setPlatform(platform);
  // ハッシュが無ければホーム (#/) から始める
  if (!window.location.hash) window.history.replaceState(null, "", "#/");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

export type { Platform } from "./platform";
