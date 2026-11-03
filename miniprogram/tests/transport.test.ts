/**
 * 传输层的 v3 分片 / MTU / State 回落（#40）。
 *
 * 这一层是唯一接触 wx.* 的模块，所以测试里注入一个最小 wx 桩：
 *  - 记录每次 writeBLECharacteristicValue 的字节（= 一次分片）；
 *  - 能主动派发 notify（模拟设备的 TX 特征值）；
 *  - 能返回任意 State read 回值（模拟 MTU 23 下的短读）。
 *
 * 断言的是**线上字节**：分片头、分片数、以及 State 回落时真的发了 QueryState。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToCompactHex, hexToBytes } from "../utils/protocol/hex";
import { encodeFrame } from "../utils/protocol/frame";
import { chunkFrame } from "../utils/protocol/chunk";
import {
  CHUNK_FIRST,
  CHUNK_LAST,
  RX_UUID,
  SERVICE_UUID,
  STATE_UUID,
  TX_UUID,
} from "../utils/protocol/constants";
import { FrameLog } from "../utils/ble/log";
import { BleTransport, ConnectCancelledError } from "../utils/ble/transport";

const DEVICE_ID = "DEV-1";

const STATE_37 = hexToBytes(
  "0180FFB478C802FF00000003011E003C000000000000000000000000000204000000000000",
) as Uint8Array;

type Handler = (res: unknown) => void;

/**
 * 最小 wx 桩：够 BleTransport 的初始化流水线与读写路径跑起来。
 *
 * `mtuMode` 控制 MTU 协商结果：
 *  - "android-185"：setBLEMTU 成功返回 185；
 *  - "unknown"：setBLEMTU 失败且无 getBLEMTU；
 *  - "ios-247"：不调 setBLEMTU，getBLEMTU 返回 247（钳到 180）。
 */
class FakeWx {
  readonly writes: Uint8Array[] = [];
  /** 每次 readBLECharacteristicValue 调用的次数。 */
  readCalls = 0;
  /** 下一次 State read 的回值（默认 37 字节）。 */
  stateReadValue: Uint8Array = STATE_37;
  /** true 时 read 直接 fail（模拟平台拒绝）。 */
  failRead = false;
  mtuMode: "android-185" | "unknown" | "ios-247" = "android-185";

  private readonly valueHandlers: Handler[] = [];
  private readonly connectionHandlers: Handler[] = [];
  private readonly adapterHandlers: Handler[] = [];
  private readonly deviceFoundHandlers: Handler[] = [];

  onBluetoothDeviceFound(fn: Handler): void {
    this.deviceFoundHandlers.push(fn);
  }

  onBLECharacteristicValueChange(fn: Handler): void {
    this.valueHandlers.push(fn);
  }

  onBLEConnectionStateChange(fn: Handler): void {
    this.connectionHandlers.push(fn);
  }

  onBluetoothAdapterStateChange(fn: Handler): void {
    this.adapterHandlers.push(fn);
  }

  offBluetoothDeviceFound(): void {}
  offBLECharacteristicValueChange(): void {}
  offBLEConnectionStateChange(): void {}
  offBluetoothAdapterStateChange(): void {}

  openBluetoothAdapter(opts: any): void {
    /* 模拟热重载：适配器底层已打开，wx 回 fail already opened（无 errCode）。 */
    if (this.adapterAlreadyOpened) {
      opts.fail?.({
        errCode: undefined,
        errMsg: "openBluetoothAdapter: openBluetoothAdapter: fail already opened",
      });
      return;
    }
    opts.success?.({});
  }

  /** true 时 openBluetoothAdapter 回「已经打开」错误。 */
  adapterAlreadyOpened = false;

  closeBLEConnection(opts: any): void {
    opts.success?.({});
  }

  /*
   * 取消测试用：挂起 createBLEConnection，由用例手动放行，
   * 模拟 wx 那种无法中断的原子调用。
   * 注意必须用箭头函数属性——微信 API 是被裸引用传给 wxCall 的，普通方法会丢 this。
   */
  holdConnection = false;
  private heldConnection: any = null;

  createBLEConnection = (opts: any): void => {
    if (this.holdConnection) {
      this.heldConnection = opts;
      return;
    }
    opts.success?.({});
  };

  /** 放行被挂起的 createBLEConnection（模拟底层调用最终跑完）。 */
  releaseConnection(ok = true): void {
    const opts = this.heldConnection;
    this.heldConnection = null;
    if (opts === null) {
      return;
    }
    if (ok) {
      opts.success?.({});
    } else {
      opts.fail?.({ errCode: 10003, errMsg: "mock connect failure" });
    }
  }

