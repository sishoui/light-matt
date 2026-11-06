/**
 * 设备页的**整机开关 / 亮度 / 灯组开关 / 部位开关**（v5 保留的页面行为）。
 *
 * 为什么这个文件必须存在：`pages/strip` 与它的 33 个测试一起退役时，这些
 * 「行为还在、只是页面换了地址」的用例被一起删掉了。它们测的不是 v4 模型，
 * 而是**设备页自己的事件处理器**是否真的把命令发到设备上：
 *
 *  - 整机开关：点电源键 → `SetPower` → State 的 `power` 真的翻；
 *  - 整机亮度：松手 → `SetBrightness` → State 的 `brightness` 真的变，且不碰开关；
 *  - 灯组开关：只翻 `strip_power_mask` 的一位，其它组继续运行；
 *  - 部位开关：只改 `on` 一位，不重写步数（T9：关掉再打开不停时钟）。
 *
 * 断言一律落在**设备可观察状态**（`session.deviceState`）与页面的派生 data 上，
 * 不看中间过程。页面处理器是产品代码本身，传输层是 `MockTransport`。
 */

import { describe, expect, it } from "vitest";
import { MOCK_DEVICES } from "../utils/control/mock-devices";
import { MOCK_FIRST, openPage, slide, tap, toggle } from "./helpers/page-harness";

const DEVICE = MOCK_DEVICES[0];

/** 传输层日志里发出的 SetBrightness（0x02）帧。 */
function setBrightnessFrames(harness: {
  transport: { log: { snapshot(): Array<{ dir: string; command: number }> } };
}): Array<{ dir: string; command: number }> {
  return harness.transport.log.snapshot().filter((entry) => entry.dir === "tx" && entry.command === 0x02);
}

/** 等一个条件成立（页面里的写命令要等 ACK）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等超时");
}

describe("设备页：整机开关", () => {
  it("点电源键翻设备 power 位，页面跟着设备值", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      expect(harness.session.deviceState?.power).toBe(1);
      await harness.page.onTogglePower();
      await waitFor(() => harness.session.deviceState?.power === 0);
      expect(harness.session.deviceState?.power, "设备真的关了").toBe(0);
      expect(harness.page.data.power, "页面跟着设备值").toBe(0);

      await harness.page.onTogglePower();
      await waitFor(() => harness.session.deviceState?.power === 1);
      expect(harness.session.deviceState?.power).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it("关灯不改亮度（开关与亮度是两个字段）", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      const before = harness.session.deviceState?.brightness;
      await harness.page.onTogglePower();
      await waitFor(() => harness.session.deviceState?.power === 0);
      expect(harness.session.deviceState?.brightness).toBe(before);
    } finally {
      await harness.dispose();
    }
  });

  it("未连接时不发命令（点了也不报错）", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      await harness.session.disconnect();
      const before = harness.session.deviceState;
      await harness.page.onTogglePower();
      expect(harness.session.deviceState).toEqual(before);
    } finally {
      await harness.dispose();
    }
  });
});

describe("设备页：整机亮度", () => {
  it("松手下发 SetBrightness，设备 State 真的变", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      harness.transport.log.clear();
      await harness.page.onBrightnessChange(slide(180));
      await waitFor(() => harness.session.deviceState?.brightness === 180);
      expect(harness.session.deviceState?.brightness).toBe(180);
      /* 松手一定真的发出去一帧 SetBrightness（不是只改了本地读数）。
       * 节流的最短间隔是 50ms，所以等它一拍再数。 */
      await new Promise((r) => setTimeout(r, 120));
      expect(setBrightnessFrames(harness).length).toBeGreaterThan(0);
      expect(harness.page.data.brightness, "松手后绑回设备值").toBe(180);
    } finally {
      await harness.dispose();
    }
  });

  it("拖动中只改界面读数，不逐帧下发 SetBrightness", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      const before = harness.session.deviceState?.brightness;
      harness.transport.log.clear();
      harness.page.onBrightnessChanging(slide(before! + 10));
      /* 拖动阶段**不绑值**：滑块自己跟着手指，`brightness` 仍是设备值。 */
      expect(harness.page.data.brightnessDisplay, "界面读数跟着手指").toBe(before! + 10);
      expect(harness.page.data.brightness).toBe(before);
      /* 20Hz 节流：一帧可能已经飞出去了，但绝不是每个 changing 一帧。 */
      const sent = setBrightnessFrames(harness);
      expect(sent.length).toBeLessThanOrEqual(1);
    } finally {
      await harness.dispose();
    }
  });

  it("拖动中的读数按 20Hz 节流（100Hz 的事件不会每次都重画）", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      const before = harness.session.deviceState?.brightness;
      /* 第一次一定过；紧接着的第二次在 50ms 窗口内被丢弃。 */
      harness.page.onBrightnessChanging(slide(before! + 10));
      harness.page.onBrightnessChanging(slide(before! + 20));
      expect(harness.page.data.brightnessDisplay, "第二次被节流").toBe(before! + 10);
    } finally {
      await harness.dispose();
    }
  });

  it("上限按设备报的 maxBrightness 钳位", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      await harness.page.onBrightnessChange(slide(1000));
      await waitFor(() => harness.session.deviceState?.brightness === DEVICE.maxBrightness);
      expect(harness.session.deviceState?.brightness).toBe(DEVICE.maxBrightness);
    } finally {
      await harness.dispose();
    }
  });

  it("改亮度不碰开关（两个字段解耦）", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      const power = harness.session.deviceState?.power;
      await harness.page.onBrightnessChange(slide(90));
      await waitFor(() => harness.session.deviceState?.brightness === 90);
      expect(harness.session.deviceState?.power).toBe(power);
    } finally {
      await harness.dispose();
    }
  });
});

