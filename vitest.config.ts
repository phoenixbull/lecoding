import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Application composition roots use the same contract-test harness as packages.
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 10_000
  }
});
