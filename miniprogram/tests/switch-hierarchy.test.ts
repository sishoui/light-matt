/**
 * 开关层级（#160）：灯组开关 × 部位开关，各关各的。
 *
 * 票面这一张**本来就不需要改代码**——存储模型天然满足它：
 *
 *  - 灯组开关是 `State.strip_power_mask` 的一位；
 *  - 部位开关是**场景里**的 `on` 字节（`ScenePart` 0x25），与灯组掩码无关。
 *
 * 两层住在不同的表里，所以「父关全灭、子状态仍记得」根本不需要额外机制。
 * 这一张要的是**证据**：把票面每一条都显式钉住，免得以后有人把两者并进
 * 同一张表（那才会退回 v4 的「父关就丢掉子状态」）。
 */

import { describe, expect, it } from "vitest";
import { MAX_SCENES } from "../utils/protocol/constants";
import { openPage } from "./helpers/page-harness";

async function openDevice() {
  return openPage("device", {});
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等超时");
}

/** 等一次 `sendAndWaitAck` 往返落定（mock 是异步的，但很快）。 */
async function settleAck(): Promise<void> {
  await new Promise((r) => setTimeout(r, 120));
}

/** 展开 strip 0 并等部位行就位。 */
async function expandStrip(harness: any, stripId = 0) {
  harness.page.onStripCardTap({ currentTarget: { dataset: { stripId } } });
  await waitFor(() => {
    const card = (harness.page.data.stripCards as any[]).find(
      (item) => item.stripId === stripId,
    );
    return card !== undefined && card.expanded === true && card.parts.length > 0;
  });
  return (harness.page.data.stripCards as any[]).find((item) => item.stripId === stripId);
}

/** 设备上的灯组开关位。 */
function stripBit(session: any, stripId = 0): boolean {
  const mask = session.deviceState?.stripPowerMask ?? 0;
  return (mask & (1 << stripId)) !== 0;
}

/** 设备上某场景里某部位的 `on`。 */
async function partOn(session: any, sceneId = 0, stripId = 0, partId = 0): Promise<boolean | null> {
  const read = await session.queryScene(sceneId);
  if (read.kind !== "ok") {
    return null;
  }
  const part = read.scene.parts.find(
    (item: any) => item.stripId === stripId && item.partId === partId,
  );
  return part === undefined ? null : part.on;
}

