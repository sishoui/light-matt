/**
 * 循环三档必须真的到达设备（#114 的判据，v5 形状）。
 *
 * v4 的 `loop-mode.test.ts` 测的是「剧本级循环在 `ActivateScript` 的 loop 字节」。
 * v5 把循环的宿主换成了**每个部位一份**（T2，`ScenePart` 的 loop 字节，§7.5），
 * 取值与位表都没变。所以这个文件测同一件事的新路径：
 *
 *  1. **协议层**：`cmdScenePart` 的 loop 字节就是入参（0 / 1 / 2 三档都发得出去）；
 *  2. **会话层**：`setScenePart` 之后设备的循环档真的变了，且三档互不相同；
 *  3. **语义边界**：改循环不重写步数（步数不变时设备不清时间轴，§6.2）；
 *  4. **越界**：loop = 3 被构造器拒绝，一帧都不发。
 *
 * 断言落在**设备可观察状态**（`session.sceneOf` / `deviceState`）上，不看页面 data。
 */

import { describe, expect, it } from "vitest";
import { ControlSession } from "../utils/control/session";
import { MockTransport } from "../utils/ble/mock-transport";
import type { BleTransport } from "../utils/ble/transport";
import { MOCK_DEVICES } from "../utils/control/mock-devices";
import { cmdScenePart, parseScenePartReport } from "../utils/protocol/commands";
import { CMD, LOOP, LOOP_MAX, MAX_STEPS, RESULT } from "../utils/protocol/constants";
import { createSessionStorage } from "./helpers/storage";

const DEVICE = MOCK_DEVICES[0];

async function makeSession(): Promise<{ session: ControlSession; transport: MockTransport }> {
  const transport = new MockTransport();
  const session = new ControlSession({
    platform: "other",
    devMode: false,
    storage: createSessionStorage(),
    transportOverride: transport as unknown as BleTransport,
    reconnectDelaysMs: [],
  });
  await session.connect(DEVICE.deviceId, DEVICE.broadcastName);
  return { session, transport };
}

/** 某部位当前的循环档（从场景读回取，而不是从页面 data）。 */
async function loopOf(session: ControlSession, stripId = 0, partId = 0): Promise<number> {
  const sceneId = session.deviceState?.activeScene ?? 0;
  const read = await session.queryScene(sceneId);
  expect(read.kind).toBe("ok");
  if (read.kind !== "ok") return -1;
  return (
    read.scene.parts.find((part) => part.stripId === stripId && part.partId === partId)?.loop ?? -1
  );
}

describe("协议层：ScenePart 的 loop 字节", () => {
  it("三档原样编码（0 / 1 / 2），不做重映射", () => {
    for (const loop of [LOOP.NONE, LOOP.ALL, LOOP.LAST]) {
      const req = cmdScenePart(0, 0, 0, 1, loop, true);
      expect(req.command).toBe(CMD.SCENE_PART);
      expect(req.payload[4], `loop=${loop}`).toBe(loop);
    }
  });

  it("三档互不相同（不是把一个布尔压成两档）", () => {
    const bytes = [LOOP.NONE, LOOP.ALL, LOOP.LAST].map(
      (loop) => cmdScenePart(0, 0, 0, 1, loop, true).payload[4],
    );
    expect(new Set(bytes).size).toBe(3);
  });

  it("越界的 loop / 步数被构造器拒绝（提前拒绝，不发帧）", () => {
    expect(() => cmdScenePart(0, 0, 0, 1, LOOP_MAX + 1, true)).toThrow(RangeError);
    expect(() => cmdScenePart(0, 0, 0, MAX_STEPS + 1, LOOP.NONE, true)).toThrow(RangeError);
    /* 0 步是合法值：它表示「这个部位在本场景里不演」（恒黑，S10）。 */
    expect(cmdScenePart(0, 0, 0, 0, LOOP.NONE, false).payload[3]).toBe(0);
  });

  it("读回的 loop 三档能区分开（0x8B 的字节布局）", () => {
    for (const loop of [LOOP.NONE, LOOP.ALL, LOOP.LAST]) {
      const report = parseScenePartReport(
        new Uint8Array([0, 0, 0, 1, loop, 1]),
      );
      expect(report.loop, `loop=${loop}`).toBe(loop);
    }
  });
});

