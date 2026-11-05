/**
 * 走查用例组的数据形状（#128）。
 *
 * 这张表的每一行都是「界面说了什么」与「设备做了什么」的**一对**读数。
 * 类型上不存在只有界面的样本——这是「每条断言同时记录两侧」的结构化落点，
 * 不是一句约定。
 *
 * 本文件零运行时依赖：全部 import 都是 `import type`，编译后整份消失。
 */

import type { DeviceInfo, DeviceState, LinkState, SegmentReport } from "../../../utils/protocol/types";
import type { ScriptConfig } from "../../../utils/control/script-plan";

/** 票号锚点。写 `"130"` 或 `"# 130"` 都编译不过。 */
export type Ticket = `#${number}`;

/** 界面侧读数只有一个来源：页面派生出来的 `data`。 */
export type UiOrigin = "page.data";

/** 设备侧读数的来源。写进失败行，让人知道这个值有多可信。 */
export type DeviceOrigin =
  | "refreshState"
  | "queryStrip"
  | "lastDownloadedScript"
  | "frameLog"
  /** 设备侧「协议里没有这个能力」——它是一条设备事实，不是缺席。 */
  | "capability";

export interface Reading<S extends "ui" | "device", O extends string, T> {
  readonly side: S;
  readonly from: O;
  /** 人读的位置，例如 `"home.brightnessPercent"`。 */
  readonly at: string;
  readonly value: T;
}

export const uiReading = <T>(at: string, value: T): Reading<"ui", UiOrigin, T> => ({
  side: "ui",
  from: "page.data",
  at,
  value,
});

/**
 * 收尾行的一侧读数：走查**开始时**记下的设备现场。
 *
 * 它不是页面 `data`，所以不能冒充 `page.data`——`say` 会照实打印
 * `snapshot <位置>=<值>`，读的人一眼看出这一行在比「原样」而不是「界面」。
 */
export const snapshotReading = <T>(at: string, value: T): Reading<"ui", "snapshot", T> => ({
  side: "ui",
  from: "snapshot",
  at,
  value,
});

export const deviceReading = <O extends DeviceOrigin, T>(
  from: O,
  at: string,
  value: T,
): Reading<"device", O, T> => ({ side: "device", from, at, value });

/** 一次比较。两侧都必填。 */
export interface Sample<U = unknown, D = unknown> {
  readonly ui: Reading<"ui", string, U>;
  readonly device: Reading<"device", DeviceOrigin, D>;
}

/** 设备侧「这个能力不存在」的结构化说法（发现 6 用）。 */
export interface Capability {
  readonly kind: "capability";
  /** 缺的是什么。 */
  readonly absent: string;
  /** 空串表示真的做不到；非空表示可以借哪条现有能力表达。 */
  readonly via: string;
}

export const capability = (absent: string, via = ""): Capability => ({ kind: "capability", absent, via });

/** 「哪边错了」是结构化答案，不是形容词。 */
export type Judgement =
  | { readonly agrees: true }
  | {
      readonly agrees: false;
      readonly blame: "ui" | "device" | "both";
      readonly why: string;
    };

/** 一致。`compare` 的每个「成立」分支都返回这一个对象。 */
export const AGREE: Judgement = { agrees: true };

export type Expectation =
  | { readonly kind: "must-hold" }
  | { readonly kind: "known-divergence"; readonly ticket: Ticket; readonly note: string };

/**
 * 三种行，语义不同（混用是这张表最大的坑）：
 *  - `step`  ：顺序脚本。继承上一步的现场，像真用户一样。
 *  - `probe` ：自包含探针。开工前 `neutralise()`，绝不影响别人。
 *  - `settle`：复位并断言。必须是最后一行。
 */
export type StepKind = "step" | "probe" | "settle";

export type PageName = "home" | "device" | "strip" | "deviceInfo" | "discover";

/** 页面实例（`instantiate()` 的产物：`data` + 被 bind 过的方法）。 */
export interface PageInstance {
  readonly data: Record<string, any>;
  [key: string]: any;
}

export interface PageHandles {
  readonly home: PageInstance;
  readonly device: PageInstance;
  readonly strip: PageInstance;
  readonly deviceInfo: PageInstance;
  readonly discover: PageInstance;
}

