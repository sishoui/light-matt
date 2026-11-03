/**
 * #48 数据丢失回归：改色 / 预设 / 节流通道必须保留段的第二层与 blend。
 *
 * 缺陷现场：灯光页的快捷改色与预设走的是「扁平草稿重建整段」的旧路径
 * （`staticSegment` → `toSpec`），`toSpec` 固定 `layer1 = 空层`、`blend = 覆盖`。
 * 用户配好的「彩虹 × 呼吸（相乘）」在点一下颜色后就被静默降级成单层。
 *
 * 本文件的断言一律是**字节级**的：比 `layer1` 的字段更严格，也覆盖 blend
 * 字节与区间。期望值直接取自 docs/protocol-testvectors-v4.json 的
 * `set_segment_rainbow_plus_breathing_multiply`（21 字节两层定宽）。
 *
 * 只替换传输通道与计时器（spec 允许的两个假件），不 mock 协议字节。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { ControlSession } from "../utils/control/session";
import { buildSegmentRows } from "../utils/control/segment-view";
import { bytesToCompactHex, hexToBytes } from "../utils/protocol/hex";
import { parseSegmentReport } from "../utils/protocol/commands";
import { segmentHueSatToRgb } from "../utils/color/hsv";
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
import { baseState } from "./helpers/state";

interface VectorCase {
  name: string;
  command?: number;
  seq?: number;
  payload_hex?: string;
  frame_hex: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("../../docs/protocol-testvectors-v4.json", import.meta.url), "utf8"),
) as { cases: VectorCase[] };

function vectorHex(name: string): string {
  const found = vectors.cases.find((c) => c.name === name);
  expect(found, name).toBeDefined();
  return (found as VectorCase).payload_hex as string;
}

/** 设备上的两层段：彩虹 × 呼吸、相乘（strip 0 / seg 3 / 0-63）。 */
const TWO_LAYER_HEX = vectorHex("set_segment_rainbow_plus_breathing_multiply");
const TWO_LAYER: SegmentReport = parseSegmentReport(hexToBytes(TWO_LAYER_HEX) as Uint8Array);

/** 单层静态段（strip 0 / seg 1 / 10-20 / 纯绿）。 */
const SINGLE_LAYER: SegmentReport = parseSegmentReport(
  hexToBytes("00010A1400005555FF0000000064FF0000000000000000") as Uint8Array,
);

const TWO_LAYER_TARGET = { stripId: 0, segId: 3, start: 0, end: 63 };
const SINGLE_LAYER_TARGET = { stripId: 0, segId: 1, start: 10, end: 20 };

function fakeClock() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const timerApi = {
    setTimeout: (fn: () => void, ms: number) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, fn });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number);
    },
  };

  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      let due: { handle: number; at: number; fn: () => void } | null = null;
      for (const [handle, entry] of timers) {
        if (entry.at <= target && (due === null || entry.at < due.at)) {
          due = { handle, at: entry.at, fn: entry.fn };
        }
      }
      if (due === null) {
        break;
      }
      timers.delete(due.handle);
      now = due.at;
      due.fn();
    }
    now = target;
  };

  return { timerApi, advance };
}