  getBLEDeviceServices(opts: any): void {
    opts.success?.({ services: [{ uuid: SERVICE_UUID }] });
  }

  getBLEDeviceCharacteristics(opts: any): void {
    opts.success?.({
      characteristics: [
        { uuid: RX_UUID, properties: { writeNoResponse: true } },
        { uuid: TX_UUID, properties: { notify: true } },
        { uuid: STATE_UUID, properties: { read: true } },
      ],
    });
  }

  notifyBLECharacteristicValueChange(opts: any): void {
    opts.success?.({});
  }

  /*
   * 下面三个用箭头函数属性：微信 API 是**被裸引用**传给 wxCall 的
   * （`wx.writeBLECharacteristicValue` 不带 this），普通方法会丢 `this`。
   */
  setBLEMTU = (opts: any): void => {
    if (this.mtuMode === "android-185") {
      opts.success?.({ mtu: 185 });
    } else {
      opts.fail?.({ errCode: 10008, errMsg: "mock" });
    }
  };

  getBLEMTU = (opts: any): void => {
    if (this.mtuMode === "ios-247") {
      opts.success?.({ mtu: 247 });
    } else {
      opts.fail?.({ errCode: 10008, errMsg: "mock" });
    }
  };

  readBLECharacteristicValue = (opts: any): void => {
    this.readCalls += 1;
    const value = this.stateReadValue;
    if (this.failRead) {
      /* 模拟平台直接拒绝 read（MTU 23 放不下 37 字节时可能这样）。 */
      opts.fail?.({ errCode: 10008, errMsg: "mock read failure" });
      return;
    }
    opts.success?.({});
    /* read 的 success 只代表受理：真正的值走 value 事件。 */
    queueMicrotask(() => {
      this.emitValue({ deviceId: DEVICE_ID, characteristicId: STATE_UUID, value: value.slice().buffer });
    });
  };

  writeBLECharacteristicValue = (opts: any): void => {
    const view = new Uint8Array(opts.value as ArrayBuffer);
    this.writes.push(view.slice());
    opts.success?.({});
  };

  stopBluetoothDevicesDiscovery(opts: any): void {
    opts.success?.({});
  }

  startBluetoothDevicesDiscovery(opts: any): void {
    opts.success?.({});
  }

  /** 派发一个 TX notify（一个分片）。 */
  emitChunk(bytes: Uint8Array): void {
    this.emitValue({ deviceId: DEVICE_ID, characteristicId: TX_UUID, value: bytes.slice().buffer });
  }

  /** 派发一条完整逻辑帧（自动分片）。 */
  emitFrame(frame: Uint8Array): void {
    for (const chunk of chunkFrame(frame, 20)) {
      this.emitChunk(chunk);
    }
  }

  /** 派发一条「一条命令 + 一条 ACK」的响应。 */
  ack(command: number, seq: number, resultCode = 0): void {
    this.emitFrame(encodeFrame(0x80, seq, new Uint8Array([command, resultCode])));
  }

  private emitValue(res: unknown): void {
    for (const fn of this.valueHandlers.slice()) {
      fn(res);
    }
  }
}

let fakeWx: FakeWx;

function makeTransport(
  platform: "android" | "ios" | "other" = "android",
  ackTimeoutMs = 200,
): BleTransport {
  return new BleTransport({
    log: new FrameLog(),
    platform,
    initSettleMs: 0,
    ackTimeoutMs,
    stateReadTimeoutMs: 200,
  });
}

/**
 * 让微任务 / 0ms 定时器跑完。
 *
 * connect 的流水线是一条长 await 链（MTU → services → chars → notify →
 * delay(0) → read），每一跳都要一个 tick，所以循环若干轮，而不是只等一次。
 */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  fakeWx = new FakeWx();
  (globalThis as unknown as { wx: FakeWx }).wx = fakeWx;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { wx?: FakeWx }).wx;
});

