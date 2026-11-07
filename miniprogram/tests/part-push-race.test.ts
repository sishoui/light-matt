/**
 * `pages/part` 的时间轴下发：**并发写入的中间态**（`pending-tasks.md` §0 第 3 条）。
 *
 * 缺陷原状：`pushSteps()` 既不查 `data.busy` 也不置自己的互斥位。于是
 *
 *  - 它能在 `onSaveContent()` 写到一半时插进来，`applyEpoch += 1` 把对方那半截
 *    写静默作废——用户刚调的灯效没到设备；
 *  - 它自己循环里每轮现读 `this.timelineSteps`，而写入途中收到 State 事件会让
 *    `load()` 用设备上的（写了一半的）步骤覆盖本地数组，于是「步数按旧的、
 *    时长按新的」，设备上留下谁都没见过的混合态。
 *
 * 复现需要**真实的时间窗口**：mock 的 `sendAndWaitAck` 是同步返回的，两次 await
 * 之间不让出事件循环。所以这里给传输层套一道闸门，把前 N 帧扣在用例手里。
 */

import { describe, expect, it } from "vitest";
import { openPage } from "./helpers/page-harness";

/** 以「演示设备 0 的 strip 0 / 部位 0」打开部位页。 */
async function openPart() {
  return openPage("part", { strip: "0", part: "0" });
}

/** 等条件成立。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等超时");
}

/** 让事件循环跑几拍（把挂起的 await 都推进一步）。 */
async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * 扣住前 `hold` 帧时间轴命令（默认 0x25 / 0x26），其余照常立即执行。
 *
 * 读回（QueryScene / QueryLayout）不拦，否则 `load()` 也会被挂住。
 */
function gate(transport: any, hold = 1, commands: number[] = [0x25, 0x26]) {
  const original = transport.sendAndWaitAck.bind(transport);
  const held: Array<{ command: number; release: () => void }> = [];
  /** 经过闸门的命令序列（用于断言「没有插队」）。 */
  const passed: number[] = [];
  let seen = 0;
  transport.sendAndWaitAck = (req: any, opts: any) => {
    if (!commands.includes(req.command)) {
      return original(req, opts);
    }
    passed.push(req.command);
    if (seen >= hold) {
      return original(req, opts);
    }
    seen += 1;
    return new Promise((resolve, reject) => {
      held.push({
        command: req.command,
        release: () => {
          original(req, opts).then(resolve, reject);
        },
      });
    });
  };
  return {
    held,
    passed,
    /** 放行最早那一帧。 */
    async releaseOne(): Promise<void> {
      const next = held.shift();
      if (next === undefined) {
        throw new Error("没有待放行的命令");
      }
      next.release();
      await tick();
    },
    async releaseAll(): Promise<void> {
      while (held.length > 0) {
        await this.releaseOne();
      }
      await tick();
    },
  };
}

/** 从设备读回该部位在当前场景里的全部步骤（设备权威，不走缓存）。 */
async function deviceSteps(harness: any, stripId = 0, partId = 0) {
  const sceneId = harness.session.deviceState?.activeScene ?? 0;
  const read = await harness.session.queryScene(sceneId);
  if (read.kind !== "ok") {
    throw new Error(`读场景失败：${read.kind}`);
  }
  return read.scene.steps
    .filter((step: any) => step.stripId === stripId && step.partId === partId)
    .sort((a: any, b: any) => a.stepIndex - b.stepIndex);
}

/** 等页面这一轮写彻底收尾。 */
async function idle(harness: any): Promise<void> {
  await waitFor(() => harness.page.data.busy === false);
  await tick();
  await waitFor(() => harness.page.data.busy === false);
}

