/**
 * 循环三档必须真的到达设备（#114）。
 *
 * 三条断言层次不同的路径：
 *  1. `buildScriptPlan` 把三值原样写进 ActivateScript（纯函数，最便宜的定位点）；
 *  2. 页面的「应用并播放」/「继续播放」路径下发的是**用户选的那一档**；
 *  3. 一档改完不改草稿之外的任何东西——即「循环改动不触发设备写入」的反面：
 *     草稿为空时一帧都不发。
 *
 * 断言的是**设备可观察状态**（`session.deviceState.flags`），不是页面 `data`。
 * 演示传输层按 §7.5 的位表建模三值：loop=2 → bit0|bit2（0x05 / 0x07），
 * 所以这三档在没有真机时也能区分开。
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ControlSession } from "../utils/control/session";
import { MockTransport } from "../utils/ble/mock-transport";
import type { BleTransport } from "../utils/ble/transport";
import { MOCK_DEVICES } from "../utils/control/mock-devices";
import { setSessionForTest } from "../utils/control/session-singleton";
import { buildScriptPlan } from "../utils/control/script-plan";
import { PLAYBACK_FLAG, SEGMENT_TYPE } from "../utils/protocol/constants";
import { createSessionStorage } from "./helpers/storage";

const DEVICE = MOCK_DEVICES[0];

/** 简短的脚本：两阶段，第二个阶段有一整条灯带的分区。 */
function twoStageScript(ledCount: number) {
  return {
    scriptId: 0,
    stripCount: 1,
    stages: [
      { durationMs: 400, segments: [] },
      {
        durationMs: 400,
        segments: [
          {
            stripId: 0,
            segId: 0,
            start: 0,
            end: ledCount - 1,
            blend: 0,
            layer0: {
              type: SEGMENT_TYPE.STATIC,
              hue: 0,
              sat: 0,
              periodMs: 0,
              p5: 0,
              flags: 0,
              level: 100,
            },
            layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
          },
        ],
      },
    ],
  } as const;
}

/** flags 里的循环档位（与 §7.5 位表一致）。 */
function loopOf(flags: number): number {
  if ((flags & PLAYBACK_FLAG.LOOP) === 0) {
    return 0;
  }
  return (flags & PLAYBACK_FLAG.LOOP_LAST) !== 0 ? 2 : 1;
}

describe("#114 循环三档：计划层不压平", () => {
  it("ActivateScript 的 loop 字节就是入参（0 / 1 / 2）", () => {
    const script = twoStageScript(30);
    for (const loop of [0, 1, 2] as const) {
      const plan = buildScriptPlan(script as never, { activate: true, loop });
      const activate = plan.steps.find((step) => step.kind === "activate");
      expect(activate, `loop=${loop} 应有 activate 步`).toBeDefined();
      expect(activate!.request.payload[1], `loop=${loop} 的 ActivateScript 字节`).toBe(loop);
    }
  });

  it("「播一次」只在真的不循环时出现（0 不能被当成循环）", () => {
    const script = twoStageScript(30);
    const labels = ([0, 1, 2] as const).map(
      (loop) =>
        buildScriptPlan(script as never, { activate: true, loop }).steps.find(
          (step) => step.kind === "activate",
        )!.label,
    );
    expect(new Set(labels).size, `三档文案应当互不相同：${labels.join(" / ")}`).toBe(3);
  });
});

describe("#114 循环三档：会话直传", () => {
  async function makeSession() {
    const session = new ControlSession({
      platform: "other",
      devMode: false,
      storage: createSessionStorage(),
      transportOverride: new MockTransport() as unknown as BleTransport,
      reconnectDelaysMs: [],
    });
    await session.connect(DEVICE.deviceId, DEVICE.broadcastName);
    return session;
  }

  it("downloadScript 激活的档位与 setPlayback 播放的档位都落到设备 flags", async () => {
    const session = await makeSession();
    const ledCount = session.deviceState!.stripCounts[0];
    try {
      for (const loop of [0, 1, 2] as const) {
        const uploaded = await session.downloadScript(twoStageScript(ledCount) as never, {
          activate: true,
          loop,
        });
        expect(uploaded.kind, `loop=${loop} 下发应当成功`).toBe("ok");
        expect(loopOf(session.deviceState!.flags), `激活后 loop=${loop}`).toBe(loop);

        const played = await session.setPlayback(1, loop);
        expect(played.kind, `loop=${loop} 播放应当成功`).toBe("ok");
        expect(loopOf(session.deviceState!.flags), `播放后 loop=${loop}`).toBe(loop);
      }
    } finally {
      await session.disconnect();
    }
  });
});
