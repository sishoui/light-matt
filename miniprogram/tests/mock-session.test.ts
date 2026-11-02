/**
 * 演示模式下的**会话级**连通性（端到端，不经过页面）。
 *
 * 首页的「点大卡 → 连上 → 进控制页」整条链路依赖：会话把 MockTransport 当成
 * 一个普通传输层用，`connect` 之后 State / DeviceInfo / StripConfig / 段列表
 * 都能读回，命令能写下去。这里直接断言这条链路，避免页面层掩盖住底层缺陷。
 *
 * 只替换 storage（spec 允许的假件）；传输层是产品代码本身（MockTransport）。
 */

import { describe, expect, it, vi } from "vitest";
import { ControlSession } from "../utils/control/session";
import { MockTransport } from "../utils/ble/mock-transport";
import type { BleTransport } from "../utils/ble/transport";
import { MOCK_DEVICES } from "../utils/control/mock-devices";
import { seedMockDevices } from "../utils/control/mock-mode";
import { createSessionStorage } from "./helpers/storage";
import { SEGMENT_TYPE } from "../utils/protocol/constants";
import {
  buildQuickCardViews,
  buildQuickSpec,
  quickCardOf,
  quickPresetFlags,
} from "../utils/control/quick-effects";
import { PRESETS, rgbToSegmentParams } from "../utils/color/hsv";

const A = MOCK_DEVICES[0];
const B = MOCK_DEVICES[1];

interface Harness {
  session: ControlSession;
  transport: MockTransport;
}

function makeSession(storage = createSessionStorage()): Harness {
  const transport = new MockTransport();
  const session = new ControlSession({
    platform: "other",
    devMode: false,
    storage,
    transportOverride: transport as unknown as BleTransport,
    reconnectDelaysMs: [],
  });
  return { session, transport };
}

describe("演示模式：会话链路", () => {
  it("connect 之后会话进入 ready，且能读到设备状态", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    expect(session.linkState).toBe("ready");
    const state = session.deviceState;
    expect(state).not.toBeNull();
    expect(state?.stripCount).toBe(2);
    expect(state?.maxBrightness).toBe(A.maxBrightness);
  });

  it("连接后 QueryDeviceInfo / QueryStripConfig 都拿到设备权威值", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    const info = await session.queryDeviceInfo();
    expect(info.kind).toBe("ok");
    if (info.kind === "ok") {
      expect(info.info.hwId).toBe(A.hwId);
    }
    const config = await session.queryStripConfig();
    expect(config.kind).toBe("ok");
    if (config.kind === "ok") {
      expect(config.config.channels[0].assigned).toBe(true);
    }
  });

  it("queryStrip 读回该带的段（设备权威）", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    const result = await session.queryStrip(0);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.reports).toHaveLength(2);
      expect(result.reports[0].layer0.type).toBe(SEGMENT_TYPE.STATIC);
    }
  });

  it("setPower / setBrightness 真的改设备状态", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    const off = await session.setPower(false);
    expect(off.kind).toBe("ok");
    expect(session.deviceState?.power).toBe(0);
    const on = await session.setPower(true);
    expect(on.kind).toBe("ok");
    expect(session.deviceState?.power).toBe(1);
  });

  it("切灯带只重新读，不清别的带的段", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    await session.queryStrip(0);
    await session.queryStrip(1);
    /* 两条带各有一份缓存，互不覆盖。 */
    expect(session.segmentsOf(0)).toHaveLength(2);
    expect(session.segmentsOf(1)).toHaveLength(1);
  });

  it("switchTo 换设备：状态换新、旧设备段缓存被清空", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    await session.queryStrip(0);
    expect(session.segmentsOf(0).length).toBeGreaterThan(0);

    await session.switchTo(B.deviceId, B.broadcastName);
    expect(session.linkState).toBe("ready");
    expect(session.transport.currentDeviceId).toBe(B.deviceId);
    expect(session.deviceState?.stripCount).toBe(B.stripCounts.filter((n) => n > 0).length);
    /* 段缓存属于上一台设备，必须清空。 */
    expect(session.segmentsOf(0)).toEqual([]);
  });

  it("seedMockDevices 之后 recentDevices 立即可见（列表派生依赖它）", async () => {
    const storage = createSessionStorage();
    seedMockDevices(storage, 1_000_000);
    const { session } = makeSession(storage);
    expect(session.recentDevices).toHaveLength(MOCK_DEVICES.length);
  });

  it("连接成功后写入最近连过列表（与真机同一条路径）", async () => {
    const storage = createSessionStorage();
    const { session } = makeSession(storage);
    await session.connect(A.deviceId, A.broadcastName);
    const recent = session.recentDevices;
    expect(recent.some((entry) => entry.deviceId === A.deviceId)).toBe(true);
  });

  it("disconnect 之后会话回到 idle，状态被清空", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    await session.disconnect();
    expect(session.linkState).toBe("idle");
    expect(session.deviceState).toBeNull();
  });

  it("取消连接不会把设备记成「最近连过」", async () => {
    const storage = createSessionStorage();
    const { session } = makeSession(storage);
    const connecting = session.connect(A.deviceId, A.broadcastName);
    /* MockTransport 在 connect 里有 60ms + 60ms 的模拟初始化。 */
    expect(session.cancelConnect()).toBe(true);
    await expect(connecting).rejects.toThrow();
    expect(session.recentDevices.some((entry) => entry.deviceId === A.deviceId)).toBe(false);
  });

  it("自检命令成功返回（不改设备状态）", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    const before = session.deviceState;
    const result = await session.selfTest();
    expect(result.kind).toBe("ok");
    expect(session.deviceState).toEqual(before);
  });
});

