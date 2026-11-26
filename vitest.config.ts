import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    maxWorkers: 2,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
