import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    /*
     * 单元测试只跑 tests/ 顶层，不含 tests/e2e/。
     * e2e 需要真机（PC 蓝牙 + ESP32），单独用 vitest.e2e.config.ts 跑；
     * 混在一起会让 `npm test` 在没插设备的机器上失败，或更糟——假装通过。
     */
    include: ["tests/*.test.ts"],
  },
});