describe("会话层：三档真的到达设备", () => {
  it("逐档写入后读回就是那一档（三档全部走一遍）", async () => {
    const { session } = await makeSession();
    try {
      for (const loop of [LOOP.ALL, LOOP.LAST, LOOP.NONE]) {
        const result = await session.setScenePart(0, 0, 0, 1, loop, true);
        expect(result.kind, `loop=${loop} 写入应当成功`).toBe("ok");
        expect(await loopOf(session), `写完读回 loop=${loop}`).toBe(loop);
      }
    } finally {
      await session.disconnect();
    }
  });

  it("改循环不重写步数（步数不变时设备不清时间轴）", async () => {
    const { session } = await makeSession();
    try {
      /* 先给这一步一个可识别的时长，改完循环后应当还在。 */
      const before = await session.queryScene(0);
      expect(before.kind).toBe("ok");
      if (before.kind !== "ok") return;
      const stepBefore = before.scene.steps.find(
        (step) => step.stripId === 0 && step.partId === 0 && step.stepIndex === 0,
      );
      const duration = stepBefore?.durationMs ?? 3000;

      const result = await session.setScenePart(0, 0, 0, 1, LOOP.LAST, true);
      expect(result.kind).toBe("ok");

      const after = await session.queryScene(0);
      expect(after.kind).toBe("ok");
      if (after.kind !== "ok") return;
      const stepAfter = after.scene.steps.find(
        (step) => step.stripId === 0 && step.partId === 0 && step.stepIndex === 0,
      );
      expect(stepAfter?.durationMs, "时长没被重置").toBe(duration);
    } finally {
      await session.disconnect();
    }
  });

  it("关部位不动循环档（开关与循环是同一条命令的两个字段）", async () => {
    const { session } = await makeSession();
    try {
      await session.setScenePart(0, 0, 0, 1, LOOP.LAST, true);
      await session.setScenePart(0, 0, 0, 1, LOOP.LAST, false);
      const read = await session.queryScene(0);
      expect(read.kind).toBe("ok");
      if (read.kind !== "ok") return;
      const part = read.scene.parts.find((item) => item.stripId === 0 && item.partId === 0);
      expect(part?.on, "关掉了").toBe(false);
      expect(part?.loop, "循环档保留").toBe(LOOP.LAST);
    } finally {
      await session.disconnect();
    }
  });

  it("越界档位不发帧（构造器抛错被会话折成 error）", async () => {
    const { session, transport } = await makeSession();
    try {
      transport.log.clear();
      const result = await session.setScenePart(0, 0, 0, 1, LOOP_MAX + 1, true);
      expect(result.kind).toBe("error");
      expect(
        transport.log.snapshot().filter((entry) => entry.dir === "tx" && entry.command === CMD.SCENE_PART),
      ).toEqual([]);
    } finally {
      await session.disconnect();
    }
  });

  it("写入成功后场景读回缓存作废（页面不会读到写入前的那一份）", async () => {
    const { session } = await makeSession();
    try {
      /* 先读一次把缓存填上。 */
      const first = await session.queryScene(0);
      expect(first.kind).toBe("ok");
      expect(session.sceneOf(0), "缓存已就位").not.toBeNull();

      await session.setScenePart(0, 0, 0, 1, LOOP.ALL, true);
      expect(session.sceneOf(0), "写成功必须作废缓存").toBeNull();
    } finally {
      await session.disconnect();
    }
  });

  it("写入失败时缓存仍有效（缓存里那份仍是权威）", async () => {
    const { session } = await makeSession();
    try {
      const read = await session.queryScene(0);
      expect(read.kind).toBe("ok");
      /* loop 越界 → 构造器抛错 → 会话折成 error，设备没被改。 */
      const bad = await session.setScenePart(0, 0, 0, 1, LOOP_MAX + 1, true);
      expect(bad.kind).toBe("error");
      expect(session.sceneOf(0), "失败不该把缓存清掉").not.toBeNull();
    } finally {
      await session.disconnect();
    }
  });
});

describe("场景读回：0x8B / 0x8D 的字段是怎么拼出来的", () => {
  it("SceneListEnd 的名字与 ScenePart 的开关位都在读回里", async () => {
    const { session } = await makeSession();
    try {
      const read = await session.queryScene(0);
      expect(read.kind).toBe("ok");
      if (read.kind !== "ok") return;
      expect(read.scene.name, "演示设备有场景名").toBeTruthy();
      const part = read.scene.parts.find((item) => item.stripId === 0 && item.partId === 0);
      expect(part, "部位 0 在场景里").toBeDefined();
      expect(typeof part!.on).toBe("boolean");
      expect(part!.stepCount).toBeGreaterThanOrEqual(0);
    } finally {
      await session.disconnect();
    }
  });

  it("设备拒绝未知部位（ScenePart 的 strip/part 必须真实存在）", async () => {
    const { session } = await makeSession();
    try {
      const result = await session.setScenePart(0, 0, 7, 1, LOOP.NONE, true);
      /* 演示传输层按 §6.2 回 InvalidParam：部位不存在。 */
      expect(result.kind === "ack-error" || result.kind === "error").toBe(true);
    } finally {
      await session.disconnect();
    }
  });
});

describe("Result 码表：循环相关命令不会收到退役码", () => {
  it("0x0A（v4 的 ScriptTooLarge）在 v5 的 RESULT 表里已不存在", () => {
    /* v5 删掉了剧本族，所以「剧本太大」这个码不复用。拿着编号查表不会命中
     * 「剧本太大」的文案，避免把布局 / 场景的错误解释成剧本问题。 */
    const values = Object.values(RESULT);
    expect(values).not.toContain(0x0a);
  });
});
