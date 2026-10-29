/**
 * #10 颜色与预设端到端的小程序侧测试。
 *
 * 覆盖：
 *  1. HSV→RGB 纯函数：0°/120°/240°、饱和度与明度边界、**不做 gamma**；
 *  2. RGB→HSV 反推（设备状态回填色环）、十六进制互转、预设表；
 *  3. 色环几何：圆环命中判定（中心/环外/边缘容差）、角度与坐标互转；
 *  4. 颜色与亮度共用同一个 20Hz latest-wins 节流通道（不叠成 40Hz）；
 *  5. 预设用一条 SetAll 原子下发，且编码与测试向量逐字节一致；
 *  6. 快速切预设 / 拖动残留颜色都不出现旧色回跳。
 *
 * 只替换计时器与传输通道（spec 允许的两个假件），不 mock 协议字节。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  hexToRgb,
  hsvForWheel,
  hsvToRgb,
  normalizeHue,
  PRESETS,
  rgbToHex,
  rgbToHsv,
} from "../utils/color/hsv";
import {
  drawWheel,
  hueAtPoint,
  moveWheelMarker,
  pointForHue,
  wheelGeometry,
  WHEEL_HIT_SLOP,
} from "../utils/color/wheel";
import { applyLocalColor, clampChannel, clampRgb, presetBrightness, sameRgb } from "../utils/control/color";
import { ControlSession } from "../utils/control/session";
import { bytesToCompactHex } from "../utils/protocol/hex";
import { encodeFrame } from "../utils/protocol/frame";
import type { BleTransport } from "../utils/ble/transport";
import type { CommandRequest, DeviceState } from "../utils/protocol/types";

const CMD_SET_BRIGHTNESS = 0x02;
const CMD_SET_COLOR = 0x03;
const CMD_SET_ALL = 0x04;

interface VectorCase {
  name: string;
  command?: number;
  seq?: number;
  payload_hex?: string;
  frame_hex: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("../../docs/protocol-testvectors.json", import.meta.url), "utf8"),
) as { cases: VectorCase[] };

function vector(name: string): VectorCase {
  const found = vectors.cases.find((c) => c.name === name);
  expect(found, name).toBeDefined();
  return found as VectorCase;
}

function baseState(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    power: 1,
    brightness: 128,
    r: 255,
    g: 180,
    b: 120,
    ledCount: 30,
    maxBrightness: 255,
    ...overrides,
  };
}

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
  /** 手动控制 ACK 何时/以什么顺序返回（快速切预设用）。 */
  deferAcks = false;
  pendingAcks: Array<{ req: CommandRequest; resolve: (resultCode: number) => void }> = [];

  private readonly stateListeners: Array<(state: DeviceState) => void> = [];
  private seq = 1;

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
    if (!this.deferAcks) {
      return Promise.resolve({ seq, command: req.command, resultCode: 0, ok: true });
    }
    return new Promise((resolve) => {
      this.pendingAcks.push({
        req,
        resolve: (resultCode: number) => {
          resolve({ seq, command: req.command, resultCode, ok: resultCode === 0 });
        },
      });
    });
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

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

  it("RGB → HSV 反推：纯色与灰阶（灰阶保留上次色相）", () => {
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

    /* 灰阶：色相无意义，保留调用方给的 fallback（避免选中点跳到正红）。 */
    const gray = hsvForWheel({ r: 128, g: 128, b: 128 }, 200);
    expect(gray.h).toBe(200);
    expect(gray.s).toBe(0);
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
    /* 协议默认 RGB 255/180/120；向量 set_color_warm_white 的载荷是 FFB478。 */
    expect(warm?.rgb).toEqual({ r: 255, g: 180, b: 120 });
    expect(warm?.hex).toBe("#FFB478");
    expect(bytesToCompactHex(new Uint8Array([warm!.rgb.r, warm!.rgb.g, warm!.rgb.b]))).toBe(
      vector("set_color_warm_white").payload_hex,
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

  it("本地乐观更新只改 RGB，不动 power / brightness / ledCount", () => {
    const state = baseState({ power: 0, brightness: 42 });
    const next = applyLocalColor(state, { r: 0, g: 0, b: 255 });
    expect(next).toEqual({ ...state, r: 0, g: 0, b: 255 });
    expect(next.power).toBe(0);
    expect(next.brightness).toBe(42);
    expect(state.r).toBe(255); // 不修改入参
    expect(sameRgb({ r: 1, g: 2, b: 3 }, { r: 1, g: 2, b: 3 })).toBe(true);
    expect(sameRgb({ r: 1, g: 2, b: 3 }, { r: 1, g: 2, b: 4 })).toBe(false);
  });

  it("预设亮度：常态取当前亮度，亮度 0 时用最近一次非 0 值", () => {
    expect(presetBrightness(baseState({ brightness: 90 }), 200)).toBe(90);
    expect(presetBrightness(baseState({ brightness: 0 }), 200)).toBe(200);
    /* 设备上限优先；null 状态回退到 255 上限。 */
    expect(presetBrightness(baseState({ brightness: 200, maxBrightness: 180 }), 200)).toBe(180);
    expect(presetBrightness(null, 200)).toBe(200);
    expect(presetBrightness(null, 0)).toBe(128);
  });
});

describe("色环几何（触控精度只到这里，其余待真机）", () => {
  const geometry = wheelGeometry(420);

  it("由尺寸推导环宽与半径，环带不与中心重叠", () => {
    expect(geometry.size).toBe(420);
    expect(geometry.center).toBe(210);
    expect(geometry.outerRadius).toBe(209);
    expect(geometry.ringWidth).toBeCloseTo(100.8, 5);
    expect(geometry.innerRadius).toBeCloseTo(108.2, 5);
    expect(geometry.markerRadius).toBeCloseTo(158.6, 5);
    /* 环中线到内外边缘的距离相等。 */
    expect(geometry.markerRadius - geometry.innerRadius).toBeCloseTo(
      geometry.outerRadius - geometry.markerRadius,
      5,
    );
    /* 非法尺寸不会产生负半径。 */
    expect(wheelGeometry(0).outerRadius).toBeGreaterThan(0);
    expect(wheelGeometry(Number.NaN).innerRadius).toBeGreaterThanOrEqual(0);
  });

  it("触摸点 → 色相：右 0°、下 90°、左 180°、上 270°", () => {
    const mid = geometry.markerRadius;
    expect(hueAtPoint(geometry.center + mid, geometry.center, geometry)).toBeCloseTo(0, 5);
    expect(hueAtPoint(geometry.center, geometry.center + mid, geometry)).toBeCloseTo(90, 5);
    expect(hueAtPoint(geometry.center - mid, geometry.center, geometry)).toBeCloseTo(180, 5);
    expect(hueAtPoint(geometry.center, geometry.center - mid, geometry)).toBeCloseTo(270, 5);
  });

  it("中心空白与环外返回 null，边缘有容差", () => {
    expect(hueAtPoint(geometry.center, geometry.center, geometry)).toBeNull();
    expect(hueAtPoint(0, 0, geometry)).toBeNull();
    expect(hueAtPoint(Number.NaN, 10, geometry)).toBeNull();

    /* 内圈稍微越界（在 HIT_SLOP 内）仍然命中：手指有宽度。 */
    const justInside = geometry.center + geometry.innerRadius - WHEEL_HIT_SLOP + 1;
    expect(hueAtPoint(justInside, geometry.center, geometry)).not.toBeNull();
    /* 深入内圈（超过容差）不命中，避免手指划过中心导致颜色乱跳。 */
    const deepInside = geometry.center + geometry.innerRadius - WHEEL_HIT_SLOP - 1;
    expect(hueAtPoint(deepInside, geometry.center, geometry)).toBeNull();
    /* 环外超过容差不命中。 */
    const wellOutside = geometry.center + geometry.outerRadius + WHEEL_HIT_SLOP + 1;
    expect(hueAtPoint(wellOutside, geometry.center, geometry)).toBeNull();
  });

  it("色相 → 坐标 → 色相 往返一致", () => {
    for (const hue of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const point = pointForHue(hue, geometry);
      const back = hueAtPoint(point.x, point.y, geometry);
      expect(back).not.toBeNull();
      expect(Math.abs((back as number) - hue)).toBeLessThan(0.01);
    }
  });

  it("绘制函数只接触受控的 2D 接口（不依赖 DOM）", () => {
    /* 记录调用的假上下文：验证绘制顺序与 dpr 缩放，不验证像素。 */
    const calls: string[] = [];
    const ctx = {
      setTransform: () => calls.push("setTransform"),
      clearRect: () => calls.push("clearRect"),
      beginPath: () => calls.push("beginPath"),
      arc: () => calls.push("arc"),
      stroke: () => calls.push("stroke"),
      fill: () => calls.push("fill"),
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 0,
      lineCap: "butt" as const,
    };
    drawWheel(ctx, geometry, 2, 30, "#FFB478");
    expect(calls[0]).toBe("setTransform");
    expect(calls[1]).toBe("clearRect");
    /* 360 段弧 + 选中点 2 段弧。 */
    expect(calls.filter((c) => c === "arc")).toHaveLength(362);
    expect(calls.filter((c) => c === "fill")).toHaveLength(1);

    /* 拖动：擦两块（旧位置 + 新位置）并补回对应环弧，再画新标记。 */
    calls.length = 0;
    moveWheelMarker(ctx, geometry, 2, 60, "#FFB478", 30);
    expect(calls[0]).toBe("setTransform");
    expect(calls.filter((c) => c === "clearRect")).toHaveLength(2);
    expect(calls.filter((c) => c === "fill")).toHaveLength(1);
    /* 擦除次数恒定，与拖动历史无关。 */
    const arcsForMove = calls.filter((c) => c === "arc").length;
    calls.length = 0;
    moveWheelMarker(ctx, geometry, 2, 300, "#FFB478", 60);
    expect(calls.filter((c) => c === "arc").length).toBe(arcsForMove);
  });
});

describe("颜色与亮度共用同一个 20Hz 节流通道", () => {
  it("亮度与颜色交替输入 1 秒：写次数 ≤20，任意两帧间隔 ≥50ms", async () => {
    const { session, transport, clock } = makeSession();
    transport.emitState(baseState());

    /* 模拟 100Hz：每 10ms 交替推亮度与颜色。 */
    for (let i = 0; i < 100; i += 1) {
      if (i % 2 === 0) {
        session.queueBrightness(100 + (i % 40));
      } else {
        session.queueColor(hsvToRgb(i * 3.6, 1, 1));
      }
      clock.advance(10);
      await settle();
    }
    clock.advance(200);
    await settle();

    expect(transport.writes.length).toBeLessThanOrEqual(20);
    expect(transport.writes.length).toBeGreaterThan(0);
    /* 若两路各有一套 20Hz 闸门，这里会看到 <50ms 的间隔（叠成 40Hz）。 */
    for (let i = 1; i < transport.writeTimes.length; i += 1) {
      expect(transport.writeTimes[i] - transport.writeTimes[i - 1]).toBeGreaterThanOrEqual(50);
    }
    /* 两种命令都真的走了这条通道（不是只测了亮度）。 */
    const commands = new Set(transport.writes.map((w) => w.command));
    expect(commands.has(CMD_SET_BRIGHTNESS)).toBe(true);
    expect(commands.has(CMD_SET_COLOR)).toBe(true);

    vi.restoreAllMocks();
  });

  it("颜色拖动是乐观更新：本地立即变，power / brightness 不动", async () => {
    const { session, transport, clock } = makeSession();
    transport.emitState(baseState({ power: 1, brightness: 77 }));

    session.queueColor({ r: 0, g: 0, b: 255 });
    /* 还没到 50ms：本地状态已经跟手，但一帧都没发。 */
    expect(session.deviceState?.b).toBe(255);
    expect(transport.writes).toHaveLength(0);

    clock.advance(50);
    await settle();
    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0].command).toBe(CMD_SET_COLOR);
    expect(bytesToCompactHex(transport.writes[0].payload)).toBe("0000FF");
    expect(session.deviceState?.power).toBe(1);
    expect(session.deviceState?.brightness).toBe(77);

    vi.restoreAllMocks();
  });

  it("连续颜色不重传：写失败后只发下一个最新值", async () => {
    const { session, transport, clock } = makeSession();
    transport.emitState(baseState());

    transport.failNextWrites = 1;
    session.queueColor({ r: 255, g: 0, b: 0 });
    clock.advance(50);
    await settle();
    session.queueColor({ r: 0, g: 255, b: 0 });
    clock.advance(50);
    await settle();

    /* 红只尝试一次（没有重传），随后发的是绿。 */
    expect(transport.attempts.map((r) => bytesToCompactHex(r.payload))).toEqual([
      "FF0000",
      "00FF00",
    ]);
    expect(transport.writes.map((r) => bytesToCompactHex(r.payload))).toEqual(["00FF00"]);

    vi.restoreAllMocks();
  });
});

