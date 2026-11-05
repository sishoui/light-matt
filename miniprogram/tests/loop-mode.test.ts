/**
 * 循环三档必须真的到达设备（#114）。
 *
 * 三条断言层次不同的路径：
 *  1. `buildScriptPlan` 把三值原样写进 ActivateScript（纯函数，最便宜的定位点）；
 *  2. 页面的「应用并播放」/「继续播放」路径下发的是**用户选的那一档**；
 *  3. 一档改完不改草稿之外的任何东西——即「循环改动不触发设备写入」的反面：
 *     草稿为空时一帧都不发。
 *
 * 断言的是**设备可观察状态**（`session.deviceState.flags`），不是页面 `data`。
 * 演示传输层按 §7.5 的位表建模三值：loop=2 → bit0|bit2（0x05 / 0x07），
 * 所以这三档在没有真机时也能区分开。
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ControlSession } from "../utils/control/session";
import { MockTransport } from "../utils/ble/mock-transport";
import type { BleTransport } from "../utils/ble/transport";
import { MOCK_DEVICES } from "../utils/control/mock-devices";
import { setSessionForTest } from "../utils/control/session-singleton";
import { buildScriptPlan } from "../utils/control/script-plan";
import { LOOP_MODE, resolveLoopMode } from "../utils/control/advanced-layers";
import { PLAYBACK_FLAG, SEGMENT_TYPE } from "../utils/protocol/constants";
import { createSessionStorage } from "./helpers/storage";
import { installGlobals, instantiate } from "./helpers/page-runtime";

const DEVICE = MOCK_DEVICES[0];

/** 简短的脚本：两阶段，第二个阶段有一整条灯带的分区。 */
function twoStageScript(ledCount: number) {
  return {
    scriptId: 0,
    stripCount: 1,
    stages: [
      { durationMs: 400, segments: [] },
      {
        durationMs: 400,
        segments: [
          {
            stripId: 0,
            segId: 0,
            start: 0,
            end: ledCount - 1,
            blend: 0,
            layer0: {
              type: SEGMENT_TYPE.STATIC,
              hue: 0,
              sat: 0,
              periodMs: 0,
              p5: 0,
              flags: 0,
              level: 100,
            },
            layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
          },
        ],
      },
    ],
  } as const;
}

/** flags 里的循环档位（与 §7.5 位表一致）。 */
function loopOf(flags: number): number {
  if ((flags & PLAYBACK_FLAG.LOOP) === 0) {
    return 0;
  }
  return (flags & PLAYBACK_FLAG.LOOP_LAST) !== 0 ? 2 : 1;
}

describe("#114 循环三档：计划层不压平", () => {
  it("ActivateScript 的 loop 字节就是入参（0 / 1 / 2）", () => {
    const script = twoStageScript(30);
    for (const loop of [0, 1, 2] as const) {
      const plan = buildScriptPlan(script as never, { activate: true, loop });
      const activate = plan.steps.find((step) => step.kind === "activate");
      expect(activate, `loop=${loop} 应有 activate 步`).toBeDefined();
      expect(activate!.request.payload[1], `loop=${loop} 的 ActivateScript 字节`).toBe(loop);
    }
  });

  it("「播一次」只在真的不循环时出现（0 不能被当成循环）", () => {
    const script = twoStageScript(30);
    const labels = ([0, 1, 2] as const).map(
      (loop) =>
        buildScriptPlan(script as never, { activate: true, loop }).steps.find(
          (step) => step.kind === "activate",
        )!.label,
    );
    expect(new Set(labels).size, `三档文案应当互不相同：${labels.join(" / ")}`).toBe(3);
  });
});

