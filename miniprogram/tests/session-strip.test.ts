/**
 * #41 会话层：灯带维度必须是**显式参数**，activeStripId 只是会话自己记住的
 * 当前选择（App 级单例里跨 tab 保存）。
 *
 * #41 之后 `clearSegment` / `queryStrip` 不再有「缺省 strip 0」的行为：
 * 页面必须传它正在展示的那条带，否则用户在第 3 条带上删段会删到第 0 条带。
 */

import { describe, expect, it } from "vitest";

import { ControlSession } from "../utils/control/session";
import type { BleTransport } from "../utils/ble/transport";
import type {
  AckResult,
  CommandRequest,
  DeviceInfo,
  DeviceState,
  LinkState,
  SegmentListEnd,
  SegmentReport,
  StripConfig,
} from "../utils/protocol/types";
import { EMPTY_EFFECT } from "../utils/protocol/types";
import { baseState } from "./helpers/state";

/** strip 1 / seg 2 / [0-9] / 静态红。 */
const REPORT_STATIC: SegmentReport = {
  stripId: 1,
  segId: 2,
  start: 0,
  end: 9,
  blend: 0,
  layer0: { type: 0, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0 },
  layer1: { ...EMPTY_EFFECT },
  type: 0,
  hue: 0,
  sat: 255,
  periodMs: 0,
  p5: 0,
  flags: 0,
};

class FakeTransport {
  linkState: LinkState = "ready";
  writes: CommandRequest[] = [];
  stripQueries: number[] = [];
  reports: SegmentReport[] = [REPORT_STATIC];
  end: SegmentListEnd = { stripId: 1, segMask: 0b100 };
  stripConfigReads = 0;
  deviceInfoReads = 0;
  failConfig = false;

  private readonly linkListeners: Array<(state: LinkState, detail?: unknown) => void> = [];
  private readonly stateListeners: Array<(state: DeviceState) => void> = [];

  onLink(fn: (state: LinkState, detail?: unknown) => void): () => void {
    this.linkListeners.push(fn);
    return () => undefined;
  }

  onState(fn: (state: DeviceState) => void): () => void {
    this.stateListeners.push(fn);
    return () => undefined;
  }

  emitLink(state: LinkState): void {
    this.linkState = state;
    for (const fn of this.linkListeners.slice()) fn(state);
  }

  emitState(state: DeviceState): void {
    for (const fn of this.stateListeners.slice()) fn(state);
  }

  sendAndWaitAck(req: CommandRequest): Promise<AckResult> {
    this.writes.push(req);
    return Promise.resolve({ seq: 1, command: req.command, resultCode: 0, ok: true });
  }

  readState(): Promise<DeviceState> {
    return Promise.resolve(baseState());
  }

  async queryStrip(stripId: number): Promise<{ reports: SegmentReport[]; end: SegmentListEnd }> {
    this.stripQueries.push(stripId);
    return { reports: this.reports, end: { ...this.end, stripId } };
  }

  /* 回连重建（§9.1 步骤 2/3）用的两条只读查询。 */
  async queryStripConfig(): Promise<StripConfig> {
    this.stripConfigReads += 1;
    if (this.failConfig) {
      throw new Error("引脚表读取失败");
    }
    return {
      channels: Array.from({ length: 8 }, (_, id) => ({
        stripId: id,
        gpio: 0xff,
        flags: 0,
        assigned: false,
      })),
    };
  }

  async queryDeviceInfo(): Promise<DeviceInfo> {
    this.deviceInfoReads += 1;
    if (this.failConfig) {
      throw new Error("设备信息读取失败");
    }
    return {
      firmwareVersion: 0x0300,
      firmwareMajor: 3,
      firmwareMinor: 0,
      hwId: "AA:BB:CC:DD:EE:FF",
      maxLeds: 64,
      maxStrips: 8,
      maxSegments: 8,
      maxStages: 8,
      maxScripts: 4,
      caps: 0,
      supportsTwoLayers: false,
      fadeImplemented: false,
    };
  }

  async disconnect(): Promise<void> {
    this.linkState = "idle";
  }
}

function makeSession(transport: FakeTransport): ControlSession {
  return new ControlSession({
    platform: "other",
    devMode: false,
    transportOverride: transport as unknown as BleTransport,
  });
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe("#41 stripId 是必填参数", () => {
  it("clearSegment(stripId, segId) 用调用方给的带，不跟随 activeStripId", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    session.setActiveStripId(0);

    const ack = await session.clearSegment(3, 5);
    expect(ack.ok).toBe(true);
    expect(Array.from(transport.writes[0].payload)).toEqual([3, 5]);
    /* 只是发命令：不该偷偷改会话的当前选择。 */
    expect(session.activeStripId).toBe(0);
  });

  it("queryStrip(stripId) 读调用方给的带，并缓存该带的段列表", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);

    const result = await session.queryStrip(1);
    expect(result.kind).toBe("ok");
    expect(transport.stripQueries).toEqual([1]);
    expect(session.segmentsOf(1)).toEqual(transport.reports);
    /* 没读过的带不能编出数据。 */
    expect(session.segmentsOf(0)).toEqual([]);
    expect(session.segmentsOf(2)).toEqual([]);
  });

  it("断线清空逐带段缓存（描述的是上一台 / 上一次连接）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.queryStrip(0);
    expect(session.segmentsOf(0)).toHaveLength(1);

    transport.emitLink("idle");
    await session.disconnect();
    expect(session.segmentsOf(0)).toEqual([]);
  });

  it("activeStripId 是会话自有状态：断线重连不重置（用户的选择跨连接保留）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    session.setActiveStripId(2);

    transport.emitLink("idle");
    transport.emitLink("ready");

    expect(session.activeStripId).toBe(2);
  });

  it("setActiveStripId 越界抛 RangeError（不静默夹住）", () => {
    const session = makeSession(new FakeTransport());
    expect(() => session.setActiveStripId(8)).toThrow(RangeError);
    expect(() => session.setActiveStripId(-1)).toThrow(RangeError);
  });
});

describe("#41 连接后重建（protocol-v3 §9.1）", () => {
  it("ready 时补 QueryStripConfig 与 QueryDeviceInfo（State 已由连接流水线读过）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    expect(transport.stripConfigReads).toBe(0);
    expect(transport.deviceInfoReads).toBe(0);

    transport.emitLink("ready");
    await settle();

    expect(transport.stripConfigReads).toBe(1);
    expect(transport.deviceInfoReads).toBe(1);
    expect(session.stripConfigs).not.toBeNull();
    expect(session.deviceInfo?.hwId).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("两条查询失败不改变链路状态（界面增强信息，不能降级成连接失败）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    transport.failConfig = true;

    transport.emitLink("ready");
    await settle();

    expect(session.linkState).toBe("ready");
    expect(session.stripConfigs).toBeNull();
    expect(session.deviceInfo).toBeNull();
  });

  it("onDeviceConfig 在读完（成功或失败）后各触发一次，页面据此重画 GPIO", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    let calls = 0;
    const off = session.onDeviceConfig(() => {
      calls += 1;
    });

    transport.emitLink("ready");
    await settle();
    expect(calls).toBe(1);

    /* 失败也要通知：页面据此把「GPIO ?」收敛成「—」。 */
    transport.failConfig = true;
    transport.emitLink("idle");
    transport.emitLink("ready");
    await settle();
    expect(calls).toBe(2);

    off();
    transport.emitLink("idle");
    transport.emitLink("ready");
    await settle();
    expect(calls).toBe(2);
  });
});
