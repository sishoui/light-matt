/**
 * #40 会话层的 v3 表面：逐带开关 / 引脚表 / 设备身份 / 逐带灯珠数。
 *
 * 页面在 #41 才会用这些 API，但 #40 必须先交付并锁住语义：
 *  - `setStripPower` 只改掩码位，不动全局 power（§9.5）；
 *  - `queryStripConfig` / `queryDeviceInfo` 是设备权威，断开必须清缓存；
 *  - `currentLedCounts` 直接来自 State 的逐带字段，不再沿用 strip 0。
 */

import { describe, expect, it } from "vitest";

import { ControlSession } from "../utils/control/session";
import type { BleTransport } from "../utils/ble/transport";
import {
  parseDeviceInfoReport,
  parseStripConfigReport,
} from "../utils/protocol/commands";
import type {
  AckResult,
  CommandRequest,
  DeviceInfo,
  DeviceState,
  LinkState,
  StripConfig,
} from "../utils/protocol/types";
import { hexToBytes } from "../utils/protocol/hex";
import { baseState } from "./helpers/state";

const STRIP_CONFIG = parseStripConfigReport(
  hexToBytes("000301010A0102000103FF0004FF0005FF0006FF0007FF00") as Uint8Array,
);
const DEVICE_INFO = parseDeviceInfoReport(
  hexToBytes("0300AABBCCDDEEFF40080808040100") as Uint8Array,
);

/** 只实现本票用到的成员。 */
class FakeTransport {
  linkState: LinkState = "ready";
  writes: CommandRequest[] = [];
  stripConfigResult: StripConfig = STRIP_CONFIG;
  deviceInfoResult: DeviceInfo = DEVICE_INFO;
  failStripConfig = false;
  failDeviceInfo = false;
  /** 取消连接：测试控制是否真的取消了一次进行中的尝试。 */
  cancelConnectResult = false;
  cancelConnectCalls = 0;

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

  emitState(state: DeviceState): void {
    for (const fn of this.stateListeners.slice()) fn(state);
  }

  cancelConnect(): boolean {
    this.cancelConnectCalls += 1;
    if (this.cancelConnectResult) {
      this.linkState = "idle";
    }
    return this.cancelConnectResult;
  }

  sendAndWaitAck(req: CommandRequest): Promise<AckResult> {
    this.writes.push(req);
    return Promise.resolve({ seq: 1, command: req.command, resultCode: 0, ok: true });
  }

  readState(): Promise<DeviceState> {
    return Promise.resolve(baseState());
  }

  async disconnect(): Promise<void> {
    this.linkState = "idle";
  }

  async queryStripConfig(): Promise<StripConfig> {
    if (this.failStripConfig) {
      throw new Error("引脚表读取失败");
    }
    return this.stripConfigResult;
  }

  async queryDeviceInfo(): Promise<DeviceInfo> {
    if (this.failDeviceInfo) {
      throw new Error("设备信息读取失败");
    }
    return this.deviceInfoResult;
  }
}

function makeSession(transport: FakeTransport): ControlSession {
  return new ControlSession({
    platform: "other",
    devMode: false,
    transportOverride: transport as unknown as BleTransport,
  });
}

describe("#40 session.setStripPower", () => {
  it("发 0x1B 且只改该带掩码位，不动全局 power", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    /* strip 0 开、strip 1 关。 */
    transport.emitState(baseState({ stripPowerMask: 0x01 }));

    const result = await session.setStripPower(1, true);
    expect(result.kind).toBe("ok");
    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0].command).toBe(0x1b);
    expect(Array.from(transport.writes[0].payload)).toEqual([1, 1]);

    expect(session.stripPower(1)).toBe(true);
    expect(session.stripPower(0)).toBe(true);
    expect(result.kind === "ok" && result.state.power).toBe(1);
    expect(result.kind === "ok" && result.state.stripPowerMask).toBe(0x03);

    /* 关另一条：只清那一位。 */
    await session.setStripPower(0, false);
    expect(session.deviceState?.stripPowerMask).toBe(0x02);
    expect(session.deviceState?.power).toBe(1);
  });

  it("灯带号越界 / 未连接时明确报错且不发帧", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);

    expect((await session.setStripPower(8, true)).kind).toBe("error");
    expect(transport.writes).toHaveLength(0);

    transport.linkState = "idle";
    expect((await session.setStripPower(0, true)).kind).toBe("error");
    expect(transport.writes).toHaveLength(0);
  });
});

