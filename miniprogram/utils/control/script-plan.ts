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
  layerParamLength,
} from "../protocol/commands";
import { isSegmentSpec } from "../protocol/segment-shapes";
import {
  BLEND,
  LOOP,
  type LoopMode,
  MAX_SCRIPTS,
  MAX_STAGES,
  MAX_STAGE_MS,
  MAX_STRIPS,
  MAX_SEGMENTS,
  NO_EFFECT,
} from "../protocol/constants";
import type { CommandRequest, SegmentConfig, SegmentSpec } from "../protocol/types";
import { loopLabel } from "./advanced-layers";

/**
 * 剧本里的一条段：v3 允许两层（`SegmentSpec`），也继续接受扁平草稿
 * （`SegmentConfig`，等效于「只设层 0、blend 覆盖」）。
 *
 * 两种形状由 `isSegmentSpec` 在运行时区分；构造器 `cmdScriptSegment` 也接受
 * 两者，所以这里不做归一化，免得把用户的两层配置悄悄压成一层。
 */
export type ScriptSegment = SegmentConfig | SegmentSpec;

/** 剧本编辑器里的一个阶段：时长 + 该阶段覆盖的段列表。 */
export interface ScriptStageConfig {
  durationMs: number;
  /**
   * 该阶段的段配置。空数组是合法的（这一阶段整条熄灭），
   * 校验只要求时长非 0。
   */
  segments: ScriptSegment[];
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
  /**
   * 激活后的循环模式（0 不循环 / 1 全部循环 / 2 最后一步循环，默认全部循环）。
   *
   * 三值，**不是布尔**（#114）：写成布尔时 `0 !== false` 与 `2 !== false`
   * 都为真，不循环与最后一步循环会被一起判成「全部循环」。
   */
  loop?: LoopMode;
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
 * 一条段的两层类型投影：扁平草稿视为「layer0 = 该层、layer1 = 空、blend 覆盖」。
 *
 * 校验 / 容量预估都只看「层类型」，不需要层里的参数值，所以不必归一化成
 * `SegmentSpec`（那会把页面的临时对象也复制一遍）。
 */
function segmentShape(segment: ScriptSegment): {
  layer0Type: number;
  layer1Type: number;
  blend: number;
} {
  if (isSegmentSpec(segment)) {
    return {
      layer0Type: segment.layer0.type,
      layer1Type: segment.layer1.type,
      blend: segment.blend,
    };
  }
  return { layer0Type: segment.type, layer1Type: NO_EFFECT, blend: BLEND.OVER };
}

/**
 * 严格校验一套剧本（设备侧还会再校验一遍，这里是为了让用户早看到原因，
 * 不要等下发到第 9 帧才收到 InvalidParam）。
 *
 * 规则与设备 commit 的整份校验对齐：
 *  - scriptId 0-3、1-8 个阶段、stripCount 1-8；
 *  - 每阶段时长 1-65535（0 非法：设备会拒，这里先拦）；
 *  - 每段的 strip 在 [0, stripCount)、区间 start ≤ end、层类型已知；
 *  - 同一阶段**同一灯带内**段不重叠（与 SetSegment 的规则一致）；
 *  - segId 在 [0,8)、且按 `(stripId, segId)` 唯一。v3 的槽位是「每条灯带
 *    各 8 个」，8 条带各自用 seg_id 0 是合法的；v2 误按阶段全局唯一，
 *    会让跨带剧本在客户端被无理由拒掉。
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
      return { ok: false, message: `${where}的时长必须 ≥ 1ms（收到 ${stage.durationMs}）` };
    }
    if (stage.durationMs > MAX_STAGE_MS) {
      return { ok: false, message: `${where}的时长超过 ${MAX_STAGE_MS}ms 上限` };
    }

    /* 槽位占用按灯带分别记：不同灯带的同号槽位互不冲突。 */
    const usedSlots = new Map<number, Set<number>>();
    const byStrip = new Map<number, Array<{ segId: number; start: number; end: number }>>();

