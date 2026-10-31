import { mkdirSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const root = import.meta.dirname;
  const migrations = await readD1Migrations(path.join(root, "migrations"));
  // wrangler.jsonc の assets.directory (../web/dist) は存在しないと起動できない。web のビルド前 (CI の test など) でも動かすため空で作る
  mkdirSync(path.join(root, "../web/dist"), { recursive: true });

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // .dev.vars ではなくテスト用の値を明示する。DEV_LOGIN など個別に変えたいものは、テストが env を組み替えて Worker を呼ぶ
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEV_LOGIN: "true",
            APP_ORIGIN: "",
            ALLOWED_EMAIL_DOMAINS: "",
            SESSION_SECRET: "test-session-secret",
            TICKET_SECRET: "test-ticket-secret",
            GOOGLE_CLIENT_ID: "test-google-client-id",
            GOOGLE_CLIENT_SECRET: "test-google-client-secret",
          },
        },
      }),
    ],
    test: {
      name: "server",
      include: ["src/**/*.test.ts"],
      setupFiles: ["./src/__tests__/setup.ts"],
    },
  };
});
