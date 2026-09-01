import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Application composition roots use the same contract-test harness as packages.
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts"
    ],
    // Match the production sandbox's two-CPU budget and avoid PGlite worker starvation.
    maxWorkers: 2,
    // Embedded PostgreSQL is materially slower under bounded container runtimes.
    testTimeout: 30_000
  }
});
