import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/record.spec.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 900_000,
    hookTimeout: 240_000,
  },
});