describe("MTU 与分片容量", () => {
  it("Android 协商 185 → 容量 180（一帧一次写）", async () => {
    const transport = makeTransport("android");
    await transport.connect(DEVICE_ID);
    expect(transport.negotiatedMtu).toBe(185);
    expect(transport.chunkCapacityBytes).toBe(180);
  });

  it("MTU 未知 → 按 23（容量 20），功能不降级", async () => {
    fakeWx.mtuMode = "unknown";
    const transport = makeTransport("android");
    const state = await transport.connect(DEVICE_ID);
    expect(transport.negotiatedMtu).toBeNull();
    expect(transport.chunkCapacityBytes).toBe(20);
    /* State 仍然拿到了（37 字节 read 成功）。 */
    expect(state.ledCount).toBe(30);
  });

  it("iOS 用系统协商值（247 被钳到 180）", async () => {
    fakeWx.mtuMode = "ios-247";
    const transport = makeTransport("ios");
    await transport.connect(DEVICE_ID);
    expect(transport.negotiatedMtu).toBe(247);
    expect(transport.chunkCapacityBytes).toBe(180);
  });

  it("MTU 未知时大帧真的分片写出（每条都带 ctrl 头）", async () => {
    fakeWx.mtuMode = "unknown";
    const transport = makeTransport("android");
    await transport.connect(DEVICE_ID);
    fakeWx.writes.length = 0;

    /* 21 字节段 → 29 字节帧 → cap 20 → 2 片。 */
    const payload = hexToBytes("0000000900000000FF0000000064FF0000000000000000") as Uint8Array;
    const pending = transport.sendAndWaitAck({ command: 0x10, payload });
    await settle();
    expect(fakeWx.writes).toHaveLength(2);
    expect(fakeWx.writes[0][0]).toBe(CHUNK_FIRST);
    expect(fakeWx.writes[1][0]).toBe(CHUNK_LAST | 1);
    /* 剥掉 ctrl 头拼起来正好是逻辑帧。 */
    const reassembled = [...fakeWx.writes[0].slice(1), ...fakeWx.writes[1].slice(1)];
    const frame = encodeFrame(0x10, 1, payload);
    expect(reassembled).toEqual(Array.from(frame));

    fakeWx.ack(0x10, 1, 0x00);
    await pending;
  });

  it("正常 MTU 下同一帧只写一次，ctrl = 0xC0", async () => {
    const transport = makeTransport("android");
    await transport.connect(DEVICE_ID);
    fakeWx.writes.length = 0;

    const payload = hexToBytes("0000000900000000FF0000000064FF0000000000000000") as Uint8Array;
    const pending = transport.sendAndWaitAck({ command: 0x10, payload });
    await settle();
    expect(fakeWx.writes).toHaveLength(1);
    expect(fakeWx.writes[0][0]).toBe(CHUNK_FIRST | CHUNK_LAST);

    fakeWx.ack(0x10, 1, 0x00);
    await pending;
  });
});

describe("入站分片重组", () => {
  it("跨 3 片的 StateReport 能被重组并分发", async () => {
    fakeWx.mtuMode = "unknown";
    const transport = makeTransport("android");
    await transport.connect(DEVICE_ID);

    const states: number[] = [];
    transport.onState((state) => states.push(state.ledCount));

    const stateFrame = encodeFrame(0x82, 9, STATE_37);
    for (const chunk of chunkFrame(stateFrame, 20)) {
      fakeWx.emitChunk(chunk);
    }
    expect(states).toEqual([30]);
  });
});

describe("State read 回落（37 字节读不出来时走 QueryState）", () => {
  it("read 返回 14 字节 → 发 QueryState 0x05，用 0x82 的载荷作为 State", async () => {
    const transport = makeTransport("android");
    /* 第一次 connect 的 read 走短读，回落路径要能拿到 0x82。 */
    fakeWx.stateReadValue = new Uint8Array(14);
    const connectPromise = transport.connect(DEVICE_ID);
    await settle();

    /* 回落写入的应当是 QueryState（0x05）。 */
    const query = fakeWx.writes.find((bytes) => {
      const frame = bytes.slice(1);
      return frame.length >= 3 && frame[2] === 0x05;
    });
    expect(query).toBeDefined();

    /* 取 QueryState 的 seq（逻辑帧 byte 3）。 */
    const seq = query!.slice(1)[3];
    fakeWx.ack(0x05, seq, 0x00);
    fakeWx.emitFrame(encodeFrame(0x82, seq, STATE_37));

    const state = await connectPromise;
    expect(state.ledCount).toBe(30);
    expect(state.stripCount).toBe(2);
  });

  it("read 直接失败也回落到 QueryState", async () => {
    const transport = makeTransport("android");
    fakeWx.failRead = true;
    const connectPromise = transport.connect(DEVICE_ID);
    await settle();

    const query = fakeWx.writes.find((bytes) => bytes.slice(1)[2] === 0x05);
    expect(query).toBeDefined();
    const seq = query!.slice(1)[3];
    fakeWx.ack(0x05, seq, 0x00);
    fakeWx.emitFrame(encodeFrame(0x82, seq, STATE_37));

    await expect(connectPromise).resolves.toMatchObject({ brightness: 128 });
  });

  it("read 返回 37 字节时**不**发 QueryState", async () => {
    const transport = makeTransport("android");
    await transport.connect(DEVICE_ID);
    const anyQueryState = fakeWx.writes.some((bytes) => bytes.slice(1)[2] === 0x05);
    expect(anyQueryState).toBe(false);
  });
});

