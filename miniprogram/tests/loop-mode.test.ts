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
import { CMD, PLAYBACK_FLAG, SEGMENT_TYPE } from "../utils/protocol/constants";
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

/* ------------------------------------------------------------------ */
/* 页面底座（#115）：模块级共享一份                                       */
/* ------------------------------------------------------------------ */

/*
 * `Page({...})` 只在模块**首次**求值时被调用一次，之后 `import` 走缓存。
 * 所以页面定义只能捕获一次——这段必须放在 describe 外面，否则第二个
 * describe 会拿到空的 `captured`（实测：单独跑绿、全量跑全红）。
 */
let sharedWx: any = null;
let sharedPageDef: any = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tap = (dataset: Record<string, any>) => ({ currentTarget: { dataset } });

/**
 * 加载真实页面模块并注入演示会话。
 *
 * 存储每个用例一份（互不串扰）；渲染期 API 由 `installGlobals` 补一次，
 * 那些桩只让派生算得出确定值，不掺业务判定。
 */
async function openPage() {
  const store = new Map<string, any>();
  if (sharedWx === null) {
    sharedWx = {
      getStorageSync: (key: string) => store.get(key),
      setStorageSync: (key: string, value: any) => void store.set(key, value),
      removeStorageSync: (key: string) => void store.delete(key),
      getStorageInfoSync: () => ({ keys: [...store.keys()] }),
      showToast: () => undefined,
      showModal: () => undefined,
      vibrateShort: () => undefined,
    };
    const captured = installGlobals({ wx: sharedWx });
    await import("../pages/strip/strip");
    sharedPageDef = captured[captured.length - 1];
    expect(sharedPageDef, "页面模块应当注册 Page({...})").toBeDefined();
  } else {
    const backing = new Map<string, any>();
    sharedWx.getStorageSync = (key: string) => backing.get(key);
    sharedWx.setStorageSync = (key: string, value: any) => void backing.set(key, value);
    sharedWx.removeStorageSync = (key: string) => void backing.delete(key);
    sharedWx.getStorageInfoSync = () => ({ keys: [...backing.keys()] });
    (globalThis as any).wx = sharedWx;
  }

  const transport = new MockTransport();
  const session = new ControlSession({
    platform: "other",
    devMode: false,
    storage: createSessionStorage(),
    transportOverride: transport as unknown as BleTransport,
    reconnectDelaysMs: [],
  });
  await session.connect(DEVICE.deviceId, DEVICE.broadcastName);
  setSessionForTest(session);

  const page = instantiate(sharedPageDef);
  page.onLoad({ strip: "0" });
  page.onShow();
  for (let i = 0; i < 200 && page.data.ready !== true; i += 1) {
    await sleep(50);
  }
  expect(page.data.ready, "页面应当 ready").toBe(true);
  return { page, session, transport };
}