describe("开关与颜色快速切换不出现旧色回跳", () => {
  it("拖着颜色快速关开灯：颜色保持最新，开关帧之后不再补发旧色", async () => {
    const { session, transport, clock } = makeSession();
    transport.emitState(baseState({ power: 1, brightness: 128, r: 255, g: 180, b: 120 }));

    /* 先把颜色拖到红（20Hz 节流发出去）。 */
    session.queueColor({ r: 255, g: 0, b: 0 });
    clock.advance(50);
    await settle();
    const afterColor = transport.writes.length;
    expect(transport.writes[afterColor - 1].command).toBe(CMD_SET_COLOR);

    /* 立刻关灯再开灯（离散路径，等 ACK）。 */
    const offResult = await session.setPower(false);
    const onResult = await session.setPower(true);
    expect(offResult.kind).toBe("ok");
    expect(onResult.kind).toBe("ok");

    /* 推进时钟：节流通道里不应再有残留的颜色帧。 */
    clock.advance(300);
    await settle();

    const afterToggle = transport.writes.slice(afterColor);
    expect(afterToggle.every((r) => r.command !== CMD_SET_COLOR)).toBe(true);
    /* 本地颜色仍是最后拖到的红，没有被开关路径或旧帧改回去。 */
    expect(session.deviceState?.r).toBe(255);
    expect(session.deviceState?.g).toBe(0);
    expect(session.deviceState?.b).toBe(0);
    expect(session.deviceState?.power).toBe(1);

    vi.restoreAllMocks();
  });

  it("拖动颜色同时下发预设：最终是新预设色，不是拖动的旧色", async () => {
    const { session, transport, clock } = makeSession();
    transport.emitState(baseState({ power: 1, brightness: 128 }));

    session.queueColor({ r: 255, g: 0, b: 0 }); // 还没到 50ms 的 pending 红
    const purple = PRESETS.find((p) => p.name === "紫")!;
    await session.applyPreset(purple.rgb);
    clock.advance(300);
    await settle();

    expect(transport.writes.map((r) => r.command)).toEqual([CMD_SET_ALL]);
    expect(session.deviceState?.r).toBe(purple.rgb.r);
    expect(session.deviceState?.g).toBe(purple.rgb.g);
    expect(session.deviceState?.b).toBe(purple.rgb.b);

    vi.restoreAllMocks();
  });
});