    for (const segment of stage.segments) {
      const shape = segmentShape(segment);
      const segRaw = segment as Partial<SegmentConfig & SegmentSpec>;
      const stripId = segRaw.stripId as number;
      const segId = segRaw.segId as number;
      const start = segRaw.start as number;
      const end = segRaw.end as number;
      const segWhere = `${where}段 ${segId}`;

      if (layerParamLength(shape.layer0Type) === 0 || shape.layer0Type === NO_EFFECT) {
        return { ok: false, message: `${segWhere}的层 0 类型 0x${shape.layer0Type.toString(16)} 非法` };
      }
      if (shape.layer1Type !== NO_EFFECT && layerParamLength(shape.layer1Type) === 0) {
        return { ok: false, message: `${segWhere}的层 1 类型 0x${shape.layer1Type.toString(16)} 未知` };
      }
      if (shape.layer1Type === NO_EFFECT && shape.blend !== BLEND.OVER) {
        return { ok: false, message: `${segWhere}的层 1 为空时 blend 必须为覆盖` };
      }
      if (!Number.isInteger(stripId) || stripId < 0 || stripId >= script.stripCount) {
        return { ok: false, message: `${segWhere}引用了不存在的灯带 ${stripId}` };
      }
      if (!Number.isInteger(segId) || segId < 0 || segId >= MAX_SEGMENTS) {
        return { ok: false, message: `${segWhere}的槽位必须是 0-${MAX_SEGMENTS - 1}` };
      }
      const slots = usedSlots.get(stripId) ?? new Set<number>();
      if (slots.has(segId)) {
        return {
          ok: false,
          message: `${segWhere}的槽位重复（同一阶段同一灯带内 seg_id 必须唯一）`,
        };
      }
      slots.add(segId);
      usedSlots.set(stripId, slots);

      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end) {
        return { ok: false, message: `${segWhere}的区间非法（${start}-${end}）` };
      }
      const ledCount = ledCounts[stripId] ?? 0;
      if (ledCount > 0 && end >= ledCount) {
        return {
          ok: false,
          message: `${segWhere}的终点 ${end} 超出灯带 ${stripId} 的灯珠数 ${ledCount}`,
        };
      }
      const list = byStrip.get(stripId) ?? [];
      list.push({ segId, start, end });
      byStrip.set(stripId, list);
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
      /* fade_ms 是格式预留（caps.bit1 == 0），恒定 0，界面也不给过渡入口。 */
      request: cmdScriptStage(script.scriptId, stageIndex, stage.durationMs, 0),
    });
    /* 段按 (strip, seg) 升序下发：与设备的槽位语义一致，帧序可复现。 */
    const ordered = [...stage.segments].sort(
      (a, b) => a.stripId - b.stripId || a.segId - b.segId,
    );
    for (const seg of ordered) {
      steps.push({
        kind: "segment",
        label:
          `阶段 ${stageIndex + 1} 灯带 ${seg.stripId + 1} 段 ${seg.segId}` +
          `（${seg.start}-${seg.end}）`,
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
    /* 文案与载荷来自**同一个**规范化值：分头推导时连两者都可能不一致。 */
    const loop: LoopMode = opts.loop ?? LOOP.ALL;
    steps.push({
      kind: "activate",
      label: `激活剧本 ${script.scriptId}（${loopLabel(loop)}）`,
      request: cmdActivateScript(script.scriptId, loop),
    });
  }

  return { steps, frameCount: steps.length };
}

/** 下发中途失败时用来清暂存（不需要等下发完）。 */
export function buildAbort(scriptId: number): CommandRequest {
  return cmdScriptAbort(scriptId);
}

/* ---------------- 容量预检（§10.4，v4 记录宽度） ---------------- */

/**
 * 剧本 blob 的持久化上限（protocol-v3.md §10.4 / firmware script_blob.h）。
 *
 * 这是设备的硬限制：`ScriptCommit` 编码后超过它就回 `ScriptTooLarge (0x0A)`
 * 且**不提交**。App 用同一公式在上报前预估，绝不等报到一半才失败。
 */
export const SCRIPT_BLOB_MAX_BYTES = 16384;

/** 超限时给用户的一句话（页面与日志共用，措辞固定便于用例断言）。 */
export const SCRIPT_TOO_LARGE_HINT = "剧本过大，请减少阶段数/段数/灯带数";

/** blob 头：magic 4 + version 2 + active 1 + flags 1。 */
const SCRIPT_BLOB_HEADER_BYTES = 8;
/** 每个剧本槽位头：committed 1 + stage_count 1 + strip_count 1。 */
const SCRIPT_SLOT_HEADER_BYTES = 3;
/** 每阶段头：duration(2) + fade(2)。 */
const SCRIPT_STAGE_HEADER_BYTES = 4;

/**
 * 一层在脚本 blob 里的宽度（firmware script_blob.c 的 `layer_wire_len`）：
 *
 *   - 空层：只有 type 1 字节（level 恒 0，**不写**）；
 *   - 非空层：type 1 + 该类型的**有效**参数 + **level 1**（v4 新增）。
 *
 * 注意这与线上定宽 9 字节的层编码不同：blob 是变长稀疏编码，所以同一个剧本
 * 的「下发字节数」与「持久化字节数」不是一回事。
 */
function layerBlobBytes(type: number): number {
  if (type === NO_EFFECT) {
    return 1;
  }
  return 1 + layerParamLength(type) + 1;
}

/**
 * 一条段记录的持久化宽度（firmware script_blob.c 的 `segment_record_len`）：
 *
 *   `3 + blobWidth(layer0) + blobWidth(layer1)`
 *
 * 记录头 3（start/end/blend）。v4 在每条**非空**层多一个 level 字节，所以记录
 * 宽度上限从 19 升到 21（`LUMEN_SCRIPT_SEGMENT_MAX` 同样是 21）。
 */
export function scriptSegmentRecordBytes(segment: ScriptSegment): number {
  const shape = segmentShape(segment);
  return 3 + layerBlobBytes(shape.layer0Type) + layerBlobBytes(shape.layer1Type);
}

/** 一套剧本的容量预估（分量 + 总量 + 是否超限）。 */
export interface ScriptCapacityEstimate {
  /** 段记录字节合计（文档表格的「单套」列只算这个 + maskBytes）。 */
  recordBytes: number;
  /** 每阶段每条灯带的 seg_mask 字节合计。 */
  maskBytes: number;
  /** 每阶段 4 字节头合计。 */
  stageBytes: number;
  /** 文档表格口径：recordBytes + maskBytes（不含阶段头与槽位头）。 */
  tableBytes: number;
  /** 与固件 encode 完全一致的总字节（含 blob 头与槽位头）。 */
  total: number;
  /** total > SCRIPT_BLOB_MAX_BYTES。 */
  overLimit: boolean;
}

/**
 * 预估**单套**剧本的持久化尺寸。
 *
 * 只统计「会写进 blob 的活动段」：空阶段仍占 4 字节阶段头 + 每条灯带 1 字节
 * mask（固件对每个 stage 都写这两段），这一点在估算里必须体现，否则
 * 8 阶段 × 8 带的空剧本会被低估 320 字节。
 */
export function estimateScriptBlob(script: ScriptConfig): ScriptCapacityEstimate {
  const stripCount = Math.max(1, Math.min(script.stripCount, MAX_STRIPS));
  let recordBytes = 0;
  let maskBytes = 0;
  let stageBytes = 0;

  for (const stage of script.stages) {
    stageBytes += SCRIPT_STAGE_HEADER_BYTES;
    maskBytes += stripCount;
    for (const segment of stage.segments) {
      recordBytes += scriptSegmentRecordBytes(segment);
    }
  }

  const tableBytes = recordBytes + maskBytes;
  const total = SCRIPT_BLOB_HEADER_BYTES + SCRIPT_SLOT_HEADER_BYTES + stageBytes + tableBytes;
  return {
    recordBytes,
    maskBytes,
    stageBytes,
    tableBytes,
    total,
    overLimit: total > SCRIPT_BLOB_MAX_BYTES,
  };
}

/** 单套剧本的精确持久化字节（页面展示与预检共用的简写）。 */
export function estimateScriptBlobBytes(script: ScriptConfig): number {
  return estimateScriptBlob(script).total;
}

/** 一个已提交槽位在 blob 里占的字节（不含 8 字节 blob 头）。 */
export function scriptBlobSlotBytes(script: ScriptConfig): number {
  const estimate = estimateScriptBlob(script);
  return SCRIPT_SLOT_HEADER_BYTES + estimate.stageBytes + estimate.tableBytes;
}

/**
 * 设备上**全部已提交剧本**合计的持久化字节（§10.4：上限是整套 blob，
 * 不是单套）。未提交的槽位只占 1 字节 `committed = 0`。
 *
 * 下发的剧本替换同 id 的旧剧本，但 `checkScriptCapacity` 的入参是
 * 「下发后设备上会有的那几套」——调用方负责把被替换的那套剔掉。
 */
export function estimateScriptsTotalBytes(scripts: ScriptConfig[]): number {
  let total = SCRIPT_BLOB_HEADER_BYTES;
  for (const script of scripts) {
    total += scriptBlobSlotBytes(script);
  }
  return total;
}

/** 容量预检结果（ok 为假时 message 是给用户看的具体原因）。 */
export type ScriptCapacityCheck =
  | { ok: true; bytes: number; limit: number }
  | { ok: false; bytes: number; limit: number; message: string };

/** 按总字节判定（调用方已把各槽位字节加好；8 字节 blob 头只算一次）。 */
export function checkScriptBlobBytes(bytes: number): ScriptCapacityCheck {
  if (bytes > SCRIPT_BLOB_MAX_BYTES) {
    return {
      ok: false,
      bytes,
      limit: SCRIPT_BLOB_MAX_BYTES,
      message: `${SCRIPT_TOO_LARGE_HINT}（预估 ${bytes} 字节，设备上限 ${SCRIPT_BLOB_MAX_BYTES} 字节）；本次未下发，设备配置未改变`,
    };
  }
  return { ok: true, bytes, limit: SCRIPT_BLOB_MAX_BYTES };
}

/**
 * 下发前的容量预检（§10.4）。
 *
 * 入参是「这次下发后设备上会有的全部已提交剧本」：预检必须按**整套 blob**
 * 判定，因为设备的 16KB 是 4 个槽位共享的——单套 9.8KB 合法，凑到 4 套就超。
 * 非法的剧本（时长为 0 等）应由 validateScript 先拦，这里只量尺寸。
 */
export function checkScriptCapacity(scripts: ScriptConfig[]): ScriptCapacityCheck {
  return checkScriptBlobBytes(estimateScriptsTotalBytes(scripts));
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
