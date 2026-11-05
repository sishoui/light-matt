/**
 * 用户走查用例组（#128）。
 *
 * 一条命令跑完一个真实用户在一组页面上的动作：每一步调**页面自己的事件处理器**，
 * 然后读设备真实的 State / QueryStrip / 最近下发方案，把「界面说了什么」与
 * 「设备做了什么」并排记下来。它同时是规格 #127 那 12 项发现的回归证据。
 *
 * 跑法：`node scripts/test-run.mjs ble`（编排器，能报跳过条数），或
 *       `cd miniprogram && npx vitest run --config vitest.e2e.config.ts`
 *
 * 没有真机时**每一条都 skip**，本文件贡献 0 passed。这是硬不变量：编排器按
 * 「至多 1 条通过 + 其余跳过」判 SKIP，本文件只要有一条在无设备时通过，
 * 整层就会被染绿。保证它的只有下面那一个 `for` 循环。
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import { runStep, titleOf, validateTable } from "./walkthrough/executor";
import { WALKTHROUGH } from "./walkthrough/table";
import { bootWorld, type World } from "./walkthrough/world";
import type { RowState } from "./walkthrough/types";

/* 表自身的毛病在**碰设备之前**就要炸：id 重复、已知分歧挂在 step 上、
 * settle 不在最后、发现位不是 12 个，任何一条都让整组立刻失败。 */
const tableProblems = validateTable(WALKTHROUGH);
if (tableProblems.length > 0) {
  throw new Error(`走查表不合法：\n${tableProblems.map((line) => `- ${line}`).join("\n")}`);
}

let world: World | null = null;
const rowState: RowState = { blockedBy: null };

beforeAll(async () => {
  world = await bootWorld();
  if (!world.scanned) {
    console.warn("[walkthrough] 没扫到 Lumen 设备：整组 skip（检查上电 / 是否被别处连着 / 蓝牙适配器）");
  }
}, 240_000);

afterAll(async () => {
  await world?.shutdown();
  world = null;
}, 180_000);

describe("#128 真机走查：界面说的与设备做的", () => {
  for (const step of WALKTHROUGH) {
    it(
      titleOf(step),
      async (ctx) => {
        if (world === null) {
          ctx.skip();
        }
        const live = world as World;
        const gate = live.gate(step);
        if (!gate.run) {
          console.log(`SKIP  ${step.id}：${gate.why}`);
          ctx.skip();
        }

        const result = await runStep(step, live.contexts(), rowState);

        if (result.outcome === "quarantined") {
          /* `ctx.skip()` 不接受参数，所以这条两侧读数只能自己打出来。
           * 不打的话「每条断言同时记录界面值与设备值」只在红行成立，
           * 而 12 条发现全是隔离行。 */
          console.log(`SKIP  ${result.line}`);
          ctx.skip();
        }
        if (result.outcome === "skipped") {
          console.log(`SKIP  ${result.line}`);
          ctx.skip();
        }
        if (result.outcome === "failed") {
          throw new Error(result.line);
        }
        console.log(`PASS  ${result.line}`);
      },
      150_000,
    );
  }
});
