import { defineConfig } from "vitest/config";
import path from "node:path";

// Separate from vitest.config.ts: these tests hit the real database
// configured via DATABASE_URL and must not run as part of the default
// `pnpm test`. Run explicitly with `pnpm test:integration`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
