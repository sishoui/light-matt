/**
 * 剧本下发的纯逻辑（#32）：把一套「阶段序列」展开成一条**有序命令流**，
 * 并把已确认的帧数换算成进度。
 *
 * 为什么要有这一层：一套 4 阶段剧本是 1 条 Begin + 4 条 Stage + N 条 Segment
 * + 1 条 Commit，十来帧。帧序错了（先 Commit 后 Segment、漏 Stage）设备会
 * 整份拒收；重试时又要从 Begin 重来。把它做成纯函数后，帧序、校验、进度
 * 都能在 vitest 里断言，不需要设备。
 *
 * 依赖方向：本模块只依赖 utils/protocol（命令构造器），不碰 wx / BLE。
 */

import {
  cmdActivateScript,
  cmdScriptAbort,
  cmdScriptBegin,
  cmdScriptCommit,
  cmdScriptSegment,
  cmdScriptStage,
  segmentParamLength,
} from "../protocol/commands";
import { MAX_SCRIPTS, MAX_STAGES, MAX_STAGE_MS, MAX_STRIPS } from "../protocol/constants";
import type { CommandRequest, SegmentConfig } from "../protocol/types";

/** 剧本编辑器里的一个阶段：时长 + 该阶段覆盖的段列表。 */
export interface ScriptStageConfig {
  durationMs: number;
  /**
   * 该阶段的段配置。空数组是合法的（这一阶段整条熄灭），
   * 校验只要求时长非 0。
   */
  segments: SegmentConfig[];
}

/** 一套待下发的剧本。 */
export interface ScriptConfig {
  /** 0-3；同一 id 重新下发会覆盖设备上已提交的那一套（§10.4「重来」）。 */
  scriptId: number;
  /** 1-8 个阶段。 */
  stages: ScriptStageConfig[];
  /** 这套剧本覆盖几条灯带（≤ 设备 State 的 strip_count）。 */
  stripCount: number;
}

export interface ScriptPlanOptions {
  /** 下发完是否 ActivateScript（默认 true：用户点「下发」就是要用它）。 */
  activate?: boolean;
  /** 激活后的 loop 值（默认 true）。 */
  loop?: boolean;
}

/** 下发计划的一步：一条待发命令 + 它属于哪一类（用于进度分组）。 */
export interface ScriptPlanStep {
  kind: "begin" | "stage" | "segment" | "commit" | "activate";
  /** 人类可读标签，直接进进度文案与日志。 */
  label: string;
  request: CommandRequest;
}

export interface ScriptPlan {
  steps: ScriptPlanStep[];
  /**
   * 关键里程碑的下标：Begin / 每个 Stage / Commit / Activate。
   * Segment 是批量部分，进度条按它们的完成数推进，不需要逐帧文案。
   */
  frameCount: number;
}

/** 校验结果：ok 为假时 message 是给用户看的具体原因。 */
export type ScriptValidation =
  | { ok: true }
  | { ok: false; message: string };

/**
 * 严格校验一套剧本（设备侧还会再校验一遍，这里是为了让用户早看到原因，
 * 不要等下发到第 9 帧才收到 InvalidParam）。
 *
 * 规则与设备 commit 的整份校验对齐：
 *  - scriptId 0-3、1-8 个阶段、stripCount 1-8；
 *  - 每阶段时长 1-65535；
 *  - 每段的 strip 在 [0, stripCount)、区间 start ≤ end、type 已知；
 *  - 同一阶段同一灯带内段不重叠（与 SetSegment 的规则一致）；
 *  - segId 在 [0,8)、不重复（重复会让后写入的静默覆盖先写入的）。
 */
export function validateScript(
  script: ScriptConfig,
  ledCounts: number[],
): ScriptValidation {
  if (!Number.isInteger(script.scriptId) || script.scriptId < 0 || script.scriptId >= MAX_SCRIPTS) {
    return { ok: false, message: `剧本编号必须是 0-${MAX_SCRIPTS - 1}，收到 ${script.scriptId}` };
  }
  if (!Number.isInteger(script.stripCount) || script.stripCount < 1 || script.stripCount > MAX_STRIPS) {
    return { ok: false, message: `灯带数必须是 1-${MAX_STRIPS}，收到 ${script.stripCount}` };
  }
  if (script.stages.length < 1 || script.stages.length > MAX_STAGES) {
    return {
      ok: false,
      message: `阶段数必须是 1-${MAX_STAGES}，收到 ${script.stages.length}`,
    };
  }

  for (let stageIndex = 0; stageIndex < script.stages.length; stageIndex += 1) {
    const stage = script.stages[stageIndex];
    const where = `阶段 ${stageIndex + 1}`;
    if (!Number.isInteger(stage.durationMs) || stage.durationMs < 1) {
      return { ok: false, message: `${where}的时长必须 ≥ 1ms` };
    }
    if (stage.durationMs > MAX_STAGE_MS) {
      return { ok: false, message: `${where}的时长超过 ${MAX_STAGE_MS}ms 上限` };
    }

    const segIds = new Set<number>();
    /* 按灯带分别检查区间与重叠（重叠只在同一条灯带内才冲突）。 */
    const byStrip = new Map<number, Array<{ segId: number; start: number; end: number }>>();

    for (const seg of stage.segments) {
      const segWhere = `${where}段 ${seg.segId}`;
      if (segmentParamLength(seg.type) === 0) {
        return { ok: false, message: `${segWhere}的类型 0x${seg.type.toString(16)} 未知` };
      }
      if (!Number.isInteger(seg.stripId) || seg.stripId < 0 || seg.stripId >= script.stripCount) {
        return { ok: false, message: `${segWhere}引用了不存在的灯带 ${seg.stripId}` };
      }
      if (!Number.isInteger(seg.segId) || seg.segId < 0 || seg.segId >= 8) {
        return { ok: false, message: `${segWhere}的槽位必须是 0-7` };
      }
      if (segIds.has(seg.segId)) {
        return { ok: false, message: `${segWhere}的槽位重复（同一阶段内 seg_id 必须唯一）` };
      }
      segIds.add(seg.segId);
      if (!Number.isInteger(seg.start) || !Number.isInteger(seg.end) || seg.start < 0 || seg.start > seg.end) {
        return { ok: false, message: `${segWhere}的区间非法（${seg.start}-${seg.end}）` };
      }
      const ledCount = ledCounts[seg.stripId] ?? 0;
      if (ledCount > 0 && seg.end >= ledCount) {
        return {
          ok: false,
          message: `${segWhere}的终点 ${seg.end} 超出灯带 ${seg.stripId} 的灯珠数 ${ledCount}`,
        };
      }
      const list = byStrip.get(seg.stripId) ?? [];
      list.push({ segId: seg.segId, start: seg.start, end: seg.end });
      byStrip.set(seg.stripId, list);
    }

    for (const [stripId, list] of byStrip) {
      for (let a = 0; a < list.length; a += 1) {
        for (let b = a + 1; b < list.length; b += 1) {
          const x = list[a];
          const y = list[b];
          if (!(x.end < y.start || y.end < x.start)) {
            return {
              ok: false,
              message: `${where}灯带 ${stripId} 的段 ${x.segId} 与 ${y.segId} 区间重叠`,
            };
          }
        }
      }
    }
  }

  return { ok: true };
}