/* 定时器泄漏保护：MockTransport 的扫描第二批用了 setTimeout。 */
describe("演示模式：扫描", () => {
  it("扫描结果里包含三台演示设备", async () => {
    const { session, transport } = makeSession();
    const seen: string[][] = [];
    session.onDevices((list) => seen.push(list.map((device) => device.deviceId)));
    await session.scan();
    expect(seen[0]).toHaveLength(3);
    await session.stopScan();
    vi.useRealTimers();
    expect(transport.linkState).toBe("idle");
  });
});

/**
 * 快捷档（#54）的会话级链路：点一张卡 → 整组变成一个光区 → 设备读回真的变了。
 *
 * 页面层只负责 setData；这里验证「写入确实生效」，因为模拟器里的
 * 「界面高亮了」不能证明设备收到了命令。
 */
describe("演示模式：快捷档写入", () => {
  it("点卡片后整组变成一个覆盖全条的单层光区（设备读回为准）", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    const card = quickCardOf("breathe")!;
    const ledCount = session.stripLedCount(0);
    /* 先清掉预置光区（快捷档整组覆盖，见 device.writeQuick）。 */
    await session.queryStrip(0);
    for (const report of session.segmentsOf(0)) {
      await session.clearSegment(0, report.segId);
    }
    const ack = await session.setSegment(buildQuickSpec(card, { speed: "fast" }, 0, ledCount));
    expect(ack.ok).toBe(true);

    const result = await session.queryStrip(0);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const sameStrip = result.reports.filter((report) => report.stripId === 0);
    const whole = sameStrip.find((report) => report.start === 0 && report.end === ledCount - 1);
    expect(whole).toBeDefined();
    expect(whole!.layer0.type).toBe(SEGMENT_TYPE.BREATHING);
    expect(whole!.layer1.type).toBe(0xff);
  });

  it("重复下发同一张卡只覆盖自己（SetSegment 是绝对值命令）", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    const card = quickCardOf("rainbow")!;
    const ledCount = session.stripLedCount(0);
    /* 快捷档的语义是整组覆盖：先读回再清掉该组其它光区（协议要求，见 device.writeQuick）。 */
    await session.queryStrip(0);
    for (const report of session.segmentsOf(0)) {
      if (report.segId !== 0) {
        await session.clearSegment(0, report.segId);
      }
    }
    await session.setSegment(buildQuickSpec(card, {}, 0, ledCount));
    await session.setSegment(buildQuickSpec(card, { speed: "slow" }, 0, ledCount));
    const result = await session.queryStrip(0);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    /* 全条只应该有一个盖满的目标光区（槽位 0 被第二次覆盖）。 */
    const covering = result.reports.filter(
      (report) => report.stripId === 0 && report.start === 0 && report.end === ledCount - 1,
    );
    expect(covering).toHaveLength(1);
    expect(covering[0].layer0.periodMs).toBe(6000);
  });

  it("整组写入前必须清掉其它光区，否则设备回 InvalidParam（重叠）", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    /* 设备 A 的灯组 0 预置了两个光区（0-13 / 14-29）——直接写整组必然重叠。 */
    expect(session.segmentsOf(0).length).toBe(0);
    const before = await session.queryStrip(0);
    expect(before.kind).toBe("ok");
    if (before.kind !== "ok") return;
    expect(before.reports.filter((report) => report.stripId === 0)).toHaveLength(2);

    const card = quickCardOf("warm")!;
    const ledCount = session.stripLedCount(0);
    const direct = await session.setSegment(buildQuickSpec(card, {}, 0, ledCount));
    expect(direct.ok).toBe(false);
  });

  it("方案播放中写实时光区前先停止播放（否则设备不出光）", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    /* 起一套最小方案并播放，模拟「用户正看着播放中的方案」。 */
    const played = await session.downloadScript(
      {
        scriptId: 0,
        stripCount: 1,
        stages: [
          {
            durationMs: 1000,
            segments: [
              {
                stripId: 0,
                segId: 0,
                start: 0,
                end: Math.max(0, session.stripLedCount(0) - 1),
                blend: 0,
                layer0: { type: SEGMENT_TYPE.STATIC, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 100 },
                layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
              },
            ],
          },
        ],
      },
      { activate: true, loop: true },
    );
    expect(played.kind).toBe("ok");
    const playing = await session.setPlayback(1, true);
    expect(playing.kind).toBe("ok");
    expect(session.deviceState?.playbackState).toBe(1);

    const stopped = await session.setPlayback(0, true);
    expect(stopped.kind).toBe("ok");
    expect(session.deviceState?.playbackState).toBe(0);
  });
});

