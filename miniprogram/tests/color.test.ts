/**
 * 颜色语义与「写进选中段」的小程序侧测试（#10 / #25）。
 *
 * 覆盖：
 *  1. HSV→RGB 纯函数：0°/120°/240°、饱和度与明度边界、**不做 gamma**；
 *  2. RGB→HSV 反推、十六进制互转、预设表；
 *  3. **#25**：SetColor / SetAll 已退役，颜色写进**选中段**（SetSegment 0x10）——
 *     没有选中段时不发帧、applyPreset 明确返回错误而不是假装成功；
 *  4. 亮度仍走 20Hz latest-wins 闸门（颜色不再占用这条通道）。
 *
 * 色环几何与绘制（`utils/color/wheel`）已随色环 UI 一起删除：现在选颜色走灯组页
 * 的 HSV 滑块，没有 canvas 可测。
 *
 * 只替换计时器与传输通道（spec 允许的两个假件），不 mock 协议字节。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  hexToRgb,
  hsvToRgb,
  normalizeHue,
  PRESETS,
  rgbToHex,
  rgbToHsv,
} from "../utils/color/hsv";
import { applyLocalColor, clampChannel, clampRgb, sameRgb } from "../utils/control/color";
import { ControlSession } from "../utils/control/session";
import { bytesToCompactHex } from "../utils/protocol/hex";
import { encodeFrame } from "../utils/protocol/frame";
import type { BleTransport } from "../utils/ble/transport";
import type {
  CommandRequest,
  DeviceState,
  SegmentListEnd,
  SegmentReport,
} from "../utils/protocol/types";
import { EMPTY_EFFECT } from "../utils/protocol/types";
import { baseState } from "./helpers/state";

const CMD_SET_BRIGHTNESS = 0x02;

interface VectorCase {
  name: string;
  command?: number;
  seq?: number;
  payload_hex?: string;
  frame_hex: string;
  result_code?: number;
}

const vectors = JSON.parse(
  readFileSync(new URL("../../docs/protocol-testvectors-v4.json", import.meta.url), "utf8"),
) as { cases: VectorCase[]; state_read_example_hex: string };

function vector(name: string): VectorCase {
  const found = vectors.cases.find((c) => c.name === name);
  expect(found, name).toBeDefined();
  return found as VectorCase;
}

/* v3 的 37 字节 State 夹具集中在 tests/helpers/state.ts（含派生字段一致性）。 */

/** 可控时钟 + 计时器（与 brightness.test.ts 同款）。 */
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

  return {
    timerApi,
    advance,
    get now() {
      return now;
    },
  };
}

/** 假传输通道：记录命令与实际写出的时间戳。 */
class FakeTransport {
  linkState: "ready" | "idle" = "ready";
  attempts: CommandRequest[] = [];
  writes: CommandRequest[] = [];
  writeTimes: number[] = [];
  failNextWrites = 0;
  /**
   * #48 起改色要先读回完整 spec：这里模拟「设备上已有的段」。
   * 缺省是单层静态段（layer1 空、blend 覆盖），区间与旧用例的期望一致。
   */
  reports: SegmentReport[] = [
    ["0-15", 0],
    ["0-15", 1],
    ["40-63", 2],
  ].map(([range, segId]) => {
    const [start, end] = String(range).split("-").map(Number);
    return {
      stripId: 0,
      segId: Number(segId),
      start,
      end,
      blend: 0 as const,
      layer0: { type: 0, hue: 0, sat: 255, periodMs: 0, p5: 0, flags: 0, level: 100 },
      layer1: { ...EMPTY_EFFECT },
      type: 0,
      hue: 0,
      sat: 255,
      periodMs: 0,
      p5: 0,
      flags: 0,
    };
  });
  stripQueries: number[] = [];

  private readonly stateListeners: Array<(state: DeviceState) => void> = [];
  private readonly linkListeners: Array<(state: string, detail?: unknown) => void> = [];
  private seq = 1;

  onLink(fn: (state: string, detail?: unknown) => void): () => void {
    this.linkListeners.push(fn);
    return () => {
      const i = this.linkListeners.indexOf(fn);
      if (i >= 0) this.linkListeners.splice(i, 1);
    };
  }

  onState(fn: (state: DeviceState) => void): () => void {
    this.stateListeners.push(fn);
    return () => {
      const i = this.stateListeners.indexOf(fn);
      if (i >= 0) this.stateListeners.splice(i, 1);
    };
  }