class FakeTransport {
  linkState: LinkState = "ready";
  /** 设备权威的段列表（queryStrip 的返回）。 */
  reports: SegmentReport[] = [];
  /** 每次 queryStrip 的 stripId（断言「没有已读回 spec 时先读回」）。 */
  stripQueries: number[] = [];
  failQuery = false;
  /** 离散命令（sendAndWaitAck）。 */
  acks: CommandRequest[] = [];
  /** 节流通道的裸写（transport.write）。 */
  writes: CommandRequest[] = [];

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
    for (const fn of this.stateListeners.slice()) {
      fn(state);
    }
  }

  async queryStrip(stripId: number): Promise<{ reports: SegmentReport[]; end: SegmentListEnd }> {
    this.stripQueries.push(stripId);
    if (this.failQuery) {
      throw new Error("读回超时");
    }
    return {
      reports: this.reports.map((report) => ({ ...report })),
      end: { stripId, segMask: 0xff },
    };
  }

  sendAndWaitAck(req: CommandRequest): Promise<AckResult> {
    this.acks.push(req);
    return Promise.resolve({ seq: 1, command: req.command, resultCode: 0, ok: true });
  }

  async write(req: CommandRequest): Promise<{ seq: number }> {
    this.writes.push(req);
    return { seq: 1 };
  }

  readState(): Promise<DeviceState> {
    return Promise.resolve(baseState());
  }

  async queryStripConfig(): Promise<StripConfig> {
    return {
      channels: Array.from({ length: 8 }, (_, stripId) => ({
        stripId,
        gpio: 0xff,
        flags: 0,
        assigned: false,
      })),
    };
  }

  async queryDeviceInfo(): Promise<DeviceInfo> {
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

interface Harness {
  session: ControlSession;
  transport: FakeTransport;
  clock: ReturnType<typeof fakeClock>;
}

function makeSession(): Harness {
  const clock = fakeClock();
  const transport = new FakeTransport();
  vi.spyOn(Date, "now").mockImplementation(() => 0);
  const session = new ControlSession({
    platform: "other",
    devMode: false,
    transportOverride: transport as unknown as BleTransport,
    throttleTimer: clock.timerApi,
  });
  return { session, transport, clock };
}

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

/** 21 字节载荷的 layer1 区（偏移 13 起 8 字节）。 */
/** v4：段头 5 字节 + layer0 9 字节 → layer1 从偏移 14 起。 */
function layer1Hex(payload: Uint8Array): string {
  return bytesToCompactHex(payload.slice(14));
}

describe("#48 改色保留第二层与 blend（字节级）", () => {
  it("复现：两层段改色后 layer1 / blend / layer0 灯效参数都不变", async () => {
    const { session, transport } = makeSession();
    transport.reports = [TWO_LAYER];
    /* 灯光页已经读回过这条带：改色必须基于这份 spec。 */
    await session.queryStrip(0);
    transport.acks.length = 0;

    const result = await session.setSegmentColor(TWO_LAYER_TARGET, { r: 0, g: 255, b: 0 });
    expect(result.kind).toBe("ok");
    expect(transport.acks).toHaveLength(1);

    const payload = transport.acks[0].payload;
    expect(bytesToCompactHex(payload)).toBe("0003003F01025555FFA00FFF006401000000DC05140064");
    /* blend = 相乘，layer1 原样（不是空层）。 */
    expect(payload[4]).toBe(1);
    expect(layer1Hex(payload)).toBe(layer1Hex(hexToBytes(TWO_LAYER_HEX) as Uint8Array));
    /* 只改 hue/sat：layer0 仍是彩虹、周期与 span 不变。 */
    expect(payload[5]).toBe(2);
    expect(bytesToCompactHex(payload.slice(9, 13))).toBe("A00FFF00");
  });

  it("预设同样保留两层与 blend", async () => {
    const { session, transport } = makeSession();
    transport.reports = [TWO_LAYER];
    await session.queryStrip(0);
    transport.acks.length = 0;
    session.setActiveSegment(TWO_LAYER_TARGET);

    const result = await session.applyPreset({ r: 0, g: 0, b: 255 });
    expect(result.kind).toBe("ok");
    expect(transport.acks).toHaveLength(1);
    const payload = transport.acks[0].payload;
    expect(payload[4]).toBe(1);
    expect(layer1Hex(payload)).toBe(layer1Hex(hexToBytes(TWO_LAYER_HEX) as Uint8Array));
    /* 蓝色 hue = 240° → 0xAAAB，线上按小端写 → 字节 AB AA，sat = 255。 */
    expect(bytesToCompactHex(payload.slice(6, 9))).toBe("ABAAFF");
  });

  it("节流通道（连续拖动）同样保留两层与 blend", async () => {
    const { session, transport, clock } = makeSession();
    transport.reports = [TWO_LAYER];
    await session.queryStrip(0);
    transport.writes.length = 0;

    session.commitColor({ r: 0, g: 255, b: 0 }, TWO_LAYER_TARGET);
    clock.advance(200);
    await settle();

    expect(transport.writes).toHaveLength(1);
    const payload = transport.writes[0].payload;
    expect(payload[4]).toBe(1);
    expect(layer1Hex(payload)).toBe(layer1Hex(hexToBytes(TWO_LAYER_HEX) as Uint8Array));
    expect(bytesToCompactHex(payload.slice(6, 9))).toBe("5555FF");
  });

  it("单层段改色保持 layer1 空、blend 覆盖（不做无谓改动）", async () => {
    const { session, transport } = makeSession();
    transport.reports = [SINGLE_LAYER];
    await session.queryStrip(0);

    const result = await session.setSegmentColor(SINGLE_LAYER_TARGET, { r: 255, g: 0, b: 0 });
    expect(result.kind).toBe("ok");
    const payload = transport.acks[0].payload;
    expect(payload[4]).toBe(0);
    expect(layer1Hex(payload)).toBe("FF0000000000000000");
    expect(bytesToCompactHex(payload.slice(6, 9))).toBe("0000FF");
  });
});

describe("#48 没有已读回 spec 时先 QueryStrip", () => {
  it("本地无缓存：改色前先读回，再基于读回的 spec 下发", async () => {
    const { session, transport, clock } = makeSession();
    transport.reports = [TWO_LAYER];

    session.commitColor({ r: 0, g: 255, b: 0 }, TWO_LAYER_TARGET);
    clock.advance(200);
    await settle();

    expect(transport.stripQueries).toEqual([0]);
    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0].payload[4]).toBe(1);
    expect(layer1Hex(transport.writes[0].payload)).toBe(
      layer1Hex(hexToBytes(TWO_LAYER_HEX) as Uint8Array),
    );
  });

  it("预设路径同样先读回（离散命令）", async () => {
    const { session, transport } = makeSession();
    transport.reports = [TWO_LAYER];

    const result = await session.applyPreset({ r: 255, g: 0, b: 0 }, TWO_LAYER_TARGET);
    expect(result.kind).toBe("ok");
    expect(transport.stripQueries).toEqual([0]);
    expect(transport.acks).toHaveLength(1);
    expect(transport.acks[0].payload[4]).toBe(1);
  });

  it("读回失败：返回明确错误且不下发任何段命令", async () => {
    const { session, transport } = makeSession();
    transport.failQuery = true;

    const result = await session.applyPreset({ r: 255, g: 0, b: 0 }, TWO_LAYER_TARGET);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("读取段配置失败");
    expect(transport.acks).toHaveLength(0);
    expect(transport.writes).toHaveLength(0);
  });

  it("读回成功但设备上没有该段：不下发", async () => {
    const { session, transport } = makeSession();
    transport.reports = [SINGLE_LAYER];

    const result = await session.setSegmentColor(TWO_LAYER_TARGET, { r: 255, g: 0, b: 0 });
    expect(result.kind).toBe("error");
    expect(transport.acks).toHaveLength(0);
  });

  it("节流通道读回失败：给提示且不下发（同一句提示不重复刷屏）", async () => {
    const { session, transport, clock } = makeSession();
    transport.failQuery = true;
    const hints: string[] = [];
    session.onSegmentHint((message) => hints.push(message));

    session.commitColor({ r: 255, g: 0, b: 0 }, TWO_LAYER_TARGET);
    clock.advance(200);
    await settle();
    expect(transport.writes).toHaveLength(0);
    expect(hints).toHaveLength(1);

    /* 第二次同样的失败：提示已展示过，不再重复。 */
    session.commitColor({ r: 0, g: 255, b: 0 }, TWO_LAYER_TARGET);
    clock.advance(200);
    await settle();
    expect(transport.writes).toHaveLength(0);
    expect(hints).toHaveLength(1);
  });
});

