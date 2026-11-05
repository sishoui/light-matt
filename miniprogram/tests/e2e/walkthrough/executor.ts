/**
 * 走查用例组的执行器（#128）。
 *
 * 纯函数：不 import vitest、不碰 wx、不碰 BLE。它只回答三个问题——
 * 这一行长什么样、这一行过没过、这张表自己有没有毛病。
 *
 * 之所以单独一层：失败行的形状是全表的承诺。先有它，写 20 行时才知道
 * 失败长什么样；把它写进测试文件里，形状会随每条用例各漂一次。
 */

import {
  type ActContext,
  type Judgement,
  type ObserveContext,
  type Outcome,
  type RowState,
  type Sample,
  type Step,
  type StepResult,
} from "./types";

/**
 * 发现位数量。规格 #127 的「12 处对不上」——其中 4 处已并入他票，
 * 所以 12 个断言位落在 8 个仍然存在的票号上。
 *
 * 写死在这里而不是数票号：有人删掉一行、把「12 项证据」缩成 11 项时，
 * 整组要在**碰设备之前**报错。
 */
export const FINDING_COUNT = 12;

/** 值的单行渲染：字符串不加引号（它本身就是一句话），其余走 JSON。 */
function fmt(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 两侧读数的唯一渲染点。
 *
 * ```
 * 界面 page.data home.brightnessPercent=20 · 设备 refreshState brightness/maxBrightness=40/200
 * ```
 */
export function say(sample: Sample): string {
  const ui = `界面 ${sample.ui.from} ${sample.ui.at}=${fmt(sample.ui.value)}`;
  const device = `设备 ${sample.device.from} ${sample.device.at}=${fmt(sample.device.value)}`;
  return `${ui} · ${device}`;
}

/** 归因说人话：谁错、另一侧为什么可以信。 */
function blameText(blame: "ui" | "device" | "both"): string {
  if (blame === "ui") {
    return "界面错（设备是对的）";
  }
  if (blame === "device") {
    return "设备错（界面是对的）";
  }
  return "两侧都错";
}

/** 失败行：`say` 后面接归因，一行说完。 */
export function failedLine(step: Step, sample: Sample, j: Judgement): string {
  const head = step.ticket === undefined ? step.id : `${step.ticket} ${step.id}`;
  if (j.agrees) {
    return `${head}：${say(sample)} → 两侧一致，但这一行要求分歧仍在（该摘掉 known-divergence 标记了）`;
  }
  return `${head}：${say(sample)} → ${blameText(j.blame)}；${j.why}`;
}

/**
 * 用例名。已知分歧加前缀：终端与报告里一眼看出这条今天预期失败。
 *
 * ```
 * [已知分歧 #130] 掉线回连之后，首页电源键仍能关灯
 * ```
 */
export function titleOf(step: Step): string {
  if (step.expectation.kind === "known-divergence") {
    return `[已知分歧 ${step.expectation.ticket}] ${step.does}`;
  }
  return step.does;
}

/**
 * 判定映射。四种组合，四种都不同：
 *
 * | expectation \ 分歧 | 仍在 | 已消失 |
 * |---|---|---|
 * | must-hold         | passed | failed |
 * | known-divergence  | quarantined | failed |
 *
 * 最后那格是刻意的：票修好了，这一行必须变红，逼你摘掉标记。
 * 否则「已修」会被一条永远跳过的用例永久掩护。
 */
export function judge(step: Pick<Step, "expectation">, j: Judgement): Outcome {
  if (step.expectation.kind === "must-hold") {
    return j.agrees ? "passed" : "failed";
  }
  return j.agrees ? "failed" : "quarantined";
}

/** 表自身的毛病。返回空数组 = 这张表可以拿去碰设备。 */
export function validateTable(steps: readonly Step[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const [index, step] of steps.entries()) {
    const where = `第 ${index + 1} 行（${step.id || "无 id"}）`;

    if (typeof step.id !== "string" || step.id.trim().length === 0) {
      problems.push(`${where}：id 不能为空`);
    } else if (seen.has(step.id)) {
      problems.push(`${where}：id 重复`);
    } else {
      seen.add(step.id);
    }

    if (typeof step.does !== "string" || step.does.trim().length === 0) {
      problems.push(`${where}：does（用例名）不能为空`);
    }
    if (typeof step.act !== "function") {
      problems.push(`${where}：act 必须是函数`);
    }
    if (typeof step.observe !== "function") {
      problems.push(`${where}：observe 必须是函数`);
    }
    if (typeof step.compare !== "function") {
      problems.push(`${where}：compare 必须是函数`);
    }
    if (step.kind !== "step" && step.kind !== "probe" && step.kind !== "settle") {
      problems.push(`${where}：kind 必须是 step / probe / settle`);
    }
    if (step.ticket !== undefined && !/^#\d+$/.test(step.ticket)) {
      problems.push(`${where}：ticket 必须是 "#数字"，收到 ${String(step.ticket)}`);
    }

    if (step.expectation.kind === "known-divergence") {
      if (!/^#\d+$/.test(step.expectation.ticket)) {
        problems.push(`${where}：known-divergence 的 ticket 必须是 "#数字"`);
      }
      if (step.expectation.ticket !== step.ticket) {
        problems.push(
          `${where}：known-divergence 票号 ${step.expectation.ticket} 与 ticket 字段 ${String(step.ticket)} 不一致`,
        );
      }
      if (step.expectation.note.trim().length === 0) {
        problems.push(`${where}：known-divergence 必须写 note（说明分歧在哪一侧）`);
      }
      /* 已知分歧只能挂在自清理的 probe 上：它会中途离开现场，而
       * 「逐带段数回到 0」正是靠 step 行的现场连续性守住的。 */
      if (step.kind !== "probe") {
        problems.push(`${where}：known-divergence 只能挂在 probe 行上（当前是 ${step.kind}）`);
      }
    }
  }

  const settleIndexes = steps.map((step, index) => (step.kind === "settle" ? index : -1)).filter((i) => i >= 0);
  if (settleIndexes.length === 0) {
    problems.push("缺少 settle 行：设备现场没有收尾断言");
  } else if (settleIndexes.length > 1) {
    problems.push(`settle 行只能有一条，实际 ${settleIndexes.length} 条`);
  } else if (settleIndexes[0] !== steps.length - 1) {
    problems.push("settle 行必须最后一行");
  }

  const findingSlots = steps.filter((step) => step.ticket !== undefined).length;
  if (findingSlots !== FINDING_COUNT) {
    problems.push(`发现位必须是 ${FINDING_COUNT} 个，实际 ${findingSlots} 个`);
  }

  return problems;
}

function result(step: Step, outcome: Outcome, line: string, sample: Sample | null): StepResult {
  return { id: step.id, outcome, line, expectation: step.expectation, sample };
}

/**
 * 跑一行。
 *
 * 已知分歧的 probe 行照常跑、照常留读数，只是结局记为 quarantined——今天
 * 的 12 条发现全是这种。它们开工前先 `neutralise()`，所以一条脏了的
 * known-bad 不会把后面的故事跑在别人的残留上。
 */
export async function runStep(
  step: Step,
  ctx: { act: ActContext; observe: ObserveContext },
  row: RowState,
): Promise<StepResult> {
  /* 前面某条 step 行中途失败：现场已经不在故事线上，继续跑只会得到
   * 一条误导的失败。probe 与 settle 仍然跑——前者自己复位，后者负责收尾。 */
  if (row.blockedBy !== null && step.kind === "step") {
    return result(step, "skipped", `${step.id}：上一行 ${row.blockedBy} 失败，这一步跳过`, null);
  }

  if (step.kind === "probe") {
    await ctx.act.neutralise();
  }

  try {
    await step.act(ctx.act);
    await step.settle?.(ctx.act);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (step.kind === "step") {
      row.blockedBy = step.id;
    }
    return result(step, "failed", `${step.id}：操作没跑通 → ${why}`, null);
  }

  let sample: Sample;
  try {
    sample = await step.observe(ctx.observe);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (step.kind === "step") {
      row.blockedBy = step.id;
    }
    return result(step, "failed", `${step.id}：读数失败 → ${why}`, null);
  }

  const judgement = step.compare(sample);
  const outcome = judge(step, judgement);

  if (outcome === "failed") {
    if (step.kind === "step") {
      row.blockedBy = step.id;
    }
    return result(step, "failed", failedLine(step, sample, judgement), sample);
  }

  return result(step, outcome, `${step.id}：${say(sample)}`, sample);
}