describe("#40 session.queryStripConfig / queryDeviceInfo", () => {
  it("成功时缓存并在 getter 暴露（返回副本，外部改不进去）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);

    const config = await session.queryStripConfig();
    expect(config.kind).toBe("ok");
    expect(session.stripConfigs?.channels[0].gpio).toBe(3);

    const snapshot = session.stripConfigs!;
    snapshot.channels[0].gpio = 99;
    expect(session.stripConfigs?.channels[0].gpio).toBe(3);

    const info = await session.queryDeviceInfo();
    expect(info.kind).toBe("ok");
    expect(session.deviceInfo?.hwId).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("读取失败时返回 error，且不清掉上一次的好值", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.queryStripConfig();
    expect(session.stripConfigs).not.toBeNull();

    transport.failStripConfig = true;
    const failed = await session.queryStripConfig();
    expect(failed.kind).toBe("error");
    /* 旧值保留：一次读失败不该让 UI 突然丢掉已经拿到的 GPIO。 */
    expect(session.stripConfigs?.channels[0].gpio).toBe(3);
  });

  it("未连接时直接返回 error，不发帧", async () => {
    const transport = new FakeTransport();
    transport.linkState = "idle";
    const session = makeSession(transport);
    expect((await session.queryStripConfig()).kind).toBe("error");
    expect((await session.queryDeviceInfo()).kind).toBe("error");
  });

  it("断开连接清空两份缓存（描述的是上一台设备）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.queryStripConfig();
    await session.queryDeviceInfo();
    expect(session.stripConfigs).not.toBeNull();
    expect(session.deviceInfo).not.toBeNull();

    await session.disconnect();
    expect(session.stripConfigs).toBeNull();
    expect(session.deviceInfo).toBeNull();
  });
});

describe("#40 currentLedCounts 来自 State 的逐带字段", () => {
  it("多灯带返回真实值（不再沿用 strip 0）", () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    transport.emitState(
      baseState({
        stripCount: 3,
        stripCounts: [30, 45, 60, 0, 0, 0, 0, 0],
        stripSegCounts: [1, 2, 3, 0, 0, 0, 0, 0],
      }),
    );
    expect(session.currentLedCounts()).toEqual([30, 45, 60]);
  });

  it("未连接时返回空数组（剧本校验据此跳过上界检查）", () => {
    const session = makeSession(new FakeTransport());
    expect(session.currentLedCounts()).toEqual([]);
  });

  it("按 strip_count 截断到实际条数", () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    transport.emitState(
      baseState({ stripCount: 1, stripCounts: [12, 34, 0, 0, 0, 0, 0, 0] }),
    );
    expect(session.currentLedCounts()).toEqual([12]);
  });
});

describe("#40 activeStripId 接缝（#41 的灯带切换器入口）", () => {
  it("#41 起 stripId 必填（不再缺省跟随 activeStripId）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    transport.emitState(baseState({ stripCount: 2, stripCounts: [30, 40, 0, 0, 0, 0, 0, 0] }));
    expect(session.activeStripId).toBe(0);

    session.setActiveStripId(1);
    expect(session.activeStripId).toBe(1);
    expect(session.stripLedCount(1)).toBe(40);

    /* 显式传带号：发的是 [strip 1, seg 3]。缺省参数会在改签名时变成编译错误，
     * 运行期拿 undefined 也会被命令构造器的校验挡住——两条防线都在。 */
    await session.clearSegment(1, 3);
    expect(Array.from(transport.writes[0].payload)).toEqual([1, 3]);
  });

  it("灯带号越界抛错（不静默夹住）", () => {
    const session = makeSession(new FakeTransport());
    expect(() => session.setActiveStripId(8)).toThrow(RangeError);
    expect(() => session.setActiveStripId(-1)).toThrow(RangeError);
  });
});

describe("#40 setLedCount 维护逐带灯珠数", () => {
  it("改 strip 0 同时更新派生 ledCount", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    transport.emitState(baseState({ ledCount: 30 }));

    const result = await session.setLedCount(60);
    expect(result.kind).toBe("ok");
    expect(transport.writes[0].command).toBe(0x06);
    expect(Array.from(transport.writes[0].payload)).toEqual([0x00, 0x3c, 0x00]);
    expect(session.deviceState?.ledCount).toBe(60);
    expect(session.stripLedCount(0)).toBe(60);
  });

  it("改 strip 2 只更新该带，派生 ledCount 不变", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    transport.emitState(
      baseState({ stripCount: 3, stripCounts: [30, 40, 50, 0, 0, 0, 0, 0] }),
    );

    const result = await session.setLedCount(55, 2);
    expect(result.kind).toBe("ok");
    expect(Array.from(transport.writes[0].payload)).toEqual([0x02, 0x37, 0x00]);
    expect(session.stripLedCount(2)).toBe(55);
    expect(session.deviceState?.ledCount).toBe(30);
  });
});

/**
 * 状态条上的「取消」：早期是假按钮——文案写了「取消」，`onStatusTap`
 * 对 connecting 却直接 return。现在会话层提供 `cancelConnect`，
 * 由页面在任何时候都能真正中断。
 */
describe("取消连接（会话层）", () => {
  it("取消成功时同时清掉切换状态机", () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    transport.cancelConnectResult = true;

    expect(session.cancelConnect()).toBe(true);
    expect(transport.cancelConnectCalls).toBe(1);
    /* 没有残留的切换目标：下次打开设备页不该看到「重试切换」。 */
    expect(session.deviceSwitch.target).toBeNull();
  });

  it("没有进行中的尝试时返回 false，不误清切换状态", () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    transport.cancelConnectResult = false;

    expect(session.cancelConnect()).toBe(false);
    expect(session.deviceSwitch.target).toBeNull();
  });
});
