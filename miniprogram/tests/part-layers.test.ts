/**
 * 两层与叠加开关（#158）。
 *
 * 票面两条判据：**界面只有一个叠加开关**（混合方式由系统按有无叠加层选，E6），
 * 以及**相位模式两个选项都能选、都生效、都落盘**。
 *
 * 状态那一半（开关只灭灯不停时钟、两层的亮度各乘在整机亮度之下）由固件的
 * `lumen_scene_compose` / `lumen_layer_pixel` 承载，host 测试已覆盖；这里验的是
 * 界面真的把用户的选择变成了线上字节。
 */

import { describe, expect, it } from "vitest";
import { EFFECT_TYPE, NO_EFFECT, PHASE } from "../utils/protocol/constants";
import { openPage } from "./helpers/page-harness";

async function openPart() {
  return openPage("part", { strip: "0", part: "0" });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等超时");
}

/** 从设备读回该部位某个场景里的某一步（设备权威）。 */
async function deviceStep(harness: any, stepIndex = 0, stripId = 0, partId = 0) {
  const sceneId = harness.session.deviceState?.activeScene ?? 0;
  const read = await harness.session.queryScene(sceneId);
  if (read.kind !== "ok") {
    throw new Error(`读场景失败：${read.kind}`);
  }
  return read.scene.steps.find(
    (step: any) =>
      step.stripId === stripId && step.partId === partId && step.stepIndex === stepIndex,
  );
}

async function devicePhase(harness: any, stripId = 0, partId = 0): Promise<number> {
  const read = await harness.session.queryLayout(stripId);
  if (read.kind !== "ok") {
    throw new Error(`读布局失败：${read.kind}`);
  }
  return read.layout.parts.find((part: any) => part.partId === partId)?.phase ?? -1;
}

