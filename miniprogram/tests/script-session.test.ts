/**
 * #32 剧本下发的 Session 行为（用假传输通道，不 mock 协议字节）。
 *
 * 覆盖本票最关键的三条端到端语义：
 *  1. 下发帧序 = Begin → Stage/Segment… → Commit → Activate，且进度按 ACK 推进；
 *  2. 任意一帧被拒 → 立即 Abort，返回值是失败（设备保留上一套可用配置）；
 *  3. play/pause/stop 的 action 与 loop 按协议下发（暂停后 play = 从暂停点继续，
 *     这是设备侧 pause_offset_ms 的语义，小程序只负责发对 action）。
 */

import { describe, expect, it } from "vitest";

import { ControlSession } from "../utils/control/session";
import type { BleTransport } from "../utils/ble/transport";
import { breathingSegment, staticSegment } from "../utils/protocol/commands";
import type { AckResult, CommandRequest, DeviceState } from "../utils/protocol/types";
import { CMD } from "../utils/protocol/constants";
import type { ScriptConfig } from "../utils/control/script-plan";

/** 只实现 session 用到的成员。 */
class FakeTransport {
  linkState: "ready" | "idle" = "ready";
  /** 按顺序记录发出的每条命令。 */
  sent: CommandRequest[] = [];
  /** 抛错的下发下标（-1 = 全部成功）。 */
  failAt = -1;
  /** 拒绝（ACK 非零）的下发下标。 */
  rejectAt = -1;
  private readonly linkListeners: Array<(state: string, detail?: unknown) => void> = [];
  private readonly stateListeners: Array<(state: DeviceState) => void> = [];

  onLink(fn: (state: string, detail?: unknown) => void): () => void {
    this.linkListeners.push(fn);
    return () => {
      const i = this.linkListeners.indexOf(fn);
      if (i >= 0) this.linkListeners.splice(i, 1);
    };
  }

  /** session 构造时订阅 State（设备权威的本地镜像）。 */
  onState(fn: (state: DeviceState) => void): () => void {
    this.stateListeners.push(fn);
    return () => {
      const i = this.stateListeners.indexOf(fn);
      if (i >= 0) this.stateListeners.splice(i, 1);
    };
  }