/**
 * 把一套剧本展开成有序命令流。
 *
 * 顺序严格按 §10.4：
 *   ScriptBegin → (ScriptStage, ScriptSegment…) × 阶段数 → ScriptCommit
 *   → [ActivateScript]
 *
 * **Boundary 在最后**：Commit 之前设备只动暂存区，所以中途任何一帧被拒
 * 都可以直接 Abort，已提交的旧剧本不受影响——这就是「下发失败保留上一套」
 * 的实现基础。
 *
 * 调用方必须先 validateScript；这里遇到非法输入直接抛（构造器本身也会抛）。
 */
export function buildScriptPlan(script: ScriptConfig, opts: ScriptPlanOptions = {}): ScriptPlan {
  const steps: ScriptPlanStep[] = [];

  steps.push({
    kind: "begin",
    label: `准备剧本 ${script.scriptId}（${script.stages.length} 阶段 / ${script.stripCount} 灯带）`,
    request: cmdScriptBegin(script.scriptId, script.stages.length, script.stripCount),
  });

  script.stages.forEach((stage, stageIndex) => {
    steps.push({
      kind: "stage",
      label: `阶段 ${stageIndex + 1} 时长 ${stage.durationMs}ms`,
      request: cmdScriptStage(script.scriptId, stageIndex, stage.durationMs),
    });
    /* 段按 (strip, seg) 升序下发：与设备的槽位语义一致，帧序可复现。 */
    const ordered = [...stage.segments].sort(
      (a, b) => a.stripId - b.stripId || a.segId - b.segId,
    );
    for (const seg of ordered) {
      steps.push({
        kind: "segment",
        label: `阶段 ${stageIndex + 1} 段 ${seg.segId}（${seg.start}-${seg.end}）`,
        request: cmdScriptSegment(script.scriptId, stageIndex, seg),
      });
    }
  });

  steps.push({
    kind: "commit",
    label: `提交剧本 ${script.scriptId}`,
    request: cmdScriptCommit(script.scriptId),
  });

  if (opts.activate !== false) {
    steps.push({
      kind: "activate",
      label: `激活剧本 ${script.scriptId}${opts.loop === false ? "（播一次）" : "（循环）"}`,
      request: cmdActivateScript(script.scriptId, opts.loop !== false),
    });
  }

  return { steps, frameCount: steps.length };
}

/** 下发中途失败时用来清暂存（不需要等下发完）。 */
export function buildAbort(scriptId: number): CommandRequest {
  return cmdScriptAbort(scriptId);
}

/** 进度快照：给 UI 直接用的比例与文案。 */
export interface ScriptProgressView {
  /** 已完成帧数（含当前这一帧的 ACK）。 */
  done: number;
  total: number;
  /** 0-100 整数，供进度条与文本共用。 */
  percent: number;
  /** 当前 / 刚完成的那一步的标签；全部完成时为「完成」。 */
  label: string;
  /** 全部帧已确认。 */
  complete: boolean;
}

/**
 * 由「已完成帧数」算出进度视图。
 *
 * 进度以**每帧 ACK 为权威**（§10.4）：done 是调用方数出来的 ACK 数。
 * 设备侧的 ScriptProgress(0x86) 只是补充证据，不参与这里的计算——
 * 它每 8 帧才来一条，用它会跳格。
 */
export function scriptProgressView(plan: ScriptPlan, done: number): ScriptProgressView {
  const total = plan.frameCount;
  const clamped = Math.max(0, Math.min(done, total));
  const complete = clamped >= total;
  const percent = total === 0 ? 100 : Math.round((clamped * 100) / total);
  let label = "完成";
  if (!complete) {
    /* done = 已完成的帧数 → 当前正在发的是下标 done 那一帧。 */
    label = plan.steps[clamped]?.label ?? "下发中";
  }
  return { done: clamped, total, percent, label, complete };
}
