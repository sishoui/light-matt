import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 测试全部走 fastify.inject + 内存 SQLite，不监听端口、不联网。
    pool: "forks",
  },
});