/**
 * 触发与等待。
 *
 * **故意没有 `refreshState` / `queryStrip`**：「等用镜像、断言用读回」是
 * grounding 里最容易写错的一条（`deviceState` 是 20Hz 推送的）。想省一次
 * 往返的写法在这里拿不到那个方法。
 */
export interface ActContext {
  readonly pages: PageHandles;
  /** 只让世界发生一件用户在页面上做不到的事。 */
  disturb(kind: "drop-link"): Promise<void>;
  waitLink(state: LinkState, timeoutMs?: number): Promise<void>;
  waitPageReady(page: PageName, timeoutMs?: number): Promise<void>;
  /** 等页面上的某个「忙」标记落下（`applying` / `quickBusy` …）。 */
  waitPageIdle(page: PageName, field: string, timeoutMs?: number): Promise<void>;
  waitMirror(pred: (s: DeviceState) => boolean, label: string, timeoutMs?: number): Promise<void>;
  /** 设备上报的上限（这台是 200，不是 255）。 */
  deviceMaxBrightness(): Promise<number>;
  /** 停播 + 逐带清分区 + 链路不在 ready 时重连。幂等。 */
  neutralise(): Promise<void>;
  restoreDevice(): Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * 读数。
 *
 * **故意没有 `waitMirror`**：这里只做一次确定读回。也没有任何会话写方法——
 * 页面才是唯一的写入方（#114 的教训）。
 */
export interface ObserveContext {
  readonly pages: PageHandles;
  mirror(): DeviceState;
  refreshState(): Promise<DeviceState>;
  queryStrip(stripId: number): Promise<SegmentReport[]>;
  lastScript(): ScriptConfig | null;
  deviceInfo(): DeviceInfo | null;
  /** 连接期那一帧 0x88 的原始载荷（15 字节），#129 的真值。 */
  rawDeviceInfoPayload(): Uint8Array | null;
  linkState(): LinkState;
  queryStateOk(): Promise<boolean>;
  /**
   * 走查开始时的设备现场（归一化之后、第一条用例之前）。
   *
   * 收尾行要断言「回到快照」，而快照是 beforeAll 的产物——读数方只能通过
   * 这个只读出口拿到它，否则就要在断言里写死一个数字。
   */
  snapshot(): RestorePoint;
}

/** 走查开始时的设备现场。收尾行逐项比对，`power` 与 `brightness` 一起。 */
export interface RestorePoint {
  readonly power: 0 | 1;
  readonly brightness: number;
  readonly maxBrightness: number;
  readonly stripPowerMask: number;
  /** 逐带段数（走查前应全为 0）。 */
  readonly stripSegCounts: readonly number[];
  /** 4 个方案槽位的阶段数（判「这套脚本是我们写的」）。 */
  readonly scriptStageCounts: readonly number[];
  /** 循环档（`flags` 的位表）。 */
  readonly loop: 0 | 1 | 2;
  /** 逐带静态分区内容（复位时写回去，走查不该毁掉用户原有的配置）。 */
  readonly segments: readonly SegmentReport[];
}

export interface Step<U = unknown, D = unknown> {
  readonly id: string;
  /**
   * 票号锚点。`known-divergence` 从它取票，`must-hold` 也带上它——
   * 「12 个断言位一个不少」按这个字段数，不按 expectation 的种类数。
   */
  readonly ticket?: Ticket;
  readonly kind: StepKind;
  /** 用户做了什么（中文一句话）。用例名直接用它。 */
  readonly does: string;
  readonly expectation: Expectation;
  readonly act: (ctx: ActContext) => Promise<void>;
  /** 只等落定，不断言。 */
  readonly settle?: (ctx: ActContext) => Promise<void>;
  readonly observe: (ctx: ObserveContext) => Promise<Sample<U, D>>;
  readonly compare: (sample: Sample<U, D>) => Judgement;
}

export type Outcome = "passed" | "quarantined" | "failed" | "skipped";

export interface StepResult {
  readonly id: string;
  readonly outcome: Outcome;
  readonly line: string;
  readonly expectation: Expectation;
  readonly sample: Sample | null;
}

/** 跨行共享的一点点现场知识（第一处失败之后，后面能快速说清为什么跳过）。 */
export interface RowState {
  blockedBy: string | null;
}