describe("#114 循环三档：会话直传", () => {
  async function makeSession() {
    const session = new ControlSession({
      platform: "other",
      devMode: false,
      storage: createSessionStorage(),
      transportOverride: new MockTransport() as unknown as BleTransport,
      reconnectDelaysMs: [],
    });
    await session.connect(DEVICE.deviceId, DEVICE.broadcastName);
    return session;
  }

  it("downloadScript 激活的档位与 setPlayback 播放的档位都落到设备 flags", async () => {
    const session = await makeSession();
    const ledCount = session.deviceState!.stripCounts[0];
    try {
      for (const loop of [0, 1, 2] as const) {
        const uploaded = await session.downloadScript(twoStageScript(ledCount) as never, {
          activate: true,
          loop,
        });
        expect(uploaded.kind, `loop=${loop} 下发应当成功`).toBe("ok");
        expect(loopOf(session.deviceState!.flags), `激活后 loop=${loop}`).toBe(loop);

        const played = await session.setPlayback(1, loop);
        expect(played.kind, `loop=${loop} 播放应当成功`).toBe("ok");
        expect(loopOf(session.deviceState!.flags), `播放后 loop=${loop}`).toBe(loop);
      }
    } finally {
      await session.disconnect();
    }
  });
});

describe("#114 循环三档：单一推导（草稿优先，设备兜底）", () => {
  it("草稿选过就以草稿为准，哪怕设备报的是另一档", () => {
    expect(resolveLoopMode(0, 0x07)).toBe(LOOP_MODE.NONE);
    expect(resolveLoopMode(2, 0x00)).toBe(LOOP_MODE.LAST);
    expect(resolveLoopMode(1, 0x07)).toBe(LOOP_MODE.ALL);
  });

  it("兜底能区分三档（不是「是否在循环」）", () => {
    expect(resolveLoopMode(undefined, 0x02)).toBe(LOOP_MODE.NONE);
    expect(resolveLoopMode(undefined, 0x03)).toBe(LOOP_MODE.ALL);
    expect(resolveLoopMode(undefined, 0x07)).toBe(LOOP_MODE.LAST);
  });

  it("草稿缺失且设备也没读到 → 不循环", () => {
    expect(resolveLoopMode(undefined, null)).toBe(LOOP_MODE.NONE);
  });

  it("坏草稿值不算「用户选过」，交给设备", () => {
    expect(resolveLoopMode(3, 0x03)).toBe(LOOP_MODE.ALL);
    expect(resolveLoopMode(-1, 0x07)).toBe(LOOP_MODE.LAST);
  });
});

