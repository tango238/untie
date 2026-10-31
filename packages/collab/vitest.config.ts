import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "collab",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
