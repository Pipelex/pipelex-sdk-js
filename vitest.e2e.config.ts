import { defineConfig } from "vitest/config";

// E2E suite — runs against a LIVE pipelex-api server (`make test-e2e`), so it is
// deliberately excluded from the default `vitest run` include (`tests/**/*.test.ts`)
// via the distinct `.e2e.ts` suffix.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    // Network calls against a local runner — generous per-test budget, no retries
    // (a flaky pass would hide a real server regression).
    testTimeout: 30_000,
  },
});