describe("#114 循环三档：页面点击链路", () => {
  /* 页面用 `wx` 的存储与几个渲染期 API；这些桩不参与任何业务判定。
   * 存储每个用例一份（互不串扰），渲染期 API 由 `installGlobals` 补一次。 */
  let wxStub: any = null;
  /* `Page({...})` 只在模块首次求值时被调用一次；之后 import 走缓存。 */
  let pageDef: any = null;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const tap = (dataset: Record<string, any>) => ({ currentTarget: { dataset } });

  async function openPage() {
    const store = new Map<string, any>();
    if (wxStub === null) {
      wxStub = {
        getStorageSync: (key: string) => store.get(key),
        setStorageSync: (key: string, value: any) => void store.set(key, value),
        removeStorageSync: (key: string) => void store.delete(key),
        getStorageInfoSync: () => ({ keys: [...store.keys()] }),
        showToast: () => undefined,
        showModal: () => undefined,
        vibrateShort: () => undefined,
      };
      const captured = installGlobals({ wx: wxStub });
      await import("../pages/strip/strip");
      pageDef = captured[captured.length - 1];
      expect(pageDef, "页面模块应当注册 Page({...})").toBeDefined();
    } else {
      const backing = new Map<string, any>();
      wxStub.getStorageSync = (key: string) => backing.get(key);
      wxStub.setStorageSync = (key: string, value: any) => void backing.set(key, value);
      wxStub.removeStorageSync = (key: string) => void backing.delete(key);
      wxStub.getStorageInfoSync = () => ({ keys: [...backing.keys()] });
      (globalThis as any).wx = wxStub;
    }

    const session = new ControlSession({
      platform: "other",
      devMode: false,
      storage: createSessionStorage(),
      transportOverride: new MockTransport() as unknown as BleTransport,
      reconnectDelaysMs: [],
    });
    await session.connect(DEVICE.deviceId, DEVICE.broadcastName);
    setSessionForTest(session);

    const page = instantiate(pageDef);
    page.onLoad({ strip: "0" });
    page.onShow();
    for (let i = 0; i < 200 && page.data.ready !== true; i += 1) {
      await sleep(50);
    }
    expect(page.data.ready, "页面应当 ready").toBe(true);
    return { page, session };
  }

  /** 划一个分区，让草稿非空（空方案时 applyAdvanced 一帧都不发）。 */
  async function addZone(page: any) {
    page.onModeTap(tap({ mode: "advanced" }));
    await sleep(150);
    page.onZoneAdd();
    await sleep(150);
    page.onPickerCellTap(tap({ index: "0" }));
    await sleep(80);
    page.onPickerCellTap(tap({ index: "3" }));
    await sleep(80);
    page.onPickerConfirm();
    await sleep(300);
  }

  it("点三档中任一档，设备 flags 的循环位就是那一档", async () => {
    const { page, session } = await openPage();
    try {
      await addZone(page);
      for (const mode of [0, 1, 2] as const) {
        page.onLoopTap(tap({ value: String(mode) }));
        await sleep(1200);
        expect(loopOf(session.deviceState!.flags), `点第 ${mode} 档后设备 flags`).toBe(mode);
      }
    } finally {
      await session.disconnect();
    }
  }, 120_000);

  it("「继续播放」与「应用并播放」下发同一档位时设备收到相同的值", async () => {
    const { page, session } = await openPage();
    try {
      await addZone(page);
      page.onLoopTap(tap({ value: "2" }));
      await sleep(1200);

      await page.onApplyAndPlay();
      await sleep(1500);
      const viaApply = loopOf(session.deviceState!.flags);

      await page.activatePlan(0);
      await sleep(1200);
      const viaResume = loopOf(session.deviceState!.flags);

      expect(viaApply, "应用并播放后").toBe(2);
      expect(viaResume, "继续播放后").toBe(2);
      expect(viaResume).toBe(viaApply);
    } finally {
      await session.disconnect();
    }
  }, 120_000);

  it("设备在循环、草稿没选过时点「不循环」，这次点击必须生效", async () => {
    const { page, session } = await openPage();
    const ledCount = session.deviceState!.stripCounts[0];
    try {
      await session.downloadScript(twoStageScript(ledCount) as never, { activate: true, loop: 2 });
      await session.setPlayback(1, 2);
      await sleep(200);
      expect(loopOf(session.deviceState!.flags), "前置：设备应在最后一步循环").toBe(2);
      expect(page.currentDraft().loop, "前置：草稿没选过").toBeUndefined();

      await addZone(page);
      page.onLoopTap(tap({ value: "0" }));
      await sleep(1200);
      expect(loopOf(session.deviceState!.flags), "点不循环后设备应停在不循环").toBe(0);
    } finally {
      await session.disconnect();
    }
  }, 120_000);

  it("简单档改颜色不篡改设备上的循环档位（暂停态，没有恢复帧兜住）", async () => {
    const { page, session } = await openPage();
    const ledCount = session.deviceState!.stripCounts[0];
    try {
      await session.downloadScript(twoStageScript(ledCount) as never, { activate: true, loop: 2 });
      /* 暂停：`writeQuick` 会先停播，但**不会**在写完恢复播放（它只恢复
       * 「原来在播」的情况），所以循环档位一旦被改写就留在了设备上。 */
      await session.setPlayback(2, 2);
      await sleep(200);
      expect(session.deviceState!.playbackState, "前置：设备应当处于暂停").toBe(2);
      expect(loopOf(session.deviceState!.flags), "前置：设备应在最后一步循环").toBe(2);

      /* 草稿要有内容，否则 silentDownloadPlans 在 planIsEmpty 处提前返回。 */
      await addZone(page);
      page.onModeTap(tap({ mode: "simple" }));
      await sleep(200);

      page.selectEffect("breathe", "breathe");
      await sleep(2500);
      expect(loopOf(session.deviceState!.flags), "点效果卡后档位应保持在最后一步循环").toBe(2);
    } finally {
      await session.disconnect();
    }
  }, 120_000);
});