  /** 下发用：逐帧串行，每帧成功后回调进度。 */
  async sendSequence(
    requests: CommandRequest[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    for (let i = 0; i < requests.length; i += 1) {
      const ack = await this.sendAndWaitAck(requests[i]);
      if (!ack.ok) {
        throw new Error("ACK 失败");
      }
      onProgress?.(i + 1, requests.length);
    }
  }

  sendAndWaitAck(req: CommandRequest): Promise<AckResult> {
    this.sent.push(req);
    const index = this.sent.length - 1;
    if (index === this.failAt) {
      return Promise.reject(new Error("连接已断开"));
    }
    if (index === this.rejectAt) {
      return Promise.resolve({ seq: index, command: req.command, resultCode: 0x01, ok: false });
    }
    return Promise.resolve({ seq: index, command: req.command, resultCode: 0, ok: true });
  }

  /** session.refreshState 用；返回设备权威 State。 */
  readState(): Promise<DeviceState> {
    return Promise.resolve(state());
  }

  /** session.queryScript 用。 */
  queryScript(scriptId: number): Promise<{
    scriptId: number;
    stageCount: number;
    flags: number;
    active: boolean;
  }> {
    return Promise.resolve({ scriptId, stageCount: 4, flags: 0x03, active: true });
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

/** 一套 4 阶段剧本（阶段 2 / 3 带段）。 */
function fourStageScript(): ScriptConfig {
  return {
    scriptId: 0,
    stripCount: 1,
    stages: [
      { durationMs: 1000, segments: [staticSegment(0, 0, 0, 9, 0x0000, 0xff)] },
      { durationMs: 1500, segments: [] },
      {
        durationMs: 2000,
        segments: [breathingSegment(0, 0, 0, 14, 0x2000, 0xff, 1000, 0x20)],
      },
      { durationMs: 2500, segments: [staticSegment(0, 0, 15, 29, 0x4000, 0xff)] },
    ],
  };
}

describe("#32 session.downloadScript", () => {
  it("帧序 = Begin → Stage/Segment… → Commit → Activate，进度按 ACK 单调推进", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    const progress: number[] = [];

    const result = await session.downloadScript(fourStageScript(), { loop: true }, (view) => {
      progress.push(view.done);
    });

    expect(result.kind).toBe("ok");

    const commands = transport.sent.map((req) => req.command);
    expect(commands[0]).toBe(CMD.SCRIPT_BEGIN);
    expect(commands[commands.length - 2]).toBe(CMD.SCRIPT_COMMIT);
    expect(commands[commands.length - 1]).toBe(CMD.ACTIVATE_SCRIPT);
    /* 4 个 Stage 帧 + 3 个 Segment 帧夹在 Begin 与 Commit 之间。 */
    expect(commands.filter((c) => c === CMD.SCRIPT_STAGE)).toHaveLength(4);
    expect(commands.filter((c) => c === CMD.SCRIPT_SEGMENT)).toHaveLength(3);

    /* 进度：0（开始）+ 每帧一次 + 完成时再报一次，且单调不减。
     * 帧数 = Begin 1 + Stage 4 + Segment 3 + Commit 1 + Activate 1 = 10。 */
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(10);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    }

    /* Activate 带的 loop 是用户选的那个。 */
    const activate = transport.sent[transport.sent.length - 1];
    expect(activate.payload[1]).toBe(1);
  });

  it("末位激活可以关掉（只下发不启用）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.downloadScript(fourStageScript(), { activate: false });
    expect(transport.sent[transport.sent.length - 1].command).toBe(CMD.SCRIPT_COMMIT);
  });

  it("某帧被拒 → 立即 Abort 并返回失败（设备保留上一套配置）", async () => {
    const transport = new FakeTransport();
    transport.rejectAt = 3; /* 第 4 帧（某个 Segment）被拒 */
    const session = makeSession(transport);

    const result = await session.downloadScript(fourStageScript());
    expect(result.kind).toBe("error");

    /* 失败后一定补一条 Abort（丢弃设备暂存），且**没有** Commit。 */
    const commands = transport.sent.map((req) => req.command);
    expect(commands).toContain(CMD.SCRIPT_ABORT);
    expect(commands).not.toContain(CMD.SCRIPT_COMMIT);
    expect(commands).not.toContain(CMD.ACTIVATE_SCRIPT);
  });

  it("传输异常同样 Abort 并上报（不回滚成功假象）", async () => {
    const transport = new FakeTransport();
    transport.failAt = 2;
    const session = makeSession(transport);

    const result = await session.downloadScript(fourStageScript());
    expect(result.kind).toBe("error");
    const commands = transport.sent.map((req) => req.command);
    expect(commands).toContain(CMD.SCRIPT_ABORT);
    expect(commands).not.toContain(CMD.SCRIPT_COMMIT);
  });

  it("本端预检不过时一帧都不发（越界 / 重叠 / 时长为 0）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);

    const zeroDuration = fourStageScript();
    zeroDuration.stages[1].durationMs = 0;
    const result = await session.downloadScript(zeroDuration);
    expect(result.kind).toBe("invalid");
    expect(transport.sent).toHaveLength(0);

    const overlap: ScriptConfig = {
      scriptId: 0,
      stripCount: 1,
      stages: [
        {
          durationMs: 500,
          segments: [staticSegment(0, 0, 0, 15, 0, 255), staticSegment(0, 1, 10, 20, 0, 255)],
        },
      ],
    };
    expect((await session.downloadScript(overlap)).kind).toBe("invalid");
    expect(transport.sent).toHaveLength(0);
  });
});

describe("#32 session 播放控制与查询", () => {
  it("play / pause / stop 分别发 action 1 / 2 / 0，loop 原样带上", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);

    await session.setPlayback(1, true);
    await session.setPlayback(2, true);
    await session.setPlayback(0, false);

    const payloads = transport.sent.map((req) => Array.from(req.payload));
    expect(transport.sent.every((req) => req.command === CMD.SET_PLAYBACK)).toBe(true);
    expect(payloads).toEqual([
      [1, 1],
      [2, 1],
      [0, 0],
    ]);
  });

  it("activateScript 发 script_id + loop", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.activateScript(2, false);
    expect(transport.sent[0].command).toBe(CMD.ACTIVATE_SCRIPT);
    expect(Array.from(transport.sent[0].payload)).toEqual([2, 0]);
  });

  it("queryScript 返回设备权威摘要（长度不符不猜）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    const result = await session.queryScript(1);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.summary).toMatchObject({ scriptId: 1, stageCount: 4, active: true });
    }
  });

  it("未连接时下发直接报错，不发帧", async () => {
    const transport = new FakeTransport();
    transport.linkState = "idle";
    const session = makeSession(transport);
    const result = await session.downloadScript(fourStageScript());
    expect(result.kind).toBe("error");
    expect(transport.sent).toHaveLength(0);
  });
});
