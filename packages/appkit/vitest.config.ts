import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "appkit",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
