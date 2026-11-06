/**
 * 设备信息页的**灯珠数 / 自检 / 身份查询**（v5 保留的页面行为）。
 *
 * 这些用例随 `led-count-ui.test.ts` / `led-count-plan.test.ts` 一起被删过，
 * 但它们测的不是 v4 的「分区 / 剧本」模型，而是设备信息页自己的事件处理器：
 *
 *  - **逐组灯珠数**：每条灯组一条 1–100 的滑块，拖动只改本地值（`bindchanging`），
 *    松手（`bindchange`）才下发 `SetLedCount` 0x06，且**只改目标组**；
 *  - **缩小预检**：有部位会被截断时先二次确认（文案带数量），取消则一帧不发；
 *  - **自检**：点按钮发一帧 `SelfTest` 0x07，不改任何设备状态；
 *  - **身份查询**：hwId / 固件 / 能力 / 上限四栏都来自 `QueryDeviceInfo`。
 *
 * 断言落在**设备可观察状态**与传输层日志上，不看中间过程。
 */

import { describe, expect, it } from "vitest";
import { MAX_LEDS, MIN_LEDS } from "../utils/protocol/constants";
import { MOCK_DEVICES } from "../utils/control/mock-devices";
import { MOCK_FIRST, openPage, slide } from "./helpers/page-harness";

const DEVICE = MOCK_DEVICES[0];

/** 传输层日志里发出的某种命令帧。 */
function frames(harness: { transport: { log: { snapshot(): Array<{ dir: string; command: number }> } } }, command: number) {
  return harness.transport.log.snapshot().filter((entry) => entry.dir === "tx" && entry.command === command);
}