describe("v3 单帧查询（QueryStripConfig / QueryDeviceInfo）", () => {
  it("0x1C → 0x87：解析 8 路引脚分配", async () => {
    const transport = makeTransport("android");
    await transport.connect(DEVICE_ID);
    fakeWx.writes.length = 0;

    const pending = transport.queryStripConfig();
    await settle();
    expect(fakeWx.writes).toHaveLength(1);
    const seq = fakeWx.writes[0].slice(1)[3];

    fakeWx.ack(0x1c, seq, 0x00);
    const payload = hexToBytes("000301010A0102000103FF0004FF0005FF0006FF0007FF00") as Uint8Array;
    fakeWx.emitFrame(encodeFrame(0x87, seq, payload));

    const config = await pending;
    expect(config.channels[0].gpio).toBe(3);
    expect(config.channels[0].assigned).toBe(true);
    expect(config.channels[2].gpio).toBe(0);
    expect(config.channels[7].gpio).toBe(0xff);
  });

  it("0x1D → 0x88：解析设备信息", async () => {
    const transport = makeTransport("android");
    await transport.connect(DEVICE_ID);
    fakeWx.writes.length = 0;

    const pending = transport.queryDeviceInfo();
    await settle();
    const seq = fakeWx.writes[0].slice(1)[3];

    fakeWx.ack(0x1d, seq, 0x00);
    const payload = hexToBytes("0300AABBCCDDEEFF40080808040100") as Uint8Array;
    fakeWx.emitFrame(encodeFrame(0x88, seq, payload));

    const info = await pending;
    expect(info.hwId).toBe("AA:BB:CC:DD:EE:FF");
    expect(info.firmwareVersion).toBe(0x0300);
    expect(info.supportsTwoLayers).toBe(true);
  });

  it("ACK 被拒时立即失败，不悬挂等待者", async () => {
    const transport = makeTransport("android");
    await transport.connect(DEVICE_ID);
    fakeWx.writes.length = 0;

    const pending = transport.queryDeviceInfo();
    await settle();
    const seq = fakeWx.writes[0].slice(1)[3];
    fakeWx.ack(0x1d, seq, 0x01);

    await expect(pending).rejects.toThrow(/QueryDeviceInfo 失败/);
  });
});

describe("ACK 超时按分片数放大", () => {
  it("多分片帧的 ACK 可以晚于基础超时（不会误判超时）", async () => {
    fakeWx.mtuMode = "unknown"; /* cap 20 */
    /* 基础 400ms；两分片 → 400 + 120 = 520ms（留足调度余量）。 */
    const transport = makeTransport("android", 400);
    await transport.connect(DEVICE_ID);
    fakeWx.writes.length = 0;

    const payload = new Uint8Array(23); /* 31 字节帧 → 2 片 */
    const startedAt = Date.now();
    const pending = transport.sendAndWaitAck({ command: 0x16, payload });
    await settle();
    expect(fakeWx.writes).toHaveLength(2);
    const seq = fakeWx.writes[0].slice(1)[3];

    /* 等到「已过基础 400ms + 50ms」再回 ACK：单分片帧此时必定已超时。 */
    const target = startedAt + 450;
    while (Date.now() < target) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fakeWx.ack(0x16, seq, 0x00);

    const ack = await pending;
    expect(ack.ok).toBe(true);
    expect(ack.seq).toBe(seq);
  });

  it("单分片帧仍然用基础超时（不被放大）", async () => {
    /* 基础 120ms：单分片帧必须在 ~120ms 左右超时，不能等 240ms。 */
    const transport = makeTransport("android", 120);
    await transport.connect(DEVICE_ID);

    const pending = transport.sendAndWaitAck({ command: 0x01, payload: new Uint8Array([1]) });
    const start = Date.now();
    await expect(pending).rejects.toBeTruthy();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    /* 明显小于「两分片」的 240ms。 */
    expect(elapsed).toBeLessThan(230);
  });
});

