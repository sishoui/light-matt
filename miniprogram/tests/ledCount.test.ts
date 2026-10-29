/**
 * #12 灯珠数量：输入校验、ACK 结果分支、3000ms 超时。
 *
 * 只测纯函数与 ControlSession 的公开行为；wx / BLE 用假传输通道替身
 * （spec 允许的假件之一）。不假装覆盖真机链路。
 */

import { describe, expect, it } from "vitest";

import {
  LED_COUNT_ACK_TIMEOUT_MS,
  ledCountResultHint,
  parseLedCountInput,
} from "../utils/control/ledCount";
import { ControlSession } from "../utils/control/session";
import type { SendOptions } from "../utils/ble/transport";
import type { AckResult, CommandRequest, DeviceState, LinkState } from "../utils/protocol/types";

/** 记录调用的假传输层；只实现 ControlSession 真正用到的那几个成员。 */
class FakeTransport {
  linkState: LinkState = "ready";
  readonly writes: CommandRequest[] = [];
  readonly sendOptions: Array<SendOptions | undefined> = [];
  readonly ackQueue: Array<AckResult | Error> = [];
  private stateListener: ((state: DeviceState) => void) | null = null;

  async sendAndWaitAck(req: CommandRequest, opts?: SendOptions): Promise<AckResult> {
    this.writes.push(req);
    this.sendOptions.push(opts);
    const next = this.ackQueue.shift();
    if (next === undefined) {
      throw new Error("测试未排 ACK");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  // ControlSession 构造时注册的订阅；返回空的取消函数。
  onState(fn: (state: DeviceState) => void): () => void {
    this.stateListener = fn;
    return () => {
      this.stateListener = null;
    };
  }

  /** 模拟设备上报 State（连接流水线 / StateReport 的效果）。 */
  emitState(state: DeviceState): void {
    this.stateListener?.(state);
  }

  onLink(): () => void {
    return () => undefined;
  }

  onDevices(): () => void {
    return () => undefined;
  }

  onDeviceEvent(): () => void {
    return () => undefined;
  }

  onScanHint(): () => void {
    return () => undefined;
  }

  destroy(): void {
    /* 测试替身：无资源可释放 */
  }
}

function ack(command: number, resultCode: number): AckResult {
  return { seq: 1, command, resultCode, ok: resultCode === 0x00 };
}

function sessionWith(transport: FakeTransport): ControlSession {
  return new ControlSession({
    platform: "android",
    devMode: false,
    transportOverride: transport as unknown as never,
  });
}

function stateWith(ledCount: number): DeviceState {
  return {
    power: 1,
    brightness: 128,
    r: 255,
    g: 180,
    b: 120,
    ledCount,
    maxBrightness: 255,
  };
}

describe("parseLedCountInput", () => {
  it("接受 1-64 的十进制整数", () => {
    expect(parseLedCountInput("1")).toEqual({ ok: true, value: 1 });
    expect(parseLedCountInput("30")).toEqual({ ok: true, value: 30 });
    expect(parseLedCountInput("64")).toEqual({ ok: true, value: 64 });
    expect(parseLedCountInput("  12  ")).toEqual({ ok: true, value: 12 });
    expect(parseLedCountInput(7)).toEqual({ ok: true, value: 7 });
  });

  it("拒绝 0（下界）", () => {
    const result = parseLedCountInput("0");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("至少");
  });

  it("拒绝 65（上界外）", () => {
    const result = parseLedCountInput("65");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("最多");
  });

  it("拒绝 999 / 越界大数", () => {
    expect(parseLedCountInput("999").ok).toBe(false);
    expect(parseLedCountInput("65535").ok).toBe(false);
  });

  it("拒绝非数字与空输入", () => {
    for (const raw of ["", "   ", "abc", "12a", "1.5", "-1", "+2", "0x10", "1e2"]) {
      expect(parseLedCountInput(raw).ok, `raw=${JSON.stringify(raw)}`).toBe(false);
    }
    expect(parseLedCountInput("").ok).toBe(false);
    expect(parseLedCountInput(undefined).ok).toBe(false);
    expect(parseLedCountInput(null).ok).toBe(false);
    expect(parseLedCountInput({}).ok).toBe(false);
  });

  it("数字输入的小数被拒绝", () => {
    expect(parseLedCountInput(1.5).ok).toBe(false);
    expect(parseLedCountInput(Number.NaN).ok).toBe(false);
  });

  it("小于下界与大于上界的数字都给出行界提示", () => {
    const low = parseLedCountInput(-3);
    const high = parseLedCountInput(100);
    expect(low.ok).toBe(false);
    expect(high.ok).toBe(false);
    if (!low.ok) expect(low.message).toContain("至少");
    if (!high.ok) expect(high.message).toContain("最多");
  });
});

describe("LED_COUNT_ACK_TIMEOUT_MS", () => {
  it("是 3000ms（重建句柄慢，不能用普通 600ms）", () => {
    expect(LED_COUNT_ACK_TIMEOUT_MS).toBe(3000);
  });

  it("明显大于普通命令的 600ms 超时", () => {
    expect(LED_COUNT_ACK_TIMEOUT_MS).toBeGreaterThan(600);
  });
});

describe("ledCountResultHint", () => {
  it("覆盖 Busy(0x05) / InternalError(0x09) / InvalidParam(0x01)", () => {
    expect(ledCountResultHint(0x05)).toContain("稍后重试");
    expect(ledCountResultHint(0x09)).toContain("原数量");
    expect(ledCountResultHint(0x01)).toContain("非法");
  });

  it("其它结果码返回空串，交给通用文案", () => {
    expect(ledCountResultHint(0x00)).toBe("");
    expect(ledCountResultHint(0x04)).toBe("");
  });
});

describe("ControlSession.setLedCount", () => {
  it("成功：发 0x06 且用 3000ms 超时，本地 ledCount 刷新", async () => {
    const transport = new FakeTransport();
    const session = sessionWith(transport);
    // 先给 session 一个初始状态（模拟连接流水线读完 State）。
    transport.emitState(stateWith(30));

    transport.ackQueue.push(ack(0x06, 0x00));
    const result = await session.setLedCount(60);

    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0].command).toBe(0x06);
    // 2 字节小端：60 = 0x3C
    expect(Array.from(transport.writes[0].payload)).toEqual([0x3c, 0x00]);
    expect(transport.sendOptions[0]).toEqual({ timeoutMs: 3000 });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.state.ledCount).toBe(60);
      // 只改数量，不动开关 / 亮度 / 颜色。
      expect(result.state.power).toBe(1);
      expect(result.state.brightness).toBe(128);
      expect(result.state.r).toBe(255);
    }
    expect(session.deviceState?.ledCount).toBe(60);
  });

  it("Busy(0x05)：返回 ack-error，本地 ledCount 保持旧值", async () => {
    const transport = new FakeTransport();
    const session = sessionWith(transport);
    transport.emitState(stateWith(30));

    transport.ackQueue.push(ack(0x06, 0x05));
    const result = await session.setLedCount(60);

    expect(result.kind).toBe("ack-error");
    if (result.kind === "ack-error") {
      expect(result.ack.resultCode).toBe(0x05);
      expect(ledCountResultHint(result.ack.resultCode)).toContain("稍后重试");
    }
    expect(session.deviceState?.ledCount).toBe(30);
    // 重建是重操作：不重传（sendOptions 里没有 retryOnTimeout）。
    expect(transport.sendOptions[0]?.retryOnTimeout).toBeUndefined();
  });

  it("InternalError(0x09)：返回 ack-error，旧值保留", async () => {
    const transport = new FakeTransport();
    const session = sessionWith(transport);
    transport.emitState(stateWith(30));

    transport.ackQueue.push(ack(0x06, 0x09));
    const result = await session.setLedCount(64);

    expect(result.kind).toBe("ack-error");
    if (result.kind === "ack-error") {
      expect(result.ack.resultCode).toBe(0x09);
      expect(ledCountResultHint(result.ack.resultCode)).toContain("原数量");
    }
    expect(session.deviceState?.ledCount).toBe(30);
  });

  it("超时异常：折成 error 结果，不发第二帧", async () => {
    const transport = new FakeTransport();
    const session = sessionWith(transport);
    transport.emitState(stateWith(30));

    transport.ackQueue.push(new Error("ACK: 超时 3000ms"));
    const result = await session.setLedCount(45);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("3000");
    }
    expect(transport.writes).toHaveLength(1);
    expect(session.deviceState?.ledCount).toBe(30);
  });

  it("非法数量不发帧（前端兜底拒绝）", async () => {
    const transport = new FakeTransport();
    const session = sessionWith(transport);

    for (const bad of [0, 65, 1.5, Number.NaN]) {
      const result = await session.setLedCount(bad);
      expect(result.kind, `count=${bad}`).toBe("error");
    }
    expect(transport.writes).toHaveLength(0);
  });

  it("未连接时不发帧", async () => {
    const transport = new FakeTransport();
    transport.linkState = "idle";
    const session = sessionWith(transport);

    const result = await session.setLedCount(30);

    expect(result.kind).toBe("error");
    expect(transport.writes).toHaveLength(0);
  });
});
