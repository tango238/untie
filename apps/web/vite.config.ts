import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// アプリのバージョンはルートの package.json のものを「Untie について」に出す (tauri.conf.json・Cargo.toml と揃えておく)
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    // API・ログイン・ルーム (WebSocket) は apps/server の wrangler dev (8787) へ渡す
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/parties": { target: "http://localhost:8787", ws: true },
    },
  },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
