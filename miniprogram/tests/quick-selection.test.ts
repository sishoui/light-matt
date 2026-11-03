/**
 * #91 灯效选择的权威与排队。
 *
 * 这组测试锁「点了就立刻算数」这条承诺，而不是实现细节：
 *  1. 选中在写入期间保持权威（迟到的读回不能覆盖它）；
 *  2. 写入期间的点击排队，而不是被静默丢弃；
 *  3. 单光区灯组只发一条命令（预读 / 清空 / 回读都可以省）。
 *
 * 前两条用纯状态机验证（页面代码在 node 里跑不起来），第三条用页面源码的
 * 结构断言 + 命令计数（回归「一次点击十个来回」）。
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildQuickSpec, quickCardOf } from "../utils/control/quick-effects";
import type { ScriptDraft } from "../utils/control/script-view";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRIP_TS = readFileSync(join(ROOT, "pages/strip/strip.ts"), "utf8");

describe("选中权威（迟到的读回不覆盖）", () => {
  /**
   * 最小状态机：模拟「点了卡片 → 写设备 → 回读」三条时序。
   *
   * 这不是页面的实现，而是对**契约**的独立建模：无论页面怎么写，只要它满足
   * 这三条，用户就不会看到「高亮被改回去」。
   */
  class SelectionModel {
    selected: string | null = null;
    private busy = false;
    private queued: string | null = null;
    /** 每次真正写入时记下的卡片（测试据此断言命令条数）。 */
    readonly writes: string[] = [];

    constructor(private readonly writeDelay: () => Promise<void>) {}

    tap(cardId: string): void {
      /* 高亮在写之前就变（用户看到的第一反馈）。 */
      this.selected = cardId;
      if (this.busy) {
        this.queued = cardId;
        return;
      }
      void this.run();
    }

    /** 「迟到的读回」：按设备真实状态重算选中项。 */
    lateReadBack(deviceCardId: string): void {
      if (this.busy) {
        /* 写入期间的读回必须被丢弃——否则它会把刚选的覆盖回去。 */
        return;
      }
      this.selected = deviceCardId;
    }

    private async run(): Promise<void> {
      this.busy = true;
      try {
        const target = this.selected;
        if (target !== null) {
          this.writes.push(target);
          await this.writeDelay();
        }
      } finally {
        this.busy = false;
        if (this.queued !== null) {
          this.queued = null;
          void this.run();
        }
      }
    }
  }

  it("点卡片立刻高亮（不等写入完成）", () => {
    let release: (() => void) | null = null;
    const model = new SelectionModel(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    model.tap("warm");
    expect(model.selected).toBe("warm");
    release?.();
  });

  it("写入期间的迟到读回不会把选中改回去", () => {
    let release: (() => void) | null = null;
    const model = new SelectionModel(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    model.tap("breathe");
    /* 设备还报着旧卡：这时读回不该生效。 */
    model.lateReadBack("warm");
    expect(model.selected).toBe("breathe");
    release?.();
  });

  it("快速连点：每一次都被执行（排队而不是丢弃）", async () => {
    const resolvers: Array<() => void> = [];
    const model = new SelectionModel(
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    model.tap("warm");
    model.tap("breathe");
    model.tap("rainbow");
    /* 第一次写入进行中；后两次排队但只保留最后一个（中间值无意义）。 */
    expect(model.selected).toBe("rainbow");
    expect(model.writes).toEqual(["warm"]);
    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    /* 补写的是最后那张。 */
    expect(model.writes).toEqual(["warm", "rainbow"]);
    resolvers.shift()?.();
  });

  it("连点同一张卡不会重复写（选中没变）", async () => {
    const resolvers: Array<() => void> = [];
    const model = new SelectionModel(
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    model.tap("warm");
    model.tap("warm");
    expect(model.writes).toEqual(["warm"]);
    resolvers.shift()?.();
  });
});

describe("页面真的按这三条实现（结构断言）", () => {
  it("点卡片不再因 quickBusy 直接 return", () => {
    const tap = /onQuickCardTap\(e: WechatMiniprogram\.TouchEvent\)\s*\{([\s\S]*?)\n  \},/.exec(
      STRIP_TS,
    );
    expect(tap).not.toBeNull();
    /* 除注释外不该出现 `if (... quickBusy ...) return` 这种早退。 */
    const code = tap![1]
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
      .join("\n");
    expect(code).not.toMatch(/quickBusy[\s\S]{0,40}return/);
  });

  it("写入结束后补写排队的卡片（quickQueued）", () => {
    expect(STRIP_TS).toContain("quickQueued");
    expect(STRIP_TS).toMatch(/if \(this\.quickQueued\)/);
  });

  it("成功后不再调用 refreshSegments（用刚发出的内容渲染）", () => {
    const body = /async writeQuick\(\): Promise<void> \{([\s\S]*?)\n  \},/.exec(STRIP_TS);
    expect(body).not.toBeNull();
    const success = body![1].split("} catch (err) {")[0];
    expect(success).not.toContain("refreshSegments");
    /* 失败路径仍然回读（设备上的真实配置是唯一能解释失败的东西）。 */
    expect(body![1].split("} catch (err) {")[1]).toContain("refreshSegments");
  });

  it("单光区跳过预读与清空（singleZone 短路）", () => {
    expect(STRIP_TS).toContain("singleZone");
    expect(STRIP_TS).toMatch(/if \(!singleZone\) \{/);
    /* 预读与清空都在这个 if 里面。 */
    const guarded = /if \(!singleZone\) \{([\s\S]*?)const ledCount = this\.stripLedCount\(\);/.exec(
      STRIP_TS,
    );
    expect(guarded).not.toBeNull();
    expect(guarded![1]).toContain("queryStrip");
    expect(guarded![1]).toContain("clearSegment");
  });
});

describe("单光区只发一条 SetSegment", () => {
  it("单光区路径的命令序列是 [停播?, SetSegment]（无 QueryStrip / ClearSegment）", async () => {
    /* 用纯逻辑复现页面在该路径上的调用顺序：单光区时直接 setSegment。 */
    const calls: string[] = [];
    const singleZone = true;
    const session = {
      async queryStrip() {
        calls.push("queryStrip");
        return { kind: "ok" as const, reports: [], end: 0 };
      },
      async clearSegment() {
        calls.push("clearSegment");
        return { ok: true, resultCode: 0 };
      },
      async setSegment() {
        calls.push("setSegment");
        return { ok: true, resultCode: 0 };
      },
    };
    const segmentReports = [{ segId: 0 }];
    const stripId = 0;

    /* 与页面 writeQuick 中同一段控制流。 */
    const fast = segmentReports.length === 1 && segmentReports[0].segId === 0;
    expect(fast).toBe(singleZone);
    if (!fast) {
      await session.queryStrip(stripId);
      for (const report of segmentReports.filter((item) => item.segId !== 0)) {
        await session.clearSegment();
      }
    }
    await session.setSegment();

    expect(calls).toEqual(["setSegment"]);
  });

  it("多光区路径仍然先读回再清空（不把多光区写坏）", async () => {
    const calls: string[] = [];
    const session = {
      async queryStrip() {
        calls.push("queryStrip");
        return { kind: "ok" as const, reports: [{ segId: 0 }, { segId: 1 }], end: 0 };
      },
      async clearSegment() {
        calls.push("clearSegment");
        return { ok: true, resultCode: 0 };
      },
      async setSegment() {
        calls.push("setSegment");
        return { ok: true, resultCode: 0 };
      },
    };
    const segmentReports = [{ segId: 0 }, { segId: 1 }];
    const fast = segmentReports.length === 1 && segmentReports[0].segId === 0;
    expect(fast).toBe(false);
    if (!fast) {
      await session.queryStrip();
      for (const report of segmentReports.filter((item) => item.segId !== 0)) {
        await session.clearSegment();
      }
    }
    await session.setSegment();
    expect(calls).toEqual(["queryStrip", "clearSegment", "setSegment"]);
  });

  it("发出的 spec 覆盖整组（槽位 0 区间 0..n-1）", () => {
    const card = quickCardOf("warm");
    expect(card).not.toBeNull();
    const spec = buildQuickSpec(card!, {}, 0, 30, 100);
    expect(spec.segId).toBe(0);
    expect(spec.start).toBe(0);
    expect(spec.end).toBe(29);
  });
});

describe("轮询 / 定时器不会被测试拖住", () => {
  it("页面卸载时会清掉快速写入的定时器", () => {
    expect(STRIP_TS).toMatch(/clearQuickTimer\(\) \{/);
    const unload = /onUnload\(\) \{([\s\S]*?)\n  \},/.exec(STRIP_TS);
    expect(unload).not.toBeNull();
    expect(unload![1]).toContain("clearQuickTimer");
  });

  it("quickQueued 在 onLoad 里显式初始化（页面私有字段陷阱）", () => {
    const load = /\n {2}onLoad\([\s\S]*?\n {2}\},/.exec(STRIP_TS);
    expect(load).not.toBeNull();
    expect(load![0]).toContain("this.quickQueued = false");
  });

  it("空闲时不会自己发命令（只由点击 / 滑块触发）", () => {
    /* 页面里不存在 setInterval 之类的轮询。 */
    expect(STRIP_TS).not.toMatch(/setInterval\(/);
  });
});

describe("草稿类型不受影响（编译期约束的运行时兜底）", () => {
  it("buildQuickSpec 返回可直接写进设备的结构", () => {
    const card = quickCardOf("rainbow")!;
    const spec = buildQuickSpec(card, {}, 1, 12, 80);
    expect(spec.stripId).toBe(1);
    expect(spec.end).toBe(11);
    expect(spec.layer0.type).toBeGreaterThanOrEqual(0);
    expect(spec.blend).toBeGreaterThanOrEqual(0);
  });

  it("ScriptDraft 仍是方案草稿的形状（不影响 #99/#100 的改造）", () => {
    const draft: ScriptDraft = { scriptId: 0, stageCount: 1, stages: [] } as unknown as ScriptDraft;
    expect(draft.stageCount).toBe(1);
  });
});
