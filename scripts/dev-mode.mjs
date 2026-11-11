// 開発モード (packages/ui/src/devMode.ts) を、各アプリの vite.config.ts が決めるための関数。
// 開発サーバー (vite) を起動したときの設定 UNTIE_DEV_MODE が 1 / true / on なら on。既定は off。
// 設定は、起動するときの環境変数か、リポジトリの直下かアプリのフォルダの .env.local (コミットしない) に書く。
// build (デプロイするもの) は、設定が何であっても必ず off にする (開発用の画面を配らないため)。
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ON = /^(1|true|on)$/i;

/**
 * @param {{ command: "serve" | "build"; mode: string }} env vite の defineConfig に渡る値
 * @param {string} appDir アプリのフォルダ (その .env.local も読む)
 * @returns {boolean}
 */
export function untieDevMode({ command, mode }, appDir) {
  if (command !== "serve") return false;
  const value = process.env.UNTIE_DEV_MODE ?? loadEnv(mode, appDir, "UNTIE_").UNTIE_DEV_MODE ?? loadEnv(mode, ROOT, "UNTIE_").UNTIE_DEV_MODE ?? "";
  return ON.test(value.trim());
}
