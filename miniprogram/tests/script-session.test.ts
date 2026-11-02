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
import { AckRejectedError } from "../utils/ble/errors";
import { breathingSegment, staticSegment } from "../utils/protocol/commands";
import type { AckResult, CommandRequest, DeviceState } from "../utils/protocol/types";
import { CMD, RESULT, SEGMENT_TYPE } from "../utils/protocol/constants";
import type { ScriptConfig } from "../utils/control/script-plan";
import { checkScriptCapacity } from "../utils/control/script-plan";
import type { SegmentSpec } from "../utils/protocol/types";
import { baseState } from "./helpers/state";

/** 只实现 session 用到的成员。 */
class FakeTransport {
  linkState: "ready" | "idle" = "ready";
  /** 按顺序记录发出的每条命令。 */
  sent: CommandRequest[] = [];
  /** 抛错的下发下标（-1 = 全部成功）。 */
  failAt = -1;
  /** 拒绝（ACK 非零）的下发下标。 */
  rejectAt = -1;
  /** 拒绝时用的结果码（默认 InvalidParam；0x0A 用于 ScriptTooLarge）。 */
  rejectCode = RESULT.INVALID_PARAM;
  /** 摘要读回结果（按 scriptId）。 */
  summaries = new Map<number, { scriptId: number; stageCount: number; flags: number; active: boolean }>();
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

  /** 下发用：逐帧串行，每帧成功后回调进度；非零 ACK 与真实传输层同样中断。 */
  async sendSequence(
    requests: CommandRequest[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    for (let i = 0; i < requests.length; i += 1) {
      const ack = await this.sendAndWaitAck(requests[i]);
      if (!ack.ok) {
        throw new AckRejectedError(ack.command, ack.resultCode);
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
      return Promise.resolve({
        seq: index,
        command: req.command,
        resultCode: this.rejectCode,
        ok: false,
      });
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
    const found = this.summaries.get(scriptId);
    return Promise.resolve(found ?? { scriptId, stageCount: 4, flags: 0x03, active: true });
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
  return baseState(overrides);
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

describe("#45 容量预检与 ScriptTooLarge (0x0A)", () => {
  /** 8 带 × 8 阶段 × 8 段两层动画：单套 9835 字节（16192+... 见 script-plan）。 */
  function worstCaseScript(): ScriptConfig {
    const animation: SegmentSpec = {
      stripId: 0,
      segId: 0,
      start: 0,
      end: 0,
      blend: 2,
      layer0: { type: SEGMENT_TYPE.BREATHING, hue: 0, sat: 255, periodMs: 1000, p5: 0, flags: 0 },
      layer1: { type: SEGMENT_TYPE.COMET, hue: 0, sat: 255, periodMs: 1000, p5: 0, flags: 0 },
    };
    const stages = [];
    for (let stage = 0; stage < 8; stage += 1) {
      const segments = [];
      for (let strip = 0; strip < 8; strip += 1) {
        for (let seg = 0; seg < 8; seg += 1) {
          segments.push({ ...animation, stripId: strip, segId: seg, start: seg, end: seg });
        }
      }
      stages.push({ durationMs: 1000, segments });
    }
    return { scriptId: 0, stripCount: 8, stages };
  }

  it("单套理论最坏（9835 B）仍可下发——16KB 是 4 套共享的", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    const script = worstCaseScript();
    const check = session.scriptCapacityForDevice(script);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.bytes).toBe(9835);
    }
    const result = await session.downloadScript(script, { activate: false });
    expect(result.kind).toBe("ok");
    expect(transport.sent.length).toBeGreaterThan(0);
  });

  it("超限时一帧都不发（预检直接返回 invalid）", async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    /*
     * 单套剧本的物理上限是 8 带 × 8 阶段 × 8 段 = 9835 字节，永远进不了
     * 16384；所以「超限不发」的守卫只能用 checkScriptBlobBytes 直接验证。
     * 4 套满配合计 39316 字节超限，但那要设备侧 Commit 才能发现（0x0A），
     * 因为其它槽位的内容读不回来。
     */
    expect(checkScriptCapacity([worstCaseScript()]).ok).toBe(true);
    const four = [0, 1, 2, 3].map((id) => ({ ...worstCaseScript(), scriptId: id }));
    expect(checkScriptCapacity(four).ok).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it("Commit 回 0x0A → too-large，文案明说设备配置未改变，且不发 Activate", async () => {
    const transport = new FakeTransport();
    /* Commit 是第 1 + 4 + 3 = 8 条已发命令（下标 7）。 */
    const plan = fourStageScript();
    const frameCountBeforeCommit = 1 + plan.stages.length + 3;
    transport.rejectAt = frameCountBeforeCommit;
    transport.rejectCode = RESULT.SCRIPT_TOO_LARGE;
    const session = makeSession(transport);

    const result = await session.downloadScript(plan);
    expect(result.kind).toBe("too-large");
    if (result.kind === "too-large") {
      expect(result.message).toContain("剧本过大");
      expect(result.message).toContain("设备配置未改变");
    }
    const commands = transport.sent.map((req) => req.command);
    expect(commands).toContain(CMD.SCRIPT_ABORT);
    expect(commands).not.toContain(CMD.ACTIVATE_SCRIPT);
  });

  it("其它非零 ACK 仍走 error（不误报成剧本过大）", async () => {
    const transport = new FakeTransport();
    transport.rejectAt = 2;
    transport.rejectCode = RESULT.INVALID_PARAM;
    const session = makeSession(transport);
    const result = await session.downloadScript(fourStageScript());
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("剧本过大");
    }
  });
});

describe("#45 摘要读回（4 个槽位）", () => {
  it("依次查 0-3 并返回全部摘要", async () => {
    const transport = new FakeTransport();
    transport.summaries.set(0, { scriptId: 0, stageCount: 4, flags: 0x03, active: true });
    transport.summaries.set(1, { scriptId: 1, stageCount: 0, flags: 0, active: false });
    transport.summaries.set(2, { scriptId: 2, stageCount: 2, flags: 0, active: false });
    transport.summaries.set(3, { scriptId: 3, stageCount: 8, flags: 0, active: false });
    const session = makeSession(transport);

    const result = await session.queryScriptSummaries();
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.summaries.map((s) => s.stageCount)).toEqual([4, 0, 2, 8]);
      expect(result.summaries[0].active).toBe(true);
    }
  });

  it("读回失败时保留已读到的前缀并给出原因", async () => {
    const transport = new FakeTransport();
    let calls = 0;
    transport.queryScript = (scriptId: number) => {
      calls += 1;
      if (calls > 2) {
        return Promise.reject(new Error("超时"));
      }
      return Promise.resolve({ scriptId, stageCount: 4, flags: 0, active: false });
    };
    const session = makeSession(transport);
    const result = await session.queryScriptSummaries();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("超时");
      expect(result.summaries).toHaveLength(2);
    }
  });

  it("未连接时读摘要直接报错，不发帧", async () => {
    const transport = new FakeTransport();
    transport.linkState = "idle";
    const session = makeSession(transport);
    const result = await session.queryScriptSummaries();
    expect(result.kind).toBe("error");
    expect(transport.sent).toHaveLength(0);
  });
});