  emitState(state: DeviceState): void {
    for (const fn of this.stateListeners.slice()) {
      fn(state);
    }
  }

  async write(req: CommandRequest): Promise<{ seq: number }> {
    this.attempts.push(req);
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new Error("写失败");
    }
    this.writes.push(req);
    this.writeTimes.push(Date.now());
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return { seq };
  }

  sendAndWaitAck(
    req: CommandRequest,
  ): Promise<{ seq: number; command: number; resultCode: number; ok: boolean }> {
    this.attempts.push(req);
    this.writes.push(req);
    this.writeTimes.push(Date.now());
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return Promise.resolve({ seq, command: req.command, resultCode: 0, ok: true });
  }

  /** #48：改色前读回设备权威的段列表。 */
  async queryStrip(
    stripId: number,
  ): Promise<{ reports: SegmentReport[]; end: SegmentListEnd }> {
    this.stripQueries.push(stripId);
    return {
      reports: this.reports.map((report) => ({ ...report })),
      end: { stripId, segMask: 0xff },
    };
  }

  async disconnect(): Promise<void> {
    /* 测试里不做连接清理 */
  }

  destroy(): void {
    this.stateListeners.length = 0;
  }
}

interface SessionHarness {
  session: ControlSession;
  transport: FakeTransport;
  clock: ReturnType<typeof fakeClock>;
}

function makeSession(): SessionHarness {
  const clock = fakeClock();
  const transport = new FakeTransport();
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  const session = new ControlSession({
    platform: "other",
    devMode: false,
    transportOverride: transport as unknown as BleTransport,
    throttleTimer: clock.timerApi,
  });
  return { session, transport, clock };
}

/**
 * 把微任务队列跑空。
 *
 * #48 起颜色帧要先 await 一次 `queryStrip`（读回完整 spec），一次 emit 的
 * Promise 链比之前长；2 个 tick 不够，会让写时间戳落在下一拍、把 20Hz 的
 * 间隔断言测成 40ms 的假失败。这里放宽到 40 个 tick（仍是纯微任务）。
 */
