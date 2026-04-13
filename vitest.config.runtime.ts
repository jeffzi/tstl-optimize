import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the runtime differential test suite.
 * Run via `npm run test:runtime`.
 *
 * Requires at least one Lua runtime (lua5.1, luajit, or `lua` on PATH).
 * Tests that find no runtime will report a failure, rather than silently
 * no-op as they would under test:unit.
 */
export default defineConfig({
  test: {
    include: ["tests/runtime/**/*.test.ts"],
    // Runtime tests shell out to Lua — give each test room to breathe.
    testTimeout: 30_000,
  },
});