describe("#48 灯光页段列表能区分单层 / 两层", () => {
  it("两层段带徽标标记，单层段不带", () => {
    const rows = buildSegmentRows([TWO_LAYER, SINGLE_LAYER], null, segmentHueSatToRgb);
    expect(rows.find((row) => row.segId === TWO_LAYER.segId)?.twoLayer).toBe(true);
    expect(rows.find((row) => row.segId === SINGLE_LAYER.segId)?.twoLayer).toBe(false);
    expect(rows.find((row) => row.segId === TWO_LAYER.segId)?.layerText).toBe("双层");
    expect(rows.find((row) => row.segId === SINGLE_LAYER.segId)?.layerText).toBe("");
  });

  it("呼吸段（走独立分支）也带两层标记", () => {
    const breathing = { ...TWO_LAYER, type: 1 };
    const rows = buildSegmentRows([breathing], null, segmentHueSatToRgb);
    expect(rows[0].twoLayer).toBe(true);
    expect(rows[0].layerText).toBe("双层");
  });
});

describe("#48 读回与缓存的边界", () => {
  it("缓存里的区间与目标不符时重新 QueryStrip（不拿旧槽位改色）", async () => {
    const { session, transport } = makeSession();
    /* 本地缓存里 seg 3 是 [0-63]，但用户选中的目标说 [0-31]（槽位已被重配）。 */
    transport.reports = [TWO_LAYER];
    await session.queryStrip(0);
    transport.stripQueries.length = 0;

    /* 设备现在的权威数据已经变了：区间 0-31 的两层段。 */
    transport.reports = [
      { ...TWO_LAYER, start: 0, end: 31 },
    ];
    const result = await session.setSegmentColor(
      { stripId: 0, segId: 3, start: 0, end: 31 },
      { r: 0, g: 255, b: 0 },
    );
    expect(result.kind).toBe("ok");
    expect(transport.stripQueries).toEqual([0]);
    const payload = transport.acks[0].payload;
    expect(payload[3]).toBe(31);
    expect(payload[4]).toBe(1);
  });

  it("改色成功后本地镜像同步 hue/sat，下一次拖动不再读回", async () => {
    const { session, transport, clock } = makeSession();
    transport.reports = [TWO_LAYER];
    await session.queryStrip(0);
    transport.stripQueries.length = 0;

    session.commitColor({ r: 0, g: 255, b: 0 }, TWO_LAYER_TARGET);
    clock.advance(200);
    await settle();
    expect(transport.stripQueries).toEqual([]);

    session.commitColor({ r: 255, g: 0, b: 0 }, TWO_LAYER_TARGET);
    clock.advance(200);
    await settle();
    expect(transport.stripQueries).toEqual([]);
    expect(transport.writes).toHaveLength(2);
    /* 第二帧的 layer1 / blend 仍然在，且 hue 已按第二帧更新。 */
    const last = transport.writes[1].payload;
    expect(last[4]).toBe(1);
    expect(layer1Hex(last)).toBe(layer1Hex(hexToBytes(TWO_LAYER_HEX) as Uint8Array));
    expect(bytesToCompactHex(last.slice(6, 9))).toBe("0000FF");
    /* 缓存里的扁平投影也更新了（#41 之前的读法）。 */
    expect(session.segmentsOf(0).find((r) => r.segId === 3)?.hue).toBe(0);
  });

  it("读回失败后恢复：成功一帧会清掉「已提示过」标记", async () => {
    const { session, transport, clock } = makeSession();
    const hints: string[] = [];
    session.onSegmentHint((m) => hints.push(m));
    transport.failQuery = true;

    session.commitColor({ r: 255, g: 0, b: 0 }, TWO_LAYER_TARGET);
    clock.advance(200);
    await settle();
    expect(hints).toHaveLength(1);

    /* 链路恢复：这一帧应成功下发，并把提示标记清掉。 */
    transport.failQuery = false;
    transport.reports = [TWO_LAYER];
    session.commitColor({ r: 0, g: 255, b: 0 }, TWO_LAYER_TARGET);
    clock.advance(200);
    await settle();
    expect(transport.writes).toHaveLength(1);

    /* 再次失败：同一句提示要能重新说一次（否则用户以为它一直没坏）。
     * 先让缓存里没有这个槽位（清段会把该格从镜像里摘掉），才会再走读回。 */
    await session.clearSegment(0, TWO_LAYER_TARGET.segId);
    transport.failQuery = true;
    session.commitColor({ r: 255, g: 0, b: 0 }, TWO_LAYER_TARGET);
    clock.advance(200);
    await settle();
    expect(hints).toHaveLength(2);
  });

  it("断线后已读回的 spec 作废：下次改色要重新读，读不到就不下发", async () => {
    const { session, transport, clock } = makeSession();
    transport.reports = [TWO_LAYER];
    await session.queryStrip(0);

    await session.disconnect();
    expect(session.segmentsOf(0)).toEqual([]);

    transport.linkState = "ready";
    transport.failQuery = true;
    session.commitColor({ r: 0, g: 255, b: 0 }, TWO_LAYER_TARGET);
    clock.advance(200);
    await settle();
    expect(transport.writes).toHaveLength(0);
  });

  it("onSegmentHint 取消订阅后不再收到提示", async () => {
    const { session, transport, clock } = makeSession();
    const hints: string[] = [];
    const off = session.onSegmentHint((m) => hints.push(m));
    off();
    transport.failQuery = true;

    session.commitColor({ r: 255, g: 0, b: 0 }, TWO_LAYER_TARGET);
    clock.advance(200);
    await settle();
    expect(hints).toHaveLength(0);
    expect(transport.writes).toHaveLength(0);
  });
});
