import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { untieDevMode } from "../../scripts/dev-mode.mjs";

// アプリのバージョンはルートの package.json のものを「Untie について」に出す (tauri.conf.json・Cargo.toml と揃えておく)
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

// Web 版 (ローカル専用)。サーバーを持たない静的なサイトで、Cloudflare Pages が dist/ を配る
// https://vite.dev/config/
export default defineConfig((env) => ({
  plugins: [react()],
  // 開発モード (開発用の画面を出す) は、開発サーバーを起動するときの UNTIE_DEV_MODE で決まる。build は必ず off
  define: { __APP_VERSION__: JSON.stringify(version), __UNTIE_DEV_MODE__: JSON.stringify(untieDevMode(env, fileURLToPath(new URL(".", import.meta.url)))) },
  // クラウド版 (apps/cloud、5173) と同時に動かせるよう、別のポートにする
  server: { port: 5174, strictPort: true },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
