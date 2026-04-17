import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    unstubEnvs: true,
    sequence: {
      seed: Date.now(),
      shuffle: {
        files: true,
        tests: true,
      },
    },
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/runtime/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        perFile: true,
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
