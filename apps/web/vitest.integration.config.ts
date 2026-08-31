import { defineConfig } from "vitest/config";
import path from "node:path";

// Separate from vitest.config.ts: these tests hit the real database
// configured via DATABASE_URL and must not run as part of the default
// `pnpm test`. Run explicitly with `pnpm test:integration`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // The default 5s Vitest timeout is too tight for this real Supabase
    // pooler's observed round-trip latency (confirmed repeatedly across
    // this suite - plain read assertions have intermittently taken over
    // 5s under real network conditions with no code defect involved).
    // Individual tests still set their own larger timeout where a
    // multi-minute seed/reset cycle needs one; this is only the floor.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
