import { defineConfig } from "vitest/config";

/**
 * 真机 e2e：连真实的 ESP32（PC 蓝牙经 Python bleak 网关）。
 *
 * 与单元测试分开配置是刻意的：这条路依赖硬件，不该进 CI，也不该让
 * `npm test` 在没有设备的机器上变红或变绿。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    /* 真机往返慢：连接 + 首次 State 读就要几秒，给足时间。 */
    testTimeout: 90_000,
    hookTimeout: 60_000,
    /* 串行执行：同一时刻只有一个 BLE 连接，并行会互相踢掉。 */
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