describe("灯组开关（父）", () => {
  it("关掉 → `strip_power_mask` 那一位归零；打开 → 恢复", async () => {
    const harness = await openDevice();
    try {
      await expandStrip(harness);

      harness.page.onStripPowerChange({
        currentTarget: { dataset: { stripId: 0 } },
        detail: { value: false },
      });
      await waitFor(() => !stripBit(harness.session, 0));
      expect(stripBit(harness.session, 0)).toBe(false);

      harness.page.onStripPowerChange({
        currentTarget: { dataset: { stripId: 0 } },
        detail: { value: true },
      });
      await waitFor(() => stripBit(harness.session, 0));
      expect(stripBit(harness.session, 0)).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("关一条链不动别的链的开关位", async () => {
    const harness = await openDevice();
    try {
      await expandStrip(harness);
      const before = harness.session.deviceState?.stripPowerMask ?? 0;

      harness.page.onStripPowerChange({
        currentTarget: { dataset: { stripId: 0 } },
        detail: { value: false },
      });
      await waitFor(() => !stripBit(harness.session, 0));

      const after = harness.session.deviceState?.stripPowerMask ?? 0;
      /* 只有第 0 位变了。 */
      expect(after & ~1).toBe(before & ~1);
    } finally {
      await harness.dispose();
    }
  });
});

describe("部位开关（子）", () => {
  it("单独关掉一个部位 → 那个部位的 on 归零，别的部位照常", async () => {
    const harness = await openDevice();
    try {
      await expandStrip(harness);

      harness.page.onPartSwitchChange({
        currentTarget: { dataset: { stripId: 0, partId: 0 } },
        detail: { value: false },
      });
      await settleAck();

      expect(await partOn(harness.session, 0, 0, 0)).toBe(false);
      /* 部位 1 仍是开的。 */
      expect(await partOn(harness.session, 0, 0, 1)).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("改部位开关不碰灯组掩码（两层互不越界）", async () => {
    const harness = await openDevice();
    try {
      await expandStrip(harness);
      const maskBefore = harness.session.deviceState?.stripPowerMask ?? 0;

      harness.page.onPartSwitchChange({
        currentTarget: { dataset: { stripId: 0, partId: 0 } },
        detail: { value: false },
      });
      await settleAck();

      expect(harness.session.deviceState?.stripPowerMask).toBe(maskBefore);
    } finally {
      await harness.dispose();
    }
  });

  it("只改 on 一位：步数与循环不动（那条命令同时携带三者）", async () => {
    const harness = await openDevice();
    try {
      await expandStrip(harness);
      const sceneId = harness.session.deviceState?.activeScene ?? 0;

      /* 先确认出厂是 1 步、不循环。 */
      const before = await harness.session.queryScene(sceneId);
      const partBefore =
        before.kind === "ok"
          ? before.scene.parts.find((item: any) => item.stripId === 0 && item.partId === 0)
          : undefined;
      expect(partBefore?.stepCount).toBe(1);
      expect(partBefore?.loop).toBe(0);

      harness.page.onPartSwitchChange({
        currentTarget: { dataset: { stripId: 0, partId: 0 } },
        detail: { value: false },
      });
      await settleAck();

      const after = await harness.session.queryScene(sceneId);
      const partAfter =
        after.kind === "ok"
          ? after.scene.parts.find((item: any) => item.stripId === 0 && item.partId === 0)
          : undefined;
      expect(partAfter?.on).toBe(false);
      /* 时间轴没被抹掉（§6.2：步数不变就不清空步骤）。 */
      expect(partAfter?.stepCount).toBe(partBefore?.stepCount);
      expect(partAfter?.loop).toBe(partBefore?.loop);
    } finally {
      await harness.dispose();
    }
  });

  it("关掉再打开：从停下的位置接着走，不回到第 1 步", async () => {
    const harness = await openDevice();
    try {
      await expandStrip(harness);
      const sceneId = harness.session.deviceState?.activeScene ?? 0;

      /* 先给它排两步，这样才能看出「没回到第 1 步」。 */
      await harness.session.setScenePart(sceneId, 0, 0, 2, 0, true);

      harness.page.onPartSwitchChange({
        currentTarget: { dataset: { stripId: 0, partId: 0 } },
        detail: { value: false },
      });
      await settleAck();
      harness.page.onPartSwitchChange({
        currentTarget: { dataset: { stripId: 0, partId: 0 } },
        detail: { value: true },
      });
      await settleAck();

      /* 开关只改 on：步数仍是 2。时钟是否「接着走」由固件保证（它不看 on），
         这里能验的是「没有把时间轴重置」——也就是没有退回 1 步。 */
      expect(await partOn(harness.session, sceneId, 0, 0)).toBe(true);
      const read = await harness.session.queryScene(sceneId);
      const part =
        read.kind === "ok"
          ? read.scene.parts.find((item: any) => item.stripId === 0 && item.partId === 0)
          : undefined;
      expect(part?.stepCount).toBe(2);
    } finally {
      await harness.dispose();
    }
  });
});

describe("父关再开：子开关状态记得", () => {
  it("关掉灯组 → 打开灯组，之前单独关掉的部位**仍然关着**（T9）", async () => {
    const harness = await openDevice();
    try {
      await expandStrip(harness);
      const sceneId = harness.session.deviceState?.activeScene ?? 0;

      /* 1) 先单独关掉部位 0。 */
      harness.page.onPartSwitchChange({
        currentTarget: { dataset: { stripId: 0, partId: 0 } },
        detail: { value: false },
      });
      await settleAck();
      expect(await partOn(harness.session, sceneId, 0, 0)).toBe(false);

      /* 2) 关掉整条链。 */
      harness.page.onStripPowerChange({
        currentTarget: { dataset: { stripId: 0 } },
        detail: { value: false },
      });
      await waitFor(() => !stripBit(harness.session, 0));

      /* 3) 再把整条链打开。 */
      harness.page.onStripPowerChange({
        currentTarget: { dataset: { stripId: 0 } },
        detail: { value: true },
      });
      await waitFor(() => stripBit(harness.session, 0));

      /* 4) 部位 0 仍然关着——父开关没有把它改成「开」。 */
      expect(await partOn(harness.session, sceneId, 0, 0)).toBe(false);
      /* 而另一个部位本来就开着，也还是开着。 */
      expect(await partOn(harness.session, sceneId, 0, 1)).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("父开关全程不写任何场景数据（子状态住在场景表里）", async () => {
    const harness = await openDevice();
    try {
      await expandStrip(harness);
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      const before = await harness.session.queryScene(sceneId);
      const partsBefore = before.kind === "ok" ? before.scene.parts : [];

      harness.page.onStripPowerChange({
        currentTarget: { dataset: { stripId: 0 } },
        detail: { value: false },
      });
      await waitFor(() => !stripBit(harness.session, 0));
      harness.page.onStripPowerChange({
        currentTarget: { dataset: { stripId: 0 } },
        detail: { value: true },
      });
      await waitFor(() => stripBit(harness.session, 0));

      const after = await harness.session.queryScene(sceneId);
      const partsAfter = after.kind === "ok" ? after.scene.parts : [];
      /* 逐部位一致：位置开关没有动过场景里的任何一个 on。 */
      expect(partsAfter.map((part: any) => [part.partId, part.on])).toEqual(
        partsBefore.map((part: any) => [part.partId, part.on]),
      );
    } finally {
      await harness.dispose();
    }
  });
});

describe("部位开关属于场景（跟着场景切换还原）", () => {
  it("A 场景关掉部位、B 场景开着；切回 A 时界面显示关着", async () => {
    const harness = await openDevice();
    try {
      await expandStrip(harness);

      /* A（场景 0）关掉部位 0；B（场景 1）保持开着。 */
      await harness.session.setScenePart(0, 0, 0, 1, 0, false);
      await harness.session.setScenePart(1, 0, 0, 1, 0, true);

      /* 停在 A 时行上显示关。 */
      harness.page.renderStripCards();
      let card = (harness.page.data.stripCards as any[]).find((item) => item.stripId === 0);
      expect(card.parts[0].on).toBe(false);

      /* 切到 B → 显示开。 */
      await harness.page.onSceneTap({ currentTarget: { dataset: { sceneId: 1 } } });
      await waitFor(() => harness.page.data.sceneActive === 1);
      await waitFor(() => {
        const current = (harness.page.data.stripCards as any[]).find(
          (item) => item.stripId === 0,
        );
        return current !== undefined && current.parts[0]?.on === true;
      });
      card = (harness.page.data.stripCards as any[]).find((item) => item.stripId === 0);
      expect(card.parts[0].on).toBe(true);

      /* 切回 A → 又是关。 */
      await harness.page.onSceneTap({ currentTarget: { dataset: { sceneId: 0 } } });
      await waitFor(() => harness.page.data.sceneActive === 0);
      await waitFor(() => {
        const current = (harness.page.data.stripCards as any[]).find(
          (item) => item.stripId === 0,
        );
        return current !== undefined && current.parts[0]?.on === false;
      });
    } finally {
      await harness.dispose();
    }
  });

  it("每个场景各自记住自己的开关（三个场景三种状态）", async () => {
    const harness = await openDevice();
    try {
      await harness.session.setScenePart(0, 0, 0, 1, 0, true);
      await harness.session.setScenePart(1, 0, 0, 1, 0, false);
      await harness.session.setScenePart(2, 0, 0, 1, 0, true);

      expect(await partOn(harness.session, 0, 0, 0)).toBe(true);
      expect(await partOn(harness.session, 1, 0, 0)).toBe(false);
      expect(await partOn(harness.session, 2, 0, 0)).toBe(true);
      expect(MAX_SCENES).toBe(3);
    } finally {
      await harness.dispose();
    }
  });
});

describe("没有播放 / 暂停按钮", () => {
  it("页面上不存在播放控制（时钟一直在走，开关只灭灯）", async () => {
    const { readFileSync } = await import("node:fs");
    const wxml = readFileSync("pages/device/device.wxml", "utf8");
    for (const banned of ["播放", "暂停", "停止播放", "恢复播放"]) {
      expect(wxml, `设备页不该有「${banned}」`).not.toContain(banned);
    }
  });
});