describe("时间轴下发：与其它写入的互斥", () => {
  it("保存内容在飞时加一步：不插队，等保存收尾后补跑（保存的灯效没被冲掉）", async () => {
    const harness = await openPart();
    try {
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      await harness.session.setScenePart(sceneId, 0, 0, 1, 0, true);
      await harness.page.load();

      const gates = gate(harness.transport, 1);

      /* 1) 发起「保存内容」：ScenePart 被扣住。 */
      harness.page.onPanelTypeTap({ currentTarget: { dataset: { type: "rainbow" } } });
      const saving = harness.page.onSaveContent();
      await tick();
      expect(gates.held.length, "保存内容的 ScenePart 已发出").toBe(1);
      expect(harness.page.data.busy).toBe(true);

      /* 2) 保存还没回来时点「加一步」：必须排队，不能插进去把保存作废。 */
      harness.page.onAddStep();
      await tick();
      expect(
        (harness.page.data.timelineBlocks as unknown[]).length,
        "界面上立刻多一步",
      ).toBe(2);

      /* 3) 放行保存内容。 */
      await gates.releaseAll();
      await saving;
      await idle(harness);

      /* 设备上：两步，且第 0 步仍是彩虹（保存内容的结果没被作废）。 */
      const steps = await deviceSteps(harness);
      expect(steps.length, "加的那一步补跑到了设备上").toBe(2);
      expect(steps[0].layer0.type, "第 0 步的彩虹保住了").toBe(0x02);
    } finally {
      await harness.dispose();
    }
  });

  it("连点两次「加一步」：只补跑最后一次，设备上是最终步数", async () => {
    const harness = await openPart();
    try {
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      await harness.session.setScenePart(sceneId, 0, 0, 1, 0, true);
      await harness.page.load();

      const gates = gate(harness.transport, 1);

      harness.page.onAddStep();
      await tick();
      /* 第一轮被扣住；再点两次。 */
      harness.page.onAddStep();
      harness.page.onAddStep();
      await tick();

      expect((harness.page.data.timelineBlocks as unknown[]).length).toBe(4);

      await gates.releaseAll();
      await idle(harness);
      await waitFor(() => (harness.page.data.timelineBlocks as unknown[]).length === 4);

      const steps = await deviceSteps(harness);
      expect(steps.length, "设备上是最终步数").toBe(4);
    } finally {
      await harness.dispose();
    }
  });

  it("写入途中收到 State 事件：不拿写了一半的设备状态覆盖本地时间轴", async () => {
    const harness = await openPart();
    try {
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      await harness.session.setScenePart(sceneId, 0, 0, 1, 0, true);
      await harness.page.load();

      const gates = gate(harness.transport, 1);

      harness.page.onAddStep();
      await tick();
      /* 此刻设备侧 ScenePart 还没放行（步数仍是 1），本地已经是 2 步。
       * 模拟写入途中一次 State 推送把页面推进 load()。 */
      await harness.page.load();
      expect(
        (harness.page.data.timelineBlocks as unknown[]).length,
        "本地那一步还在",
      ).toBe(2);

      await gates.releaseAll();
      await idle(harness);

      const steps = await deviceSteps(harness);
      expect(steps.length).toBe(2);
    } finally {
      await harness.dispose();
    }
  });
});

describe("时间轴下发：循环里用的是快照", () => {
  it("写第 1 步时改了第 3 步的时长：同一轮里后面几步仍按开跑那一刻的数组写", async () => {
    const harness = await openPart();
    try {
      const sceneId = harness.session.deviceState?.activeScene ?? 0;
      await harness.session.setScenePart(sceneId, 0, 0, 2, 0, true);
      await harness.page.load();
      expect((harness.page.data.timelineBlocks as unknown[]).length).toBe(2);

      /* 扣住 ScenePart + 第一帧 SceneStep：放行 ScenePart 后正好停在「写第 0 步」。 */
      const gates = gate(harness.transport, 2);
      harness.page.onAddStep(); /* 2 → 3 步，触发整条时间轴重写 */
      /* 开跑那一刻的时长（这一轮的快照）。 */
      const snapshot = (harness.page.data.timelineBlocks as Array<{ durationMs: number }>).map(
        (block) => block.durationMs,
      );
      await tick();
      await gates.releaseOne(); /* 放行 ScenePart，第一帧 SceneStep 被扣住 */
      expect(gates.held.length, "正卡在写第 0 步").toBe(1);

      /* 正在写第 0 步时，用户把第 3 步的时长拖到 9 秒。 */
      harness.page.onStepTap({ currentTarget: { dataset: { index: 2 } } });
      harness.page.onDurationChange({ currentTarget: { dataset: {} }, detail: { value: 9 } });

      await gates.releaseAll();
      await idle(harness);

      /* 这一轮用的快照里第 3 步还是原来的时长——设备上不应出现 9 秒。
       * （9 秒只在下一轮下发时才会生效，那是用户下一次动作的事。） */
      const steps = await deviceSteps(harness);
      expect(steps.length).toBe(3);
      expect(
        steps.map((s) => s.durationMs),
        "同一轮里没有混进「写到一半才改的」时长",
      ).toEqual(snapshot);
    } finally {
      await harness.dispose();
    }
  });
});