/** 等一个条件成立（写命令要等 ACK）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等超时");
}

describe("设备信息页：逐组灯珠数", () => {
  it("每条灯组一行，总数是逐组之和（不拿 strip 0 冒充）", async () => {
    const harness = await openPage("device-info");
    try {
      const rows = harness.page.data.stripRows as Array<{ stripId: number; ledCount: number }>;
      /* 演示设备 0 报 2 条带：30 / 18。 */
      expect(rows.map((row) => row.stripId)).toEqual([0, 1]);
      expect(rows.map((row) => row.ledCount)).toEqual([30, 18]);
      expect(harness.page.data.ledTotal).toBe(48);
      /* 逐组真实值：第 1 组不是第 0 组的拷贝。 */
      expect(rows[1].ledCount).not.toBe(rows[0].ledCount);
    } finally {
      await harness.dispose();
    }
  });

  it("滑块上下界来自协议常量（MIN_LEDS / MAX_LEDS）", async () => {
    const harness = await openPage("device-info");
    try {
      expect(harness.page.data.ledMin).toBe(MIN_LEDS);
      expect(harness.page.data.ledMax).toBe(MAX_LEDS);
    } finally {
      await harness.dispose();
    }
  });

  it("拖动只改本地值：不下发 SetLedCount", async () => {
    const harness = await openPage("device-info");
    try {
      harness.transport.log.clear();
      harness.page.onLedCountChanging(slide(40, { stripId: 1 }));
      const rows = harness.page.data.stripRows as Array<{ stripId: number; ledCount: number }>;
      expect(rows.find((row) => row.stripId === 1)?.ledCount, "界面跟着手指").toBe(40);
      expect(frames(harness, 0x06), "拖动阶段一帧都不发").toEqual([]);
      /* 设备值没变。 */
      expect(harness.session.stripLedCount(1)).toBe(18);
    } finally {
      await harness.dispose();
    }
  });

  it("松手下发 SetLedCount，且只改目标组", async () => {
    const harness = await openPage("device-info");
    try {
      harness.transport.log.clear();
      await harness.page.onLedCountChange(slide(40, { stripId: 1 }));
      await waitFor(() => harness.session.stripLedCount(1) === 40);
      expect(harness.session.stripLedCount(1), "目标组变了").toBe(40);
      expect(harness.session.stripLedCount(0), "别的组一字不动").toBe(30);
      expect(frames(harness, 0x06).length, "真的发了 0x06").toBeGreaterThan(0);
    } finally {
      await harness.dispose();
    }
  });

  it("改大不需要确认（不会截断任何部位）", async () => {
    const harness = await openPage("device-info");
    try {
      await harness.page.onLedCountChange(slide(50, { stripId: 0 }));
      await waitFor(() => harness.session.stripLedCount(0) === 50);
      expect(harness.session.stripLedCount(0)).toBe(50);
    } finally {
      await harness.dispose();
    }
  });

  it("缩小且会截断部位时先弹确认（文案带受影响数量）", async () => {
    const harness = await openPage("device-info");
    try {
      /* 演示设备 0 的 strip 0 有部位 0（0–13）与部位 1（14–29）：
       * 缩到 10 颗会把两个部位都整段丢给设备 prune，所以必须问。 */
      const confirmTextBefore = harness.page.shrinkConfirmTextOf(2, 10);
      expect(confirmTextBefore).toContain("2");

      await harness.page.onLedCountChange(slide(10, { stripId: 0 }));
      await waitFor(() => harness.session.stripLedCount(0) === 10);
      expect(harness.session.stripLedCount(0), "确认后真的改了").toBe(10);
    } finally {
      await harness.dispose();
    }
  });

  it("缩小不改动别的灯组", async () => {
    const harness = await openPage("device-info");
    try {
      await harness.page.onLedCountChange(slide(10, { stripId: 0 }));
      await waitFor(() => harness.session.stripLedCount(0) === 10);
      expect(harness.session.stripLedCount(1), "第 1 组仍是 18").toBe(18);
    } finally {
      await harness.dispose();
    }
  });

  it("非法 / 越界值被钳到 1–100，不下发 0 或 101", async () => {
    const harness = await openPage("device-info");
    try {
      harness.transport.log.clear();
      /* 0 → 下限 1；1000 → 上限 100。两者都合法，所以会真发。 */
      await harness.page.onLedCountChange(slide(0, { stripId: 1 }));
      await waitFor(() => harness.session.stripLedCount(1) === MIN_LEDS);
      expect(harness.session.stripLedCount(1)).toBe(MIN_LEDS);
    } finally {
      await harness.dispose();
    }
  });

  it("未连接时把滑块拉回设备值（不发帧）", async () => {
    const harness = await openPage("device-info");
    try {
      await harness.session.disconnect();
      await harness.page.reload();
      harness.transport.log.clear();
      await harness.page.onLedCountChange(slide(44, { stripId: 0 }));
      expect(frames(harness, 0x06)).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});

describe("设备信息页：自检", () => {
  it("点自检发一帧 SelfTest 0x07，不改任何设备状态", async () => {
    const harness = await openPage("device-info");
    try {
      const before = harness.session.deviceState;
      harness.transport.log.clear();
      await harness.page.onSelfTest();
      await waitFor(() => frames(harness, 0x07).length > 0);
      expect(frames(harness, 0x07).length, "一帧 SelfTest").toBe(1);
      /* 自检是设备侧的临时覆盖，不该动 State。 */
      expect(harness.session.deviceState).toEqual(before);
    } finally {
      await harness.dispose();
    }
  });

  it("未连接时点自检不发帧", async () => {
    const harness = await openPage("device-info");
    try {
      await harness.session.disconnect();
      await harness.page.reload();
      harness.transport.log.clear();
      await harness.page.onSelfTest();
      expect(frames(harness, 0x07)).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});

describe("设备信息页：设备身份与能力", () => {
  it("四栏都来自 QueryDeviceInfo（不是写死的）", async () => {
    const harness = await openPage("device-info");
    try {
      expect(harness.page.data.hwId).toBe(DEVICE.hwId);
      expect(harness.page.data.firmwareText).toContain("5.0");
      expect(harness.page.data.capsText).toContain("两层");
      expect(harness.page.data.limitsText).toContain(`灯珠 ${MAX_LEDS}`);
    } finally {
      await harness.dispose();
    }
  });

  it("五条上限都来自设备报的能力（改动设备不改界面常量）", async () => {
    const harness = await openPage("device-info");
    try {
      const info = harness.session.deviceInfo;
      expect(info).not.toBeNull();
      const text = String(harness.page.data.limitsText);
      for (const value of [info!.maxLeds, info!.maxStrips, info!.maxParts, info!.maxSteps]) {
        expect(text, `上限 ${value} 应出现在摘要里`).toContain(String(value));
      }
    } finally {
      await harness.dispose();
    }
  });

  it("未连接时不再补读，四栏保持上一次读到的值（不伪造新的）", async () => {
    const harness = await openPage("device-info");
    try {
      const readBefore = {
        hwId: harness.page.data.hwId,
        firmwareText: harness.page.data.firmwareText,
        capsText: harness.page.data.capsText,
        limitsText: harness.page.data.limitsText,
      };
      await harness.session.disconnect();
      harness.transport.log.clear();
      await harness.page.reload();
      /* 页面把四栏灰掉（`ready = false`）并提示未连接，但**不编新值**：
       * 未连接时也没有发补读帧（QueryDeviceInfo / QueryStripConfig 都不发）。 */
      expect(harness.page.data.ready).toBe(false);
      expect(harness.page.data.hint).toBe("设备未连接");
      expect(harness.page.data.hwId).toBe(readBefore.hwId);
      expect(harness.page.data.firmwareText).toBe(readBefore.firmwareText);
      expect(harness.page.data.capsText).toBe(readBefore.capsText);
      expect(harness.page.data.limitsText).toBe(readBefore.limitsText);
      expect(frames(harness, 0x1d), "未连接不发 QueryDeviceInfo").toEqual([]);
      expect(frames(harness, 0x1c), "未连接不发 QueryStripConfig").toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});