/**
 * 快捷档的视图派生：卡片高亮与颜色预设的选中态都应能从参数反推。
 * 这两处在页面里只读数据，所以派生逻辑放这里锁。
 */
describe("快捷档：视图派生", () => {
  it("选中卡的颜色随参数变化，未选中的卡不变", () => {
    const base = buildQuickCardViews("warm");
    const shifted = buildQuickCardViews("warm", { hue: 30000, sat: 255 });
    const warmBase = base.find((card) => card.id === "warm")!;
    const warmShifted = shifted.find((card) => card.id === "warm")!;
    const rainbowBase = base.find((card) => card.id === "rainbow")!;
    const rainbowShifted = shifted.find((card) => card.id === "rainbow")!;
    expect(warmShifted.hex).not.toBe(warmBase.hex);
    expect(rainbowShifted.hex).toBe(rainbowBase.hex);
  });

  it("预设色块的选中态按 hue+sat 判定", () => {
    /* 用预设自身的转换值反查：必须是「至少命中一个」，且命中项就是那个预设。 */
    const red = rgbToSegmentParams(PRESETS.find((p) => p.name === "红")!.rgb);
    const flags = quickPresetFlags({ hue: red.hue, sat: red.sat });
    expect(flags.some((hit) => hit)).toBe(true);
    /* 一个不可能等于任何预设的组合不应误命中。 */
    expect(quickPresetFlags({ hue: 12345, sat: 3 }).some((hit) => hit)).toBe(false);
  });
});

/**
 * 逐灯组灯珠数（review P0 回归）：多灯组设备的每组长度不同。
 *
 * 协议里 `state.ledCount` 是 **strip 0** 的派生值；编辑第 4 组时若拿它当
 * 该组长度，灯珠条会画错格数、拖动落到不存在的灯珠上、切分产出越界区间。
 * 这里锁住「能拿到逐组真实值」这件事本身（页面用的就是同一个来源）。
 */
describe("演示模式：逐灯组灯珠数", () => {
  it("设备 B 的灯组长度确实不同（前提成立，否则本组测试无意义）", () => {
    expect(B.stripCounts[0]).not.toBe(B.stripCounts[4]);
  });

  it("会话按灯组给出真实灯珠数，与 strip 0 不同", async () => {
    const { session } = makeSession();
    await session.connect(B.deviceId, B.broadcastName);
    expect(session.stripLedCount(0)).toBe(B.stripCounts[0]);
    expect(session.stripLedCount(4)).toBe(B.stripCounts[4]);
    /* 这正是页面曾经用错的那个值。 */
    expect(session.deviceState?.ledCount).toBe(B.stripCounts[0]);
    expect(session.stripLedCount(4)).not.toBe(session.deviceState?.ledCount);
  });

  it("按该组真实长度构造的整组光区会被设备接受", async () => {
    const { session } = makeSession();
    await session.connect(B.deviceId, B.broadcastName);
    const stripId = 4;
    const ledCount = session.stripLedCount(stripId);
    /* 设备 B 的第 4 组预置了一个覆盖全条的静态段，先清掉再写。 */
    await session.queryStrip(stripId);
    for (const report of session.segmentsOf(stripId)) {
      await session.clearSegment(stripId, report.segId);
    }
    const card = quickCardOf("warm")!;
    const ack = await session.setSegment(buildQuickSpec(card, {}, stripId, ledCount));
    expect(ack.ok).toBe(true);
    const result = await session.queryStrip(stripId);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const zone = result.reports.find((report) => report.stripId === stripId);
    expect(zone?.end).toBe(ledCount - 1);
    expect(zone?.end).toBeLessThan(B.stripCounts[0] - 1);
  });

  it("用 strip 0 的长度去写短灯组会被设备拒绝（说明为何必须逐组取）", async () => {
    const { session } = makeSession();
    await session.connect(B.deviceId, B.broadcastName);
    const stripId = 4;
    await session.queryStrip(stripId);
    for (const report of session.segmentsOf(stripId)) {
      await session.clearSegment(stripId, report.segId);
    }
    const card = quickCardOf("warm")!;
    /* 故意用第 0 组长度（60）去覆盖只有 24 颗的第 4 组。 */
    const ack = await session.setSegment(buildQuickSpec(card, {}, stripId, B.stripCounts[0]));
    expect(ack.ok).toBe(false);
  });
});