describe("设备页：灯组开关", () => {
  it("只翻目标组那一位，别的组继续运行", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      /* 演示设备 0 有两条带，掩码 0b11：关掉 strip 1 之后 strip 0 仍在。 */
      expect(harness.session.stripPower(0)).toBe(true);
      expect(harness.session.stripPower(1)).toBe(true);

      await harness.page.onStripPowerChange(toggle(false, { stripId: 1 }));
      await waitFor(() => harness.session.stripPower(1) === false);

      expect(harness.session.stripPower(1), "目标组关了").toBe(false);
      expect(harness.session.stripPower(0), "别的组不受影响").toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("再打开只把这一位置回去", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      await harness.page.onStripPowerChange(toggle(false, { stripId: 0 }));
      await waitFor(() => harness.session.stripPower(0) === false);
      expect(harness.session.stripPower(1), "另一组一直是开的").toBe(true);

      await harness.page.onStripPowerChange(toggle(true, { stripId: 0 }));
      await waitFor(() => harness.session.stripPower(0) === true);
      expect(harness.session.stripPower(0)).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("灯组开关不改整机 power", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      const power = harness.session.deviceState?.power;
      await harness.page.onStripPowerChange(toggle(false, { stripId: 1 }));
      await waitFor(() => harness.session.stripPower(1) === false);
      expect(harness.session.deviceState?.power).toBe(power);
    } finally {
      await harness.dispose();
    }
  });

  it("非法 stripId 不发命令（渲染层的脏数据不算可信）", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      const before = harness.session.deviceState?.stripPowerMask;
      await harness.page.onStripPowerChange(toggle(false, { stripId: -1 }));
      await harness.page.onStripPowerChange(toggle(false, { stripId: 99 }));
      expect(harness.session.deviceState?.stripPowerMask).toBe(before);
    } finally {
      await harness.dispose();
    }
  });
});

describe("设备页：部位开关（场景侧的 on 位）", () => {
  it("只改 on 一位：步数与循环不变（关掉再打开不停时钟）", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      /* 展开灯组 0：布局与场景都读回来之后，部位行才就位。 */
      await harness.page.expandStrip(0);
      await waitFor(() => harness.session.sceneOf(0) !== null);

      const scene = harness.session.deviceState?.activeScene ?? 0;
      const report = harness.session.sceneOf(scene);
      const part = report?.parts.find((item) => item.stripId === 0 && item.partId === 0);
      expect(part, "演示设备 0 的 strip 0 有部位 0").toBeDefined();

      const stepsBefore = part!.stepCount;
      const loopBefore = part!.loop;
      const wasOn = part!.on;

      await harness.page.onPartSwitchChange(toggle(!wasOn, { stripId: 0, partId: 0 }));
      await waitFor(() => {
        const now = harness.session
          .sceneOf(scene)
          ?.parts.find((item) => item.stripId === 0 && item.partId === 0);
        return now !== undefined && now.on !== wasOn;
      });

      const after = harness.session
        .sceneOf(scene)
        ?.parts.find((item) => item.stripId === 0 && item.partId === 0);
      expect(after?.on, "开关位真的翻了").toBe(!wasOn);
      expect(after?.stepCount, "步数不变（不动时间轴）").toBe(stepsBefore);
      expect(after?.loop, "循环档不变").toBe(loopBefore);
    } finally {
      await harness.dispose();
    }
  });

  it("部位不在场景里时只提示，不发命令", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      await harness.page.expandStrip(0);
      await waitFor(() => harness.session.sceneOf(0) !== null);
      const scene = harness.session.deviceState?.activeScene ?? 0;
      const before = harness.session.sceneOf(scene);
      await harness.page.onPartSwitchChange(toggle(true, { stripId: 5, partId: 5 }));
      expect(harness.session.sceneOf(scene)).toEqual(before);
    } finally {
      await harness.dispose();
    }
  });
});