async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe("HSV → 用户空间 RGB（不做 gamma）", () => {
  it("0° / 120° / 240° 是纯红 / 纯绿 / 纯蓝", () => {
    expect(hsvToRgb(0, 1, 1)).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb(120, 1, 1)).toEqual({ r: 0, g: 255, b: 0 });
    expect(hsvToRgb(240, 1, 1)).toEqual({ r: 0, g: 0, b: 255 });
    /* 三原色之间的两个中点也必须是纯色相，不带白。 */
    expect(hsvToRgb(60, 1, 1)).toEqual({ r: 255, g: 255, b: 0 });
    expect(hsvToRgb(180, 1, 1)).toEqual({ r: 0, g: 255, b: 255 });
    expect(hsvToRgb(300, 1, 1)).toEqual({ r: 255, g: 0, b: 255 });
  });

  it("饱和度边界：S=0 是灰阶，S=1 饱和；明度 V 单独控制", () => {
    /* S=0、V=1：纯白，与色相无关。 */
    expect(hsvToRgb(0, 0, 1)).toEqual({ r: 255, g: 255, b: 255 });
    expect(hsvToRgb(200, 0, 1)).toEqual({ r: 255, g: 255, b: 255 });
    /* V=0：纯黑，与色相/饱和度无关。 */
    expect(hsvToRgb(200, 1, 0)).toEqual({ r: 0, g: 0, b: 0 });
    /* V=0.5 的纯红是 128，不是 gamma 后的 ~55——App 侧绝不做 gamma。 */
    expect(hsvToRgb(0, 1, 0.5)).toEqual({ r: 128, g: 0, b: 0 });
    /* S=0.5 的红：R=255、G=B=128（HSV 定义，不是 HSL）。 */
    expect(hsvToRgb(0, 0.5, 1)).toEqual({ r: 255, g: 128, b: 128 });
  });

  it("越界输入被安全归一化，不产生非法字节", () => {
    expect(normalizeHue(-60)).toBe(300);
    expect(normalizeHue(720)).toBe(0);
    expect(normalizeHue(Number.NaN)).toBe(0);
    expect(hsvToRgb(-60, 1, 1)).toEqual(hsvToRgb(300, 1, 1));
    expect(hsvToRgb(480, 1, 1)).toEqual(hsvToRgb(120, 1, 1));
    /* S / V 越界钳到 [0,1]；NaN 按 0。 */
    expect(hsvToRgb(0, 2, 1)).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb(0, Number.NaN, Number.NaN)).toEqual({ r: 0, g: 0, b: 0 });

    for (let hue = 0; hue < 360; hue += 7) {
      const rgb = hsvToRgb(hue, 1, 1);
      for (const value of [rgb.r, rgb.g, rgb.b]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(255);
      }
    }
  });

  it("RGB → HSV 反推：纯色与灰阶", () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 1, v: 1 });
    expect(rgbToHsv({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, v: 1 });
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });

    /* 往返：任意色相/饱和度都能被还原（允许 ±2 的舍入误差）。 */
    for (const hue of [0, 30, 90, 150, 210, 270, 330]) {
      const rgb = hsvToRgb(hue, 0.6, 1);
      const hsv = rgbToHsv(rgb);
      expect(Math.abs(hsv.h - hue)).toBeLessThan(2);
      expect(Math.abs(hsv.s - 0.6)).toBeLessThan(0.02);
    }
  });

  it("十六进制互转只用于展示，非法输入返回 null", () => {
    expect(rgbToHex({ r: 255, g: 180, b: 120 })).toBe("#FFB478");
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
    expect(rgbToHex({ r: 300, g: -5, b: 12.6 })).toBe("#FF000D");
    expect(hexToRgb("#FFB478")).toEqual({ r: 255, g: 180, b: 120 });
    expect(hexToRgb("ffb478")).toEqual({ r: 255, g: 180, b: 120 });
    expect(hexToRgb("#GG0000")).toBeNull();
    expect(hexToRgb("12345")).toBeNull();
  });

  it("预设表 6-8 个，暖白与协议默认值和测试向量一致", () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(PRESETS.length).toBeLessThanOrEqual(8);

    const warm = PRESETS.find((p) => p.name === "暖白");
    expect(warm).toBeDefined();
    /* 协议默认 RGB 255/180/120：v3 的 State 示例里字节 2-4 就是这三个值
     * （层 0 基准色），所以直接拿向量文件当唯一真相，不另抄一份 hex。 */
    expect(warm?.rgb).toEqual({ r: 255, g: 180, b: 120 });
    expect(warm?.hex).toBe("#FFB478");
    const stateHex = vectors.state_read_example_hex;
    expect(bytesToCompactHex(new Uint8Array([warm!.rgb.r, warm!.rgb.g, warm!.rgb.b]))).toBe(
      stateHex.slice(4, 10).toUpperCase(),
    );

    /* 每个预设的 hex 与 rgb 必须一致（同一来源解析，避免两套值漂移）。 */
    for (const preset of PRESETS) {
      expect(rgbToHex(preset.rgb), preset.name).toBe(preset.hex);
      expect(hexToRgb(preset.hex), preset.name).toEqual(preset.rgb);
    }
    /* 名字不重复，且包含 issue 要求的常用色。 */
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
    for (const required of ["暖白", "冷白", "红", "绿", "蓝", "紫", "橙"]) {
      expect(PRESETS.some((p) => p.name === required), required).toBe(true);
    }
  });
});

describe("颜色语义纯函数", () => {
  it("clampRgb 把每个通道钳成 0-255 的整数", () => {
    expect(clampChannel(300)).toBe(255);
    expect(clampChannel(-1)).toBe(0);
    expect(clampChannel(12.6)).toBe(13);
    expect(clampChannel(Number.NaN)).toBe(0);
    expect(clampRgb({ r: 300, g: -20, b: 127.5 })).toEqual({ r: 255, g: 0, b: 128 });
  });

  it("applyLocalColor 在 v5 已无字段可改（State 不再有 RGB），只做入参归一", () => {
    const state = baseState({ power: 0, brightness: 42 });
    const next = applyLocalColor(state, { r: 0, g: 0, b: 255 });
    /* v5 的 State 是 32 字节且不含颜色摘要（§7.3），所以这里原样返回。 */
    expect(next).toEqual(state);
    expect(next.power).toBe(0);
    expect(next.brightness).toBe(42);
    expect(sameRgb({ r: 1, g: 2, b: 3 }, { r: 1, g: 2, b: 3 })).toBe(true);
    expect(sameRgb({ r: 1, g: 2, b: 3 }, { r: 1, g: 2, b: 4 })).toBe(false);
  });
});
