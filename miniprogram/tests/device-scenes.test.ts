/**
 * 三个场景（#159）：切换、改名、开关随场景还原、断线缓存。
 *
 * 走真实页面处理器 + 真实会话 + 演示传输层。票面的四条验收里，「三个场景互相
 * 独立」与「开关状态属于场景」只有把**三个都存下来**才测得出来——所以演示
 * 传输层也从「只保留激活那一个」改成了按场景分开存（见 `mock-transport.ts`
 * 的 `MockRuntime.scenes`）。
 */

import { describe, expect, it } from "vitest";
import { MAX_SCENES, NAME_BYTES } from "../utils/protocol/constants";
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

/** 直接读设备上某个场景里某部位的头部（设备权威）。 */
async function deviceScenePart(
  harness: any,
  sceneId: number,
  stripId = 0,
  partId = 0,
): Promise<{ stepCount: number; loop: number; on: boolean } | undefined> {
  const read = await harness.session.queryScene(sceneId);
  if (read.kind !== "ok") {
    throw new Error(`读场景失败：${read.kind}`);
  }
  return read.scene.parts.find(
    (part: any) => part.stripId === stripId && part.partId === partId,
  );
}

describe("场景条：三个场景都在，当前那个被标出来", () => {
  it("连上设备后画出 3 个场景", async () => {
    const harness = await openDevice();
    try {
      const tabs = harness.page.data.sceneTabs as Array<{ sceneId: number; label: string }>;
      expect(tabs.length).toBe(MAX_SCENES);
      expect(tabs.map((tab) => tab.label)).toEqual(["场景 1", "场景 2", "场景 3"]);
      expect(harness.page.data.sceneActive).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it("当前场景被标记为 active", async () => {
    const harness = await openDevice();
    try {
      const tabs = harness.page.data.sceneTabs as Array<{ active: boolean }>;
      expect(tabs.map((tab) => tab.active)).toEqual([true, false, false]);
    } finally {
      await harness.dispose();
    }
  });
});

describe("切场景", () => {
  it("点第二个场景 → 设备的 activeScene 变成 1，界面跟着换", async () => {
    const harness = await openDevice();
    try {
      await harness.page.onSceneTap({ currentTarget: { dataset: { sceneId: 1 } } });
      await waitFor(() => harness.page.data.sceneActive === 1);

      expect(harness.session.deviceState?.activeScene).toBe(1);
      const tabs = harness.page.data.sceneTabs as Array<{ active: boolean }>;
      expect(tabs.map((tab) => tab.active)).toEqual([false, true, false]);
    } finally {
      await harness.dispose();
    }
  });

  it("来回切 10 次，每次都落在点的那一个（硬切，不累积）", async () => {
    const harness = await openDevice();
    try {
      for (let i = 0; i < 10; i += 1) {
        const target = i % MAX_SCENES;
        await harness.page.onSceneTap({ currentTarget: { dataset: { sceneId: target } } });
        await waitFor(() => harness.page.data.sceneActive === target);
        expect(harness.session.deviceState?.activeScene).toBe(target);
      }
    } finally {
      await harness.dispose();
    }
  });

  it("点已经在的那个场景不发帧（引用语义：不重跳）", async () => {
    const harness = await openDevice();
    try {
      const before = harness.transport.writes?.length ?? 0;
      await harness.page.onSceneTap({ currentTarget: { dataset: { sceneId: 0 } } });
      const after = harness.transport.writes?.length ?? 0;
      expect(after).toBe(before);
    } finally {
      await harness.dispose();
    }
  });

  it("三个场景各自配不同的时间轴，互不影响", async () => {
    const harness = await openDevice();
    try {
      /* 场景 1：3 步；场景 2：1 步；场景 3：2 步。 */
      const counts = [3, 1, 2];
      for (let sceneId = 0; sceneId < MAX_SCENES; sceneId += 1) {
        await harness.session.setScenePart(sceneId, 0, 0, counts[sceneId], 1, true);
      }

      for (let sceneId = 0; sceneId < MAX_SCENES; sceneId += 1) {
        const part = await deviceScenePart(harness, sceneId);
        expect(part?.stepCount).toBe(counts[sceneId]);
      }
    } finally {
      await harness.dispose();
    }
  });
});

describe("开关状态属于场景（C4 / T9）", () => {
  it("A 场景关掉这个部位，切到 B 再切回 A，它仍然关着", async () => {
    const harness = await openDevice();
    try {
      /* A（场景 0）关掉部位 0。 */
      await harness.session.setScenePart(0, 0, 0, 1, 0, false);
      expect((await deviceScenePart(harness, 0))?.on).toBe(false);

      /* B（场景 1）保持开着。 */
      await harness.session.setScenePart(1, 0, 0, 1, 0, true);
      expect((await deviceScenePart(harness, 1))?.on).toBe(true);

      /* 切到 B 再切回 A。 */
      await harness.page.onSceneTap({ currentTarget: { dataset: { sceneId: 1 } } });
      await waitFor(() => harness.page.data.sceneActive === 1);
      await harness.page.onSceneTap({ currentTarget: { dataset: { sceneId: 0 } } });
      await waitFor(() => harness.page.data.sceneActive === 0);

      /* A 的 `on` 没被 B 覆盖（两个场景各存一份）。 */
      expect((await deviceScenePart(harness, 0))?.on).toBe(false);
      expect((await deviceScenePart(harness, 1))?.on).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("场景里某部位 0 步 = 本场景不演（别的场景不受影响）", async () => {
    const harness = await openDevice();
    try {
      await harness.session.setScenePart(0, 0, 0, 0, 0, true);
      /*
       * 0 步的部位**不会出现在 QueryScene 的读回里**（与固件 §7.2 / §6.2 同口径：
       * 只有 `step_count > 0` 的部位才报）。所以这里断言「读回里找不到它」。
       */
      expect(await deviceScenePart(harness, 0)).toBeUndefined();
      /* 场景 1 仍然是出厂那 1 步。 */
      expect((await deviceScenePart(harness, 1))?.stepCount).toBe(1);
    } finally {
      await harness.dispose();
    }
  });
});

describe("场景改名（C2 / C3：设备权威）", () => {
  it("改名后设备上的名字变了，界面也变了", async () => {
    const harness = await openDevice();
    try {
      harness.page.onSceneLongPress({ currentTarget: { dataset: { sceneId: 0 } } });
      expect(harness.page.data.sceneNameOpen).toBe(true);

      harness.page.onSceneNameInput({ detail: { value: "待机" } });
      await harness.page.onSceneNameSave();
      await waitFor(() => harness.page.data.sceneNameOpen === false);

      const read = await harness.session.queryScene(0);
      expect(read.kind === "ok" ? read.scene.name : "").toBe("待机");
      const tabs = harness.page.data.sceneTabs as Array<{ label: string }>;
      expect(tabs[0].label).toBe("待机");
    } finally {
      await harness.dispose();
    }
  });

  it("名字存进设备：清掉缓存重读仍在（换手机也在）", async () => {
    const harness = await openDevice();
    try {
      await harness.session.setSceneName(2, "演出");
      /* 模拟「本地什么都没有」：只留设备读回这一条路。 */
      const read = await harness.session.queryScene(2);
      expect(read.kind === "ok" ? read.scene.name : "").toBe("演出");
    } finally {
      await harness.dispose();
    }
  });

  it("空名字被拒（界面不该让按钮变空白）", async () => {
    const harness = await openDevice();
    try {
      harness.page.onSceneLongPress({ currentTarget: { dataset: { sceneId: 0 } } });
      harness.page.onSceneNameInput({ detail: { value: "   " } });
      await harness.page.onSceneNameSave();

      /* 没提交成功：弹窗还开着，设备上的名字没变。 */
      expect(harness.page.data.sceneNameOpen).toBe(true);
      const read = await harness.session.queryScene(0);
      expect(read.kind === "ok" ? read.scene.name : "").toBe("场景 1");
    } finally {
      await harness.dispose();
    }
  });

  it("超过 24 字节被拒", async () => {
    const harness = await openDevice();
    try {
      harness.page.onSceneLongPress({ currentTarget: { dataset: { sceneId: 0 } } });
      harness.page.onSceneNameInput({ detail: { value: "一二三四五六七八九" } }); /* 27 字节 */
      await harness.page.onSceneNameSave();

      expect(harness.page.data.sceneNameOpen).toBe(true);
      expect(harness.page.data.sceneNameBytes).toBeGreaterThan(NAME_BYTES);
    } finally {
      await harness.dispose();
    }
  });

  it("改名打开时预填当前名字（有名字才有内容）", async () => {
    const harness = await openDevice();
    try {
      await harness.session.setSceneName(0, "战斗");
      await harness.session.queryScene(0);
      harness.page.renderSceneBar();

      harness.page.onSceneLongPress({ currentTarget: { dataset: { sceneId: 0 } } });
      expect(harness.page.data.sceneNameInput).toBe("战斗");
    } finally {
      await harness.dispose();
    }
  });
});

describe("断线与空态", () => {
  it("没连接时不切场景、不弹改名（都要先连上）", async () => {
    const harness = await openDevice();
    try {
      await harness.session.disconnect();
      await harness.page.onShow();
      expect(harness.page.data.ready).toBe(false);

      harness.page.onSceneLongPress({ currentTarget: { dataset: { sceneId: 0 } } });
      expect(harness.page.data.sceneNameOpen).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it("三个场景都有内容时不显示空态引导", async () => {
    const harness = await openDevice();
    try {
      expect(harness.page.data.sceneAllEmpty).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it("三个场景都 0 步时显示空态引导", async () => {
    const harness = await openDevice();
    try {
      for (let sceneId = 0; sceneId < MAX_SCENES; sceneId += 1) {
        await harness.session.setScenePart(sceneId, 0, 0, 0, 0, true);
      }
      harness.page.renderSceneBar();
      expect(harness.page.data.sceneAllEmpty).toBe(true);
    } finally {
      await harness.dispose();
    }
  });
});
