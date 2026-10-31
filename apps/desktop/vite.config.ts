import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;
// アプリのバージョンはルートの package.json のものを「Untie について」に出す (tauri.conf.json・Cargo.toml と揃えておく)
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },

  test: {
    name: "desktop",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/coverage/**"],
    },
  },
}));
