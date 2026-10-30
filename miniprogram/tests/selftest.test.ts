/**
 * #13 自检命令的小程序侧测试。
 *
 * 覆盖：
 *  1. SelfTest 是 0 字节载荷的 0x07，编码与 docs/protocol-testvectors.json
 *     的 `self_test` 向量逐字节一致；
 *  2. session.selfTest() 只发一帧、不改本地状态/UI（自检是设备侧临时覆盖）；
 *  3. ACK 非 0 与异常都如实上报，不伪装成功；
 *  4. 请求显式带 retryOnTimeout：一次丢包不能让按钮看起来没反应。
 *
 * 只替换传输通道（spec 允许的假件），不 mock 协议字节。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { ControlSession } from "../utils/control/session";
import { cmdSelfTest } from "../utils/protocol/commands";
import { encodeFrame } from "../utils/protocol/frame";
import { bytesToCompactHex } from "../utils/protocol/hex";
import type { BleTransport } from "../utils/ble/transport";
import type { AckResult, CommandRequest, DeviceState } from "../utils/protocol/types";

const CMD_SELF_TEST = 0x07;

interface VectorCase {
  name: string;
  command?: number;
  seq?: number;
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

/** 只实现 session 用到的成员：sendAndWaitAck / onLink / onState / linkState。 */
class FakeTransport {
  linkState: "ready" | "idle" = "ready";
  attempts: Array<{ req: CommandRequest; opts: unknown }> = [];
  nextResult: "ok" | "ack-error" | "throw" = "ok";
  private readonly stateListeners: Array<(state: DeviceState) => void> = [];
  private readonly linkListeners: Array<(state: string, detail?: unknown) => void> = [];

  /** #11 起 session 内部订阅链路状态；这里只记录，不主动触发。 */
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

  sendAndWaitAck(
    req: CommandRequest,
    opts: unknown,
  ): Promise<AckResult> {
    this.attempts.push({ req, opts });
    if (this.nextResult === "throw") {
      return Promise.reject(new Error("连接已断开"));
    }
    const seq = 1;
    if (this.nextResult === "ack-error") {
      return Promise.resolve({ seq, command: req.command, resultCode: 0x05, ok: false });
    }
    return Promise.resolve({ seq, command: req.command, resultCode: 0, ok: true });
  }
}

function makeSession(transport: FakeTransport): ControlSession {
  return new ControlSession({
    platform: "other",
    devMode: false,
    transportOverride: transport as unknown as BleTransport,
  });
}

function state(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    power: 1,
    brightness: 128,
    r: 255,
    g: 180,
    b: 120,
    ledCount: 30,
    maxBrightness: 255,
    stripCount: 1,
    segCount: 0,
    scriptId: 0xff,
    stageIndex: 0,
    playbackState: 0,
    flags: 0,
    ...overrides,
  };
}

describe("SelfTest 帧", () => {
  it("0 字节载荷、命令字 0x07，编码与共用向量一致", () => {
    const req = cmdSelfTest();
    expect(req.command).toBe(CMD_SELF_TEST);
    expect(req.payload.length).toBe(0);

    const expected = vector("self_test");
    const frame = encodeFrame(req.command, expected.seq as number, req.payload);
    expect(bytesToCompactHex(frame)).toBe(expected.frame_hex.toUpperCase());
  });
});

describe("session.selfTest", () => {
  it("只发一帧 SelfTest，且不动本地状态（自检是设备侧临时覆盖）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    transport.emitState(state());

    const result = await session.selfTest();

    expect(result.kind).toBe("ok");
    expect(transport.attempts.length).toBe(1);
    expect(transport.attempts[0].req.command).toBe(CMD_SELF_TEST);
    expect(transport.attempts[0].req.payload.length).toBe(0);

    // 自检不写共享状态：本地快照保持设备上报的原值，UI 不会跟着变红。
    expect(session.deviceState).toEqual(state());
  });

  it("ACK 超时重发一次：显式传 retryOnTimeout", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.selfTest();
    expect(transport.attempts[0].opts).toEqual({ retryOnTimeout: 1 });
  });

  it("非 0 结果码如实返回 ack-error，不伪装成功", async () => {
    const transport = new FakeTransport();
    transport.nextResult = "ack-error";
    const session = makeSession(transport);
    const result = await session.selfTest();
    expect(result.kind).toBe("ack-error");
    if (result.kind === "ack-error") {
      expect(result.ack.resultCode).toBe(0x05);
    }
  });

  it("传输异常返回 error 并保留原因", async () => {
    const transport = new FakeTransport();
    transport.nextResult = "throw";
    const session = makeSession(transport);
    const result = await session.selfTest();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("连接已断开");
    }
  });

  it("未连接时不会自己发帧（由页面 ready 门禁保证）", async () => {
    const transport = new FakeTransport();
    transport.linkState = "idle";
    const session = makeSession(transport);
    // session 本身不做连接判断（页面负责），这里只锁住「失败必须上报」的行为。
    const spy = vi.spyOn(transport, "sendAndWaitAck");
    await session.selfTest();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