describe("#114 循环三档：页面点击链路", () => {

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

  it("「继续播放」保持设备原来那一档，不会被自动下发改掉（#125 去掉按钮后）", async () => {
    const { page, session } = await openPage();
    try {
      await addZone(page);
      page.onLoopTap(tap({ value: "2" }));
      await sleep(1200);

      /* #125：没有「应用并播放」按钮了——任何编辑都自动下发，所以这里
       * 直接验证「设备上的档位就是刚点的那一档」。 */
      const viaApply = loopOf(session.deviceState!.flags);

      await page.activatePlan(0);
      await sleep(1200);
      const viaResume = loopOf(session.deviceState!.flags);

      expect(viaApply, "自动下发后").toBe(2);
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

  it("草稿为空时，改循环档位一帧都不发（但用户的选择要留在草稿里）", async () => {
    const { page, session } = await openPage();
    try {
      const sent: string[] = [];
      for (const name of ["downloadScript", "setPlayback", "activateScript"]) {
        const original = (session as any)[name].bind(session);
        (session as any)[name] = async (...args: any[]) => {
          sent.push(name);
          return original(...args);
        };
      }
      const before = session.deviceState!.flags;

      page.onModeTap(tap({ mode: "advanced" }));
      await sleep(300);
      for (const mode of [1, 2, 0] as const) {
        page.onLoopTap(tap({ value: String(mode) }));
        await sleep(900);
      }

      expect(sent, "没有可下发的方案时不该碰设备").toEqual([]);
      expect(session.deviceState!.flags, "设备状态不该被这次点击改动").toBe(before);
      expect(page.currentDraft().loop, "用户的选择要记进草稿，等划出分区再下发").toBe(0);
      expect(page.data.applyError, "要告诉用户为什么没下发").not.toBe("");
    } finally {
      await session.disconnect();
    }
  }, 120_000);
});

/**
 * #117：进阶档整条点击路径。
 *
 * 与上面同一份底座、同一套驱动方式，补的是「点出来的东西设备真的收到了吗」的
 * 其余几面：分区区间可读回、效果落成层类型、只改一条灯组不波及别条。
 *
 * 断言一律落在**外部可观察行为**上（页面派生的 data + 设备 State / QueryStrip），
 * 不看内部方法有没有被调用，也不看私有字段。
 */
describe("#117 进阶档点击路径", () => {

  it("切到进阶档后页面给出时间轴与循环三档", async () => {
    const { page, session } = await openPage();
    try {
      expect(page.data.mode, "默认是简单档").toBe("simple");
      page.onModeTap(tap({ mode: "advanced" }));
      await sleep(300);
      expect(page.data.mode).toBe("advanced");
      expect(Array.isArray(page.data.steps), "时间轴步骤要渲染出来").toBe(true);
      expect(page.data.steps.length).toBeGreaterThan(0);
      expect(page.data.loopChoices, "循环三档要在页面上").toHaveLength(3);
      expect(page.data.loopChoices.map((c: any) => c.label)).toEqual([
        "不循环",
        "全部循环",
        "最后一步循环",
      ]);
    } finally {
      await session.disconnect();
    }
  }, 120_000);

  it("加步骤只改本地编排，不动设备", async () => {
    const { page, session } = await openPage();
    try {
      page.onModeTap(tap({ mode: "advanced" }));
      await sleep(200);
      const stagesBefore = page.currentDraft().stages.length;
      const segCountsBefore = JSON.stringify(session.deviceState!.stripSegCounts);

      page.onStepAdd();
      await sleep(400);

      expect(page.currentDraft().stages.length, "草稿多一步").toBe(stagesBefore + 1);
      expect(JSON.stringify(session.deviceState!.stripSegCounts), "设备段数不该变").toBe(
        segCountsBefore,
      );
    } finally {
      await session.disconnect();
    }
  }, 120_000);

  it("划选分区并确定后，应用下发能从设备读回同一区间", async () => {
    const { page, session } = await openPage();
    const ledCount = session.deviceState!.stripCounts[0];
    const endCell = Math.min(9, ledCount - 1);
    try {
      page.onModeTap(tap({ mode: "advanced" }));
      await sleep(200);
      page.onZoneAdd();
      await sleep(200);
      expect(page.data.pickerOpen, "灯珠弹窗应当打开").toBe(true);

      page.onPickerCellTap(tap({ index: "0" }));
      await sleep(80);
      page.onPickerCellTap(tap({ index: String(endCell) }));
      await sleep(80);
      expect(page.data.pickerCanConfirm, "划选后应当允许确定").toBe(true);

      page.onPickerConfirm();
      await sleep(400);
      expect(page.data.pickerOpen).toBe(false);

      await page.applyAdvanced();
      await sleep(1500);
      /* 播放中设备按方案渲染，停播后才读得到静态分区。 */
      await session.setPlayback(0, 0);
      await sleep(500);

      const queried = await session.queryStrip(0);
      expect(queried.kind).toBe("ok");
      const reports = queried.kind === "ok" ? queried.reports : [];
      expect(
        reports.some((r: any) => r.start === 0 && r.end === endCell),
        `设备应能读回区间 0-${endCell}，实际 ${reports.map((r: any) => `${r.start}-${r.end}`).join(", ") || "无"}`,
      ).toBe(true);
    } finally {
      await session.disconnect();
    }
  }, 180_000);

  it("选效果后应用，设备读回该效果的层类型", async () => {
    const { page, session } = await openPage();
    try {
      page.onModeTap(tap({ mode: "advanced" }));
      await sleep(200);
      page.onZoneAdd();
      await sleep(200);
      page.onPickerCellTap(tap({ index: "0" }));
      await sleep(80);
      page.onPickerCellTap(tap({ index: "9" }));
      await sleep(80);
      page.onPickerConfirm();
      await sleep(400);

      const zones = page.currentZones();
      expect(zones.length, "前置：应有一个分区").toBeGreaterThan(0);
      page.onBubbleZoneTap(tap({ segId: String(zones[0].segId) }));
      await sleep(200);

      page.onPanelTypeTap(tap({ type: "breathing" }));
      await sleep(300);
      expect(page.panelMode).toBe("breathing");

      await page.applyAdvanced();
      await sleep(1500);
      await session.setPlayback(0, 0);
      await sleep(500);

      const queried = await session.queryStrip(0);
      expect(queried.kind).toBe("ok");
      const types = queried.kind === "ok" ? queried.reports.map((r: any) => r.layer0.type) : [];
      expect(types, "设备读回的第一层应当是呼吸 0x01").toContain(SEGMENT_TYPE.BREATHING);
    } finally {
      await session.disconnect();
    }
  }, 180_000);

  it("只编辑一条灯组并应用，其它灯组的分区与颜色逐字节不变（#123 不补齐）", async () => {
    const { page, session } = await openPage();
    try {
      /* 先给 strip 1 布一个静态段，模拟「别的灯组本来有配置」。 */
      await session.setSegment({
        stripId: 1,
        segId: 0,
        start: 0,
        end: 9,
        blend: 0,
        layer0: {
          type: SEGMENT_TYPE.STATIC,
          hue: 12000,
          sat: 255,
          periodMs: 0,
          p5: 0,
          flags: 0,
          level: 100,
        },
        layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
      });
      await sleep(400);

      const before = await session.queryStrip(1);
      expect(before.kind).toBe("ok");
      const beforeReports = before.kind === "ok" ? before.reports : [];
      expect(beforeReports.length, "前置：strip 1 应当有段").toBeGreaterThan(0);

      /* 用户只编辑当前灯组（strip 0）。 */
      page.onModeTap(tap({ mode: "advanced" }));
      await sleep(200);
      page.onZoneAdd();
      await sleep(200);
      page.onPickerCellTap(tap({ index: "0" }));
      await sleep(80);
      page.onPickerCellTap(tap({ index: "9" }));
      await sleep(80);
      page.onPickerConfirm();
      await sleep(300);
      await page.applyAdvanced();
      await sleep(1500);
      await session.setPlayback(0, 0);
      await sleep(500);

      const after = await session.queryStrip(1);
      expect(after.kind).toBe("ok");
      const afterReports = after.kind === "ok" ? after.reports : [];

      expect(afterReports.length, "strip 1 的分区数不该变").toBe(beforeReports.length);
      /* 逐字节：颜色与区间都不许被碰。 */
      const key = (r: any) => `${r.start}-${r.end}|${r.layer0.type},${r.layer0.hue},${r.layer0.sat}`;
      expect(afterReports.map(key)).toEqual(beforeReports.map(key));

      /*
       * #123 真正的判据：下发的方案里**只有**用户编辑过的那条灯组。
       *
       * 旧实现会先 QueryStrip 其它带、把结果补进每个阶段（`fillOtherStripSlices`），
       * 于是方案里出现 strip 1 的副本——那是**静态存储**里的陈旧内容，
       * 却把 strip 1 绑上了自己方案的时间轴，正是「别的带跟着一起停」的成因。
       *
       * 这一条断言挡住了「把补齐逻辑加回来」这种回归：只要方案里再出现
       * strip 1 的切片，它就是红的。
       */
      const uploaded = session.lastDownloadedScript;
      expect(uploaded, "应当记下这次下发的方案").not.toBeNull();
      const stripIds = new Set<number>();
      for (const stage of uploaded!.stages) {
        for (const segment of stage.segments) {
          stripIds.add(segment.stripId);
        }
      }
      expect(
        [...stripIds].sort(),
        "方案里只该有用户编辑过的 strip 0",
      ).toEqual([0]);
    } finally {
      await session.disconnect();
    }
  }, 180_000);
});

/*
 * #124：应用方案时「先传方案，再停播」。
 *
 * 旧顺序是「停播 → 写实时分区 → 上传 → 开播」。停播那一步让渲染源从当前
 * 阶段掉回静态存储，而上传要 21~75 帧——真机实测 14 帧用了 420ms
 * （30ms/帧），也就是 8.4 帧 @20fps 的画面错误窗口。
 *
 * 现在上传整体提到停播之前（ScriptBegin/Stage/Segment/Commit 只写 staging，
 * 本来就不影响画面），窗口压缩到「停播 → 开播」之间的一帧。
 *
 * 这里锁的是**命令顺序**——那正是窗口大小的唯一决定因素。
 */
describe("#124 应用方案：上传在停播之前", () => {
  it("ScriptCommit 先于 SetPlayback(stop)，且中间只隔一次 QueryStrip", async () => {
    const { page, session, transport } = await openPage();
    try {
      /* 先让设备处于播放态：只有「本来在播」才会走到停播这一步。 */
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
      await page.applyAdvanced();
      await sleep(1500);
      await session.setPlayback(1, 1);
      await sleep(400);

      const before = transport.log.snapshot().filter((e: any) => e.dir === "tx").length;

      await page.applyAdvanced();
      await sleep(2000);

      const tx = transport.log
        .snapshot()
        .slice(before)
        .filter((e: any) => e.dir === "tx");
      /* 载荷在 hex 里（"13 00" = SetPlayback stop）：首字节是命令，第二个是 action。 */
      const payloadByte = (e: any, index: number): number => {
        const bytes = String(e.hex).split(" ").map((x: string) => parseInt(x, 16));
        return bytes[index];
      };

      const commitAt = tx.findIndex((e: any) => e.command === CMD.SCRIPT_COMMIT);
      const stopAt = tx.findIndex(
        (e: any) => e.command === CMD.SET_PLAYBACK && payloadByte(e, 1) === 0,
      );
      const playAt = tx.findIndex(
        (e: any) => e.command === CMD.SET_PLAYBACK && payloadByte(e, 1) === 1,
      );

      expect(commitAt, "这次下发里应当有 ScriptCommit").toBeGreaterThanOrEqual(0);
      expect(stopAt, "播放中应用方案应当先停播").toBeGreaterThanOrEqual(0);
      expect(playAt, "最后应当开播").toBeGreaterThanOrEqual(0);

      expect(commitAt, "上传必须在停播之前（#124）").toBeLessThan(stopAt);
      /* 停播与开播之间只允许夹 QueryStrip + SetSegment（写回落画面），
       * 不允许再夹任何方案帧——那正是旧实现的错误窗口来源。 */
      const between = tx.slice(stopAt + 1, playAt);
      const scriptFramesBetween = between.filter((e: any) =>
        [CMD.SCRIPT_BEGIN, CMD.SCRIPT_STAGE, CMD.SCRIPT_SEGMENT, CMD.SCRIPT_COMMIT].includes(
          e.command,
        ),
      );
      expect(
        scriptFramesBetween.map((e: any) => e.command),
        "停播与开播之间不该再有方案帧",
      ).toEqual([]);
    } finally {
      await session.disconnect();
    }
  }, 180_000);
});

/*
 * #125：进阶档改任何东西都自动下发，没有「应用」按钮。
 *
 * **经真实控件触发**：这些用例调的是 `onPanelTypeTap` / `onPanelSliderChange` /
 * `onOverlayBlendTap` 这些事件处理器，不是绕过控件直接调 `applyAdvanced()`。
 * 旧用例正是直接调 `applyAdvanced()`，所以「控件根本没接上下发」这个缺陷
 * 一路绿着（#96 删掉按钮之后就这样活了很久）。
 */
describe("#125 进阶档：点一下就生效", () => {
  /** 划一个分区并选中它，让面板可用。 */
  async function readyZone(page: any) {
    page.onModeTap(tap({ mode: "advanced" }));
    await sleep(150);
    page.onZoneAdd();
    await sleep(150);
    page.onPickerCellTap(tap({ index: "0" }));
    await sleep(80);
    page.onPickerCellTap(tap({ index: "9" }));
    await sleep(80);
    page.onPickerConfirm();
    await sleep(1500);
    const zones = page.currentZones();
    page.onBubbleZoneTap(tap({ segId: String(zones[0].segId) }));
    await sleep(300);
  }

  it("点效果类型，设备读回的层类型随之改变（不需要任何额外操作）", async () => {
    const { page, session } = await openPage();
    try {
      await readyZone(page);

      page.onPanelTypeTap(tap({ type: "breathing" }));
      await sleep(1800);

      const q = await session.queryStrip(0);
      const types = q.kind === "ok" ? q.reports.map((r: any) => r.layer0.type) : [];
      expect(types, "点了「呼吸」之后设备上应当是 0x01").toContain(SEGMENT_TYPE.BREATHING);
    } finally {
      await session.disconnect();
    }
  }, 180_000);

  it("切换混合方式，设备读回的 blend 随之改变", async () => {
    const { page, session } = await openPage();
    try {
      await readyZone(page);
      /* 先给一个特效层，混合方式才有意义。 */
      page.onOverlayTypeTap(tap({ value: "comet" }));
      await sleep(1800);

      page.onOverlayBlendTap(tap({ value: 2 }));
      await sleep(1800);

      const q = await session.queryStrip(0);
      const blends = q.kind === "ok" ? q.reports.map((r: any) => r.blend) : [];
      expect(blends, "混合方式应当变成相加 0x02").toContain(2);
    } finally {
      await session.disconnect();
    }
  }, 180_000);

  it("滑块拖动过程中不写设备，松手才写（抓帧确认）", async () => {
    const { page, session, transport } = await openPage();
    try {
      await readyZone(page);

      const countTx = () =>
        transport.log.snapshot().filter((e: any) => e.dir === "tx").length;

      /* 拖动中：连发 5 次 changing，一帧都不该出去。 */
      const before = countTx();
      for (const value of [10, 30, 50, 70, 90]) {
        page.onPanelSliderChanging({
          currentTarget: { dataset: { key: "level" } },
          detail: { value },
        } as any);
        await sleep(60);
      }
      const during = countTx();
      expect(during - before, "拖动中不该有任何下发").toBe(0);

      /* 松手：应当下发。 */
      page.onPanelSliderChange({
        currentTarget: { dataset: { key: "level" } },
        detail: { value: 90 },
      } as any);
      await sleep(1800);
      expect(countTx() - during, "松手后应当真的下发").toBeGreaterThan(0);
    } finally {
      await session.disconnect();
    }
  }, 180_000);

  it("写入失败时页面顶部出现可读原因（applyError 有内容）", async () => {
    const { page } = await openPage();
    try {
      /* 空方案是本地就能判定的失败：不给分区就点效果类型，预检会拦住。 */
      page.onModeTap(tap({ mode: "advanced" }));
      await sleep(150);
      await page.applyAdvanced();
      await sleep(600);

      expect(page.data.applyError, "失败原因必须显示出来").not.toBe("");
      expect(page.data.applyError).not.toMatch(/0x[0-9A-F]{2}|InvalidParam/);
    } finally {
      /* 这个用例没有连设备，直接丢掉页面即可。 */
    }
  }, 60_000);
});
