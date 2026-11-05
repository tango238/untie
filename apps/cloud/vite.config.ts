import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// アプリのバージョンはルートの package.json のものを「Untie について」に出す (tauri.conf.json・Cargo.toml と揃えておく)
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

// クラウド版の画面。本番は apps/server の Worker が dist/ を配る
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
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
});
