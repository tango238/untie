import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { untieDevMode } from "../../scripts/dev-mode.mjs";

// アプリのバージョンはルートの package.json のものを「Untie について」に出す (tauri.conf.json・Cargo.toml と揃えておく)
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

// クラウド版の画面。本番は apps/server の Worker が dist/ を配る
// https://vite.dev/config/
export default defineConfig((env) => ({
  plugins: [react()],
  // 開発モード (開発用の画面を出す) は、開発サーバーを起動するときの UNTIE_DEV_MODE で決まる。build は必ず off
  define: { __APP_VERSION__: JSON.stringify(version), __UNTIE_DEV_MODE__: JSON.stringify(untieDevMode(env, fileURLToPath(new URL(".", import.meta.url)))) },
  server: {
    port: 5173,
    strictPort: true,
    // API・ログイン・ルーム (WebSocket) は apps/server の wrangler dev (8787) へ渡す
    // (apps/server/.dev.vars の APP_ORIGIN=http://localhost:5173 と揃えてある)
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/parties": { target: "http://localhost:8787", ws: true },
    },
  },
}));