describe("预设 = 一次 SetAll 原子下发", () => {
  it("只发一帧 SetAll，载荷 [power=1, 当前亮度, R, G, B]", async () => {
    const { session, transport } = makeSession();
    transport.emitState(baseState({ power: 0, brightness: 90, r: 255, g: 180, b: 120 }));

    const red = PRESETS.find((p) => p.name === "红")!;
    const result = await session.applyPreset(red.rgb);

    expect(result.kind).toBe("ok");
    expect(transport.writes).toHaveLength(1);
    const write = transport.writes[0];
    expect(write.command).toBe(CMD_SET_ALL);
    expect(bytesToCompactHex(write.payload)).toBe("015AFF0000");
    /* 关灯态点预设也点亮（预设 = 场景入口），亮度沿用当前值。 */
    expect(session.deviceState?.power).toBe(1);
    expect(session.deviceState?.brightness).toBe(90);
    expect(session.deviceState?.r).toBe(255);

    vi.restoreAllMocks();
  });

  it("当前亮度为 0：用最近一次非 0 亮度恢复，避免「点了但没亮」", async () => {
    const { session, transport } = makeSession();
    transport.emitState(baseState({ power: 1, brightness: 200 }));
    transport.emitState(baseState({ power: 1, brightness: 0 }));

    const blue = PRESETS.find((p) => p.name === "蓝")!;
    await session.applyPreset(blue.rgb);

    expect(bytesToCompactHex(transport.writes[0].payload)).toBe("01C80000FF");
    expect(session.deviceState?.brightness).toBe(200);

    vi.restoreAllMocks();
  });

  it("SetAll 编码与测试向量逐字节一致（set_all_on / set_all_off）", async () => {
    const onCase = vector("set_all_on");
    const payload = new Uint8Array([0x01, 0x80, 0xff, 0xb4, 0x78]);
    expect(bytesToCompactHex(encodeFrame(onCase.command as number, onCase.seq as number, payload))).toBe(
      onCase.frame_hex,
    );

    const offCase = vector("set_all_off");
    const offPayload = new Uint8Array([0x00, 0x80, 0xff, 0xb4, 0x78]);
    expect(
      bytesToCompactHex(encodeFrame(offCase.command as number, offCase.seq as number, offPayload)),
    ).toBe(offCase.frame_hex);

    /* SetColor 向量同样逐字节一致。 */
    const colorCase = vector("set_color_red");
    const colorPayload = new Uint8Array([0xff, 0x00, 0x00]);
    expect(
      bytesToCompactHex(
        encodeFrame(colorCase.command as number, colorCase.seq as number, colorPayload),
      ),
    ).toBe(colorCase.frame_hex);
    expect(colorCase.command).toBe(CMD_SET_COLOR);
    expect(onCase.command).toBe(CMD_SET_ALL);
  });

  it("拖动残留的旧颜色在预设下发前被丢弃（不发旧色）", async () => {
    const { session, transport, clock } = makeSession();
    transport.emitState(baseState());

    /* 拖动留下一个还没发出的颜色。 */
    session.queueColor({ r: 10, g: 20, b: 30 });
    expect(transport.writes).toHaveLength(0);

    const green = PRESETS.find((p) => p.name === "绿")!;
    await session.applyPreset(green.rgb);
    /* 之后时钟推进：被丢弃的旧颜色不能再落地。 */
    clock.advance(200);
    await settle();

    expect(transport.writes.map((r) => r.command)).toEqual([CMD_SET_ALL]);
    expect(bytesToCompactHex(transport.writes[0].payload)).toBe("018000FF00");
    expect(session.deviceState?.g).toBe(255);

    vi.restoreAllMocks();
  });

  it("快速连点两个预设：最终颜色是最后一次，旧 ACK 不回跳", async () => {
    const { session, transport } = makeSession();
    transport.emitState(baseState({ power: 1, brightness: 100 }));
    transport.deferAcks = true;

    const red = PRESETS.find((p) => p.name === "红")!;
    const blue = PRESETS.find((p) => p.name === "蓝")!;

    const first = session.applyPreset(red.rgb);
    const second = session.applyPreset(blue.rgb);

    /* 两帧都发出（SetAll 是绝对值命令，FIFO 顺序保证设备最终 = 最后一次）。 */
    expect(transport.writes.map((r) => bytesToCompactHex(r.payload))).toEqual([
      "0164FF0000",
      "01640000FF",
    ]);
    expect(session.deviceState?.b).toBe(255);

    /* 制造乱序返回：先完成第一次（红），再完成第二次（蓝）。 */
    expect(transport.pendingAcks).toHaveLength(2);
    transport.pendingAcks[0].resolve(0);
    expect((await first).kind).toBe("ok");
    /* 旧的红色 ACK 回来时不能把本地颜色改回红。 */
    expect(session.deviceState?.b).toBe(255);
    expect(session.deviceState?.r).toBe(0);

    transport.pendingAcks[1].resolve(0);
    const result = await second;
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.state.b).toBe(255);
      expect(result.state.r).toBe(0);
      expect(result.state.power).toBe(1);
    }

    vi.restoreAllMocks();
  });

  it("预设 ACK 超时允许重发一次（离散绝对值命令），连续颜色不重发", async () => {
    const { session, transport } = makeSession();
    transport.emitState(baseState());

    /* 假通道的 sendAndWaitAck 不会超时；这里只验证调用参数：SetAll 带重试、SetColor 不带。
     * 用记录调用参数的包装器确认。 */
    const calls: Array<{ command: number; retries?: number }> = [];
    const original = transport.sendAndWaitAck.bind(transport);
    transport.sendAndWaitAck = ((req: CommandRequest, opts?: { retryOnTimeout?: number }) => {
      calls.push({ command: req.command, retries: opts?.retryOnTimeout });
      return original(req, opts);
    }) as typeof transport.sendAndWaitAck;

    const cyan = PRESETS.find((p) => p.name === "青")!;
    await session.applyPreset(cyan.rgb);
    expect(calls).toEqual([{ command: CMD_SET_ALL, retries: 1 }]);

    vi.restoreAllMocks();
  });
});