describe("断线清理", () => {
  it("disconnect 后 MTU 容量回到默认 20，未完成分片被清空", async () => {
    const transport = makeTransport("android");
    await transport.connect(DEVICE_ID);
    expect(transport.chunkCapacityBytes).toBe(180);

    await transport.disconnect();
    expect(transport.chunkCapacityBytes).toBe(20);
    expect(transport.negotiatedMtu).toBeNull();
  });
});

/**
 * 适配器「已经打开」不是失败。
 *
 * 真实现场：开发者工具热重载后 `adapterOpened` 随新实例重置为 false，
 * 而底层适配器还开着，wx 回 `fail already opened`（且没有 errCode）。
 * 早期把它当失败处理并把 `scanRequested` 清掉，用户看到的现象就是
 * 「点扫描永远没反应」。
 */
describe("适配器已打开（already opened）", () => {
  it("不当成失败：链路回到 idle，扫描能继续", async () => {
    fakeWx.adapterAlreadyOpened = true;
    const transport = makeTransport("android");

    const states: string[] = [];
    transport.onLink((state) => states.push(state));

    await expect(transport.startScan()).resolves.toBeUndefined();
    expect(transport.linkState).toBe("scanning");
    expect(states).not.toContain("failed");
  });

  it("already opened 之后仍能正常连接", async () => {
    fakeWx.adapterAlreadyOpened = true;
    const transport = makeTransport("android");

    const state = await transport.connect(DEVICE_ID);
    expect(transport.linkState).toBe("ready");
    expect(state.ledCount).toBe(30);
  });
});

/**
 * 取消连接（状态条上的「取消」）。
 *
 * 背景：`createBLEConnection` / GATT 发现是 wx 的原子调用，**没有中断接口**。
 * 早期实现的「取消」只是文案——`onStatusTap` 对 connecting 直接 return，
 * 用户点了什么也不会发生。现在的做法是让这次尝试作废（代次号），
 * 底层调用跑完后静默退出，不覆盖用户意图。
 *
 * 这些用例锁的就是「取消之后状态不许被幽灵连接翻掉」。
 */
describe("取消连接", () => {
  it("连接中被取消：链路回到 idle，不显示错误", async () => {
    fakeWx.holdConnection = true;
    const transport = makeTransport("android");

    const states: string[] = [];
    transport.onLink((state) => states.push(state));

    const pending = transport.connect(DEVICE_ID);
    await settle(3);
    expect(transport.linkState).toBe("connecting");

    expect(transport.cancelConnect()).toBe(true);
    expect(transport.linkState).toBe("idle");

    /* 底层调用最终失败也不能把已取消的连接翻成 failed。 */
    fakeWx.releaseConnection(false);
    await expect(pending).rejects.toBeInstanceOf(ConnectCancelledError);
    await settle(3);
    expect(transport.linkState).toBe("idle");
    expect(states).not.toContain("failed");
  });

  it("底层连接最终成功，也绝不会把已取消的状态翻成 ready", async () => {
    fakeWx.holdConnection = true;
    const transport = makeTransport("android");

    const pending = transport.connect(DEVICE_ID);
    await settle(3);
    expect(transport.linkState).toBe("connecting");

    expect(transport.cancelConnect()).toBe(true);

    /* 关键路径：createBLEConnection 成功返回，流水线必须发现代次已变。 */
    fakeWx.releaseConnection(true);
    await expect(pending).rejects.toBeInstanceOf(ConnectCancelledError);
    await settle(10);
    expect(transport.linkState).toBe("idle");
    /* 取消后不应继续走 MTU 协商 / GATT 发现。 */
    expect(transport.negotiatedMtu).toBeNull();
  });

  it("不在连接中时取消是空操作（不误改 ready / scanning 状态）", async () => {
    const transport = makeTransport("android");
    await transport.connect(DEVICE_ID);
    expect(transport.linkState).toBe("ready");

    expect(transport.cancelConnect()).toBe(false);
    expect(transport.linkState).toBe("ready");
  });

  it("取消后可以立刻重新连接，且新连接不受旧尝试影响", async () => {
    fakeWx.holdConnection = true;
    const transport = makeTransport("android");

    const first = transport.connect(DEVICE_ID);
    await settle(3);
    transport.cancelConnect();

    /* 放行旧尝试（它会成功），但结果必须被丢弃。 */
    fakeWx.releaseConnection(true);
    await expect(first).rejects.toBeInstanceOf(ConnectCancelledError);

    /* 第二次连接正常完成。 */
    fakeWx.holdConnection = false;
    const state = await transport.connect(DEVICE_ID);
    expect(transport.linkState).toBe("ready");
    expect(state.ledCount).toBe(30);
  });
});
