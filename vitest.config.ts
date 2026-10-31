import { defineConfig } from "vitest/config";

// 各パッケージの vitest.config.ts (apps は vite.config.ts) をプロジェクトとして並べる。ルートの `pnpm test` ですべて走る
export default defineConfig({
  test: {
    projects: ["packages/core", "packages/api", "packages/collab", "packages/ui", "apps/server", "apps/web", "apps/desktop"],
    coverage: {
      provider: "v8",
      include: ["packages/core/src/model/**", "packages/collab/src/**", "packages/ui/src/store/**"],
      exclude: ["**/__tests__/**", "packages/core/src/model/index.ts", "packages/core/src/model/schema.d.ts"],
    },
  },
});