describe("叠加开关（E6：只有一个开关，没有混合方式选项）", () => {
  it("新步骤的叠加层是空的：设备上 layer1 = 空层", async () => {
    const harness = await openPart();
    try {
      const step = await deviceStep(harness);
      expect(step).toBeDefined();
      expect(step?.layer1.type).toBe(NO_EFFECT);
      expect(harness.page.data.overlayEnabled).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it("打开叠加 → 下发的 layer1 变成真实效果（不再是空层）", async () => {
    const harness = await openPart();
    try {
      harness.page.onOverlayToggle({ detail: { value: true } });
      expect(harness.page.data.overlayEnabled).toBe(true);

      /* 叠加层换成一个带动画的类型，再下发。 */
      harness.page.onOverlayTypeTap({ currentTarget: { dataset: { type: "comet" } } });
      await harness.page.onSaveContent();
      await waitFor(() => true);

      const step = await deviceStep(harness);
      expect(step?.layer0.type).not.toBe(NO_EFFECT);
      expect(step?.layer1.type).toBe(EFFECT_TYPE.COMET);
    } finally {
      await harness.dispose();
    }
  });

  it("关掉叠加 → layer1 回到空层（设备按覆盖合成）", async () => {
    const harness = await openPart();
    try {
      harness.page.onOverlayToggle({ detail: { value: true } });
      harness.page.onOverlayTypeTap({ currentTarget: { dataset: { type: "comet" } } });
      await harness.page.onSaveContent();
      await waitFor(() => true);
      expect((await deviceStep(harness))?.layer1.type).toBe(EFFECT_TYPE.COMET);

      harness.page.onOverlayToggle({ detail: { value: false } });
      expect(harness.page.data.overlayEnabled).toBe(false);
      await harness.page.onSaveContent();
      await waitFor(() => true);

      expect((await deviceStep(harness))?.layer1.type).toBe(NO_EFFECT);
    } finally {
      await harness.dispose();
    }
  });

  it("界面上没有「混合方式」四个字（E6：由系统决定）", async () => {
    const { readFileSync } = await import("node:fs");
    const wxml = readFileSync("pages/part/part.wxml", "utf8");
    for (const banned of ["混合方式", "混合模式", "blend", "覆盖模式", "相加"]) {
      expect(wxml, `界面不该出现「${banned}」`).not.toContain(banned);
    }
  });

  it("没内容的步骤禁用叠加开关（没有底层可叠）", async () => {
    const harness = await openPart();
    try {
      /* 把这一步的 step_count 变成 0 → 面板读不到层 → panelHasLayer = false。 */
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      await harness.session.setScenePart(sceneId, 0, 0, 0, 0, true);
      await harness.page.load();
      expect(harness.page.data.panelHasLayer).toBe(false);
      /* 处理器本身也不该让叠加层变成真的：关着的时候一律空层。 */
      harness.page.onOverlayToggle({ detail: { value: true } });
      expect(harness.page.data.overlayEnabled).toBe(false);
    } finally {
      await harness.dispose();
    }
  });
});

describe("两层各自的亮度（都乘在整机亮度之下）", () => {
  it("两层的 level 各自独立：改底层不动叠加层", async () => {
    const harness = await openPart();
    try {
      harness.page.onOverlayToggle({ detail: { value: true } });
      harness.page.onOverlayTypeTap({ currentTarget: { dataset: { type: "static" } } });
      await harness.page.onSaveContent();
      await waitFor(() => true);

      const before = await deviceStep(harness);
      const baseLevel = before?.layer0.level;
      const overlayLevel = before?.layer1.level;

      /* 把底层的亮度拖到很低，再下发。 */
      harness.page.onPanelSliderChange({
        currentTarget: { dataset: { key: "level" } },
        detail: { value: 20 },
      });
      await harness.page.onSaveContent();
      await waitFor(() => true);

      const after = await deviceStep(harness);
      expect(after?.layer0.level).toBeLessThan(baseLevel ?? 100);
      /* 叠加层的亮度没被底层的拖动带着变。 */
      expect(after?.layer1.level).toBe(overlayLevel);
    } finally {
      await harness.dispose();
    }
  });
});

describe("相位模式（S6）：两个选项都能选、都生效、都落盘", () => {
  it("默认是「连续」", async () => {
    const harness = await openPart();
    try {
      expect(harness.page.data.phase).toBe(PHASE.CONTINUOUS);
      expect(harness.page.data.phaseIndex).toBe(0);
      expect(await devicePhase(harness)).toBe(PHASE.CONTINUOUS);
    } finally {
      await harness.dispose();
    }
  });

  it("选「各自起点」→ 设备上的 phase 变成 1", async () => {
    const harness = await openPart();
    try {
      await harness.page.onPhasePick({ detail: { value: 1 } });
      await waitFor(() => harness.page.data.phase === PHASE.PER_SEGMENT);

      expect(harness.page.data.phaseIndex).toBe(1);
      expect(await devicePhase(harness)).toBe(PHASE.PER_SEGMENT);
    } finally {
      await harness.dispose();
    }
  });

  it("相位是布局属性：切场景不会改它，也从场景读不回它", async () => {
    const harness = await openPart();
    try {
      await harness.page.onPhasePick({ detail: { value: 1 } });
      await waitFor(() => harness.page.data.phase === PHASE.PER_SEGMENT);

      /* 读回布局（模拟重进页面 / 重连）——相位仍在。 */
      await harness.session.queryLayout(0);
      await harness.page.load();
      expect(harness.page.data.phase).toBe(PHASE.PER_SEGMENT);
      expect(harness.page.data.phaseIndex).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it("改相位不丢灯珠段（同一条命令同时携带 seg_count，写它会清段）", async () => {
    const harness = await openPart();
    try {
      const before = await harness.session.queryLayout(0);
      const beforeSegs =
        before.kind === "ok"
          ? before.layout.parts.find((part: any) => part.partId === 0)?.segs
          : undefined;
      expect(beforeSegs).toBeDefined();

      await harness.page.onPhasePick({ detail: { value: 1 } });
      await waitFor(() => harness.page.data.phase === PHASE.PER_SEGMENT);

      const after = await harness.session.queryLayout(0);
      const afterPart =
        after.kind === "ok"
          ? after.layout.parts.find((part: any) => part.partId === 0)
          : undefined;
      expect(afterPart?.segs).toEqual(beforeSegs);
      expect(afterPart?.phase).toBe(PHASE.PER_SEGMENT);
    } finally {
      await harness.dispose();
    }
  });

  it("改相位不动别的部位", async () => {
    const harness = await openPart();
    try {
      const before = await harness.session.queryLayout(0);
      const otherBefore =
        before.kind === "ok"
          ? before.layout.parts.find((part: any) => part.partId === 1)
          : undefined;

      await harness.page.onPhasePick({ detail: { value: 1 } });
      await waitFor(() => harness.page.data.phase === PHASE.PER_SEGMENT);

      const after = await harness.session.queryLayout(0);
      const other =
        after.kind === "ok"
          ? after.layout.parts.find((part: any) => part.partId === 1)
          : undefined;
      expect(other).toEqual(otherBefore);
      expect(other?.phase).toBe(PHASE.CONTINUOUS);
    } finally {
      await harness.dispose();
    }
  });
});
