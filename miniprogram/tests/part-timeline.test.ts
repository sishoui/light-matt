/**
 * 每部位独立时间轴（#157）：多步骤读回、增删、逐步下发。
 *
 * 这一票的核心价值是「眼灯 0.5 秒闪一下、散热 2 秒呼吸同时存在」，但**它的一半
 * 在固件**（`lumen_part_clock_advance` 的纯函数与 64 个播放头，#155 已实现并有
 * 单测）。这一层验的是另一半：**一个部位能编出多步、每步能单独下发、步与步之间
 * 的效果不会串**。
 */

import { describe, expect, it } from "vitest";
import { openPage } from "./helpers/page-harness";

/** 以「演示设备 0 的 strip 0 / 部位 0」打开部位页。 */
async function openPart() {
  return openPage("part", { strip: "0", part: "0" });
}

/** 等条件成立。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等超时");
}

/** 从设备读回该部位在当前场景里的全部步骤（设备权威）。 */
async function deviceSteps(harness: any, stripId = 0, partId = 0) {
  const sceneId = harness.session.deviceState?.activeScene ?? 0;
  const read = await harness.session.queryScene(sceneId);
  if (read.kind !== "ok") {
    throw new Error(`读场景失败：${read.kind}`);
  }
  return read.scene.steps
    .filter((step: any) => step.stripId === stripId && step.partId === partId)
    .sort((a: any, b: any) => a.stepIndex - b.stepIndex);
}

describe("多步骤读回", () => {
  it("设备上 0 步时给一个默认步（否则连时长条都没得调）", async () => {
    const harness = await openPart();
    try {
      /* 演示设备的出厂部位头是 0 步？先读一次看实际值，再按它断言。 */
      const steps = await deviceSteps(harness);
      const blocks = harness.page.data.timelineBlocks as unknown[];
      if (steps.length === 0) {
        expect(blocks.length).toBe(1);
        expect(harness.page.data.stepCount).toBe(0);
      } else {
        expect(blocks.length).toBe(steps.length);
      }
    } finally {
      await harness.dispose();
    }
  });

  it("设备上有多步时，时间轴一块对一步（不是只显示第一步）", async () => {
    const harness = await openPart();
    try {
      /* 直接往设备写三步（绕开页面，验读回）。 */
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      await harness.session.setScenePart(sceneId, 0, 0, 3, 1, true);
      const base = (await deviceSteps(harness))[0];
      const layer0 = base?.layer0 ?? {
        type: 0,
        hue: 7281,
        sat: 255,
        periodMs: 0,
        p5: 0,
        flags: 0,
        level: 100,
      };
      const layer1 = {
        type: 0xff,
        hue: 0,
        sat: 0,
        periodMs: 0,
        p5: 0,
        flags: 0,
        level: 0,
      };
      for (let index = 0; index < 3; index += 1) {
        await harness.session.setSceneStep({
          sceneId,
          stripId: 0,
          partId: 0,
          stepIndex: index,
          durationMs: 1000,
          layer0,
          layer1,
        });
      }
      await harness.page.load();

      const blocks = harness.page.data.timelineBlocks as Array<{ index: number; durationText: string }>;
      expect(blocks.length).toBe(3);
      expect(blocks.map((block) => block.index)).toEqual([0, 1, 2]);
      expect(blocks[0].durationText).toBe("1 秒");
      expect(harness.page.data.timelineTotalMs).toBe(3000);
    } finally {
      await harness.dispose();
    }
  });
});

describe("加一步 / 删一步", () => {
  it("加一步立刻下发：设备上的步数 +1，且新步是 1 秒常亮", async () => {
    const harness = await openPart();
    try {
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      await harness.session.setScenePart(sceneId, 0, 0, 1, 0, true);
      await harness.page.load();
      const before = (await deviceSteps(harness)).length;

      harness.page.onAddStep();
      await waitFor(() => (harness.page.data.timelineBlocks as unknown[]).length === 2);
      await harness.page.load();

      const after = await deviceSteps(harness);
      expect(after.length).toBe(before + 1);
      /* 新步默认 1 秒、常亮。 */
      expect(after[after.length - 1]?.durationMs).toBe(1000);
      expect(after[after.length - 1]?.layer0.type).toBe(0x00);
    } finally {
      await harness.dispose();
    }
  });

  it("删掉当前选中的那一步：设备上的步数 -1，选中下标被钳住", async () => {
    const harness = await openPart();
    try {
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      await harness.session.setScenePart(sceneId, 0, 0, 3, 1, true);
      const base = (await deviceSteps(harness))[0];
      const layer0 = base?.layer0 ?? {
        type: 0,
        hue: 7281,
        sat: 255,
        periodMs: 0,
        p5: 0,
        flags: 0,
        level: 100,
      };
      const layer1 = {
        type: 0xff,
        hue: 0,
        sat: 0,
        periodMs: 0,
        p5: 0,
        flags: 0,
        level: 0,
      };
      for (let index = 0; index < 3; index += 1) {
        await harness.session.setSceneStep({
          sceneId,
          stripId: 0,
          partId: 0,
          stepIndex: index,
          durationMs: 1000 * (index + 1),
          layer0,
          layer1,
        });
      }
      await harness.page.load();
      expect((harness.page.data.timelineBlocks as unknown[]).length).toBe(3);

      /* 选中第 3 步再删它。 */
      harness.page.onStepTap({ currentTarget: { dataset: { index: 2 } } });
      expect(harness.page.data.stepIndex).toBe(2);
      harness.page.onRemoveStep();
      await waitFor(() => (harness.page.data.timelineBlocks as unknown[]).length === 2);
      expect(harness.page.data.stepIndex).toBe(1);
      await harness.page.load();

      const after = await deviceSteps(harness);
      expect(after.length).toBe(2);
    } finally {
      await harness.dispose();
    }
  });

  it("只剩一步时拒绝删（步数为 0 会让这个部位在本场景不演）", async () => {
    const harness = await openPart();
    try {
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      await harness.session.setScenePart(sceneId, 0, 0, 1, 0, true);
      await harness.page.load();
      expect(harness.page.data.timelineCanRemove).toBe(false);

      harness.page.onRemoveStep();
      expect(harness.page.data.applyError).toContain("至少留一步");
      expect((harness.page.data.timelineBlocks as unknown[]).length).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it("满 8 步时拒绝加第 9 步", async () => {
    const harness = await openPart();
    try {
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      await harness.session.setScenePart(sceneId, 0, 0, 8, 1, true);
      await harness.page.load();
      expect(harness.page.data.timelineCanAdd).toBe(false);

      harness.page.onAddStep();
      expect(harness.page.data.applyError).toContain("8 步");
      expect((harness.page.data.timelineBlocks as unknown[]).length).toBe(8);
    } finally {
      await harness.dispose();
    }
  });
});

describe("逐步参数：每步各有一组两层", () => {
  it("选中别的步时效果面板换成那一步的参数，不改另一组", async () => {
    const harness = await openPart();
    try {
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      await harness.session.setScenePart(sceneId, 0, 0, 2, 1, true);
      /* 第 0 步常亮红色，第 1 步常亮蓝色。 */
      await harness.session.setSceneStep({
        sceneId,
        stripId: 0,
        partId: 0,
        stepIndex: 0,
        durationMs: 1000,
        layer0: { type: 0x00, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0, level: 100 },
        layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
      });
      await harness.session.setSceneStep({
        sceneId,
        stripId: 0,
        partId: 0,
        stepIndex: 1,
        durationMs: 2000,
        layer0: { type: 0x00, hue: 43690, sat: 255, periodMs: 0, p5: 0, flags: 0, level: 100 },
        layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
      });
      await harness.page.load();

      /* 第 0 步：色相 0、时长 1 秒。 */
      expect(harness.page.data.stepIndex).toBe(0);
      expect(harness.page.data.durationMs).toBe(1000);

      harness.page.onStepTap({ currentTarget: { dataset: { index: 1 } } });
      expect(harness.page.data.stepIndex).toBe(1);
      expect(harness.page.data.durationMs).toBe(2000);

      /* 设备上两步的参数各自还在（切选中不改设备）。 */
      const steps = await deviceSteps(harness);
      expect(steps[0].layer0.hue).toBe(0);
      expect(steps[1].layer0.hue).toBe(43690);
    } finally {
      await harness.dispose();
    }
  });
});
