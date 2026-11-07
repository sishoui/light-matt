/** 协议层与界面层共用的数据类型（docs/protocol-v5.md §7）。 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * 一步的一层灯效（§7.1 的 9 字节定宽编码在内存里的形状）。
 *
 * 参数语义沿用 effects-spec §2：`p5` 按 type 解释为 min_level / span / tail；
 * 静态层的 periodMs / p5 / flags 恒为 0。空层用 `type = NO_EFFECT`（0xFF）。
 *
 * `level`（0-100）是本层亮度档位：100 为满亮、0 表示这一层不出光；
 * 呼吸谷底 = `level × p5%`。空层的 `level` 必须为 0。
 */
export interface EffectLayer {
  /** EFFECT_TYPE.*，或 NO_EFFECT（0xFF）表示该层为空。 */
  type: number;
  /** 色相 0-65535。 */
  hue: number;
  /** 饱和度 0-255。 */
  sat: number;
  /** 周期毫秒；静态层恒 0。 */
  periodMs: number;
  /** min_level / span / tail，按 type 解释；静态层恒 0。 */
  p5: number;
  /** 动画类 flags；静态层恒 0。 */
  flags: number;
  /** 本层亮度档位 0-100（100 满亮、0 不出光）。空层必须为 0。 */
  level: number;
}

/**
 * 空层常量。构造器与解析器共用，避免各处手写 0xFF。
 *
 * 空层的 9 字节编码必须全 0（type 除外），所以 `level` 也是 0——带非零亮度
 * 的空层会被设备回 `InvalidParam`（§7.1 第 3 步）。
 */
export const EMPTY_EFFECT: EffectLayer = {
  type: 0xff,
  hue: 0,
  sat: 0,
  periodMs: 0,
  p5: 0,
  flags: 0,
  level: 0,
};

/**
 * 一个步骤：时长 + 两层。
 *
 * **混合方式不在线上**（§6.2）：`layer1` 为空 → 覆盖；非空 → 按亮度叠加。
 * 所以这里没有 blend 字段——它是从「有没有叠加层」推出来的。
 */
export interface SceneStep {
  /** 场景号 0-2。 */
  sceneId: number;
  /** 灯组号 0-7。 */
  stripId: number;
  /** 部位号 0-7（该链内）。 */
  partId: number;
  /** 步号 0-7。 */
  stepIndex: number;
  /** 100-60000 毫秒。 */
  durationMs: number;
  /** 底层，不得为空。 */
  layer0: EffectLayer;
  /** 叠加层；`type = NO_EFFECT` 表示不使用。 */
  layer1: EffectLayer;
}

/**
 * 一个部位在某链上的「灯珠划分」（布局族，§7.2）。
 *
 * 一个部位 = 若干**闭区间**灯珠段；同部位的多段完全共享全部参数（S5）。
 * 一颗灯珠只属一个部位（S3），未覆盖的灯珠恒黑。
 */
export interface LayoutPart {
  stripId: number;
  /** 部位号 0-7（该链内）。 */
  partId: number;
  /** 名字字节数 0-24。 */
  nameLen: number;
  /** 部位名（UTF-8 解出的文本）。 */
  name: string;
  /** 灯珠段数 0-8。 */
  segCount: number;
  /**
   * 相位模式 0-1（S6）：0 连续 / 1 各自起点。
   *
   * 每部位一份，随 LayoutPart 下发并写进布局 blob，所以断电重启后仍在。
   */
  phase: number;
  /** 8 对闭区间 [start, end]；只有前 segCount 个有效。 */
  segs: Array<[number, number]>;
}

/** 一条 LayoutReport 0x89。 */
export type LayoutReport = LayoutPart;

/** 一条 LayoutListEnd 0x8A：某链的部位位图。 */
export interface LayoutListEnd {
  stripId: number;
  /** bit i = 部位 i 有段（`QueryLayout` 只报有段的部位）。 */
  partMask: number;
}

/** 一条布局读回（QueryLayout 的两段收尾组成）。 */
export interface LayoutReadback {
  stripId: number;
  parts: LayoutPart[];
  partMask: number;
}

/** ScenePartReport 0x8B：一个部位的时间轴头。 */
export interface ScenePartReport {
  sceneId: number;
  stripId: number;
  partId: number;
  /** 0-8；0 = 本场景不演（恒黑，S10）。 */
  stepCount: number;
  /** 循环三值（§7.5）。 */
  loop: number;
  /** 部位开关（属于场景，不属于布局，T9）。 */
  on: boolean;
}

/** SceneStepReport 0x8C：与 SceneStep 同构（方向相反）。 */
export type SceneStepReport = SceneStep;

/** SceneListEnd 0x8D：场景读回的收尾（场景 id 与名字）。 */
export interface SceneListEnd {
  sceneId: number;
  nameLen: number;
  name: string;
}

/** 一份完整的场景读回（QueryScene 的三段组成）。 */
export interface SceneReport {
  sceneId: number;
  name: string;
  parts: ScenePartReport[];
  steps: SceneStepReport[];
}

/** StripConfigReport 0x87 的一条记录（§7.4）。 */
export interface StripConfigChannel {
  /** 灯带号 0-7。 */
  stripId: number;
  /** 构建期 Kconfig 决定的引脚；未分配时为 0xFF。协议只读，不能改。 */
  gpio: number;
  /** bit0 = 该路已分配（i < strip_count）；bit1-7 保留 = 0。 */
  flags: number;
  /** flags bit0 的便捷投影。 */
  assigned: boolean;
}

/** StripConfigReport 0x87 的整条报告：固定 8 路。 */
export interface StripConfig {
  channels: StripConfigChannel[];
}

/** DeviceInfoReport 0x88（§7.4）。 */
export interface DeviceInfo {
  /** major<<8 | minor；v5 = 0x0500。 */
  firmwareVersion: number;
  firmwareMajor: number;
  firmwareMinor: number;
  /** 6 字节 BT MAC，按 "AA:BB:CC:DD:EE:FF" 的自然顺序（大写字面量）。 */
  hwId: string;
  maxLeds: number;
  maxStrips: number;
  /** 每条链的部位数。 */
  maxParts: number;
  /** 每个部位的灯珠段数。 */
  maxPartSegs: number;
  /** 每个部位的步骤数。 */
  maxSteps: number;
  maxScenes: number;
  /** bit0 = 支持两层叠加；bit1 = fade 已实现。 */
  caps: number;
  /** caps bit0 的投影。 */
  supportsTwoLayers: boolean;
  /** caps bit1 的投影。 */
  fadeImplemented: boolean;
}

/**
 * 设备 32 字节 State 的内存表示，字段顺序见 docs/protocol-v5.md §7.3。
 *
 * v5 的 State **不含**部位开关（属于场景）、播放位置、颜色摘要。
 * 要部位明细走 `QueryLayout` / `QueryScene`——这是 §9.1 的权威路径。
 */
export interface DeviceState {
  power: 0 | 1;
  /** 已按设备 maxBrightness 钳位后的生效值。 */
  brightness: number;
  /** 滑块上限，不许在 UI 里硬编码 255。 */
  maxBrightness: number;
  /** 1-8，当前配置的灯带数。 */
  stripCount: number;
  /** bit i = 第 i 条灯带的独立开关（实际出光 = power && 对应位）。 */
  stripPowerMask: number;
  /** 当前激活的场景 0-2。 */
  activeScene: number;
  /** 设备上是否有已提交的布局（§6.1）。 */
  layoutValid: boolean;
  /** 每条灯带的灯珠数（u16 × 8）；未使用的槽位为 0。 */
  stripLedCounts: number[];
  /** 每条链的部位数（u8 × 8）；未使用的槽位为 0。 */
  partCounts: number[];
}

/** 一条待下发的命令。payload 由 commands.ts 的构造器生成。 */
export interface CommandRequest {
  command: number;
  payload: Uint8Array;
}

export interface AckResult {
  seq: number;
  /** ACK 载荷第 1 字节：被回执的原命令字。 */
  command: number;
  resultCode: number;
  ok: boolean;
}

/**
 * 连接状态机。`reconnecting` 本票只定义不使用，留给 #11 退避回连。
 */
export type LinkState =
  | "uninitialized"
  | "adapter-off"
  | "idle"
  | "scanning"
  | "connecting"
  | "initializing"
  | "ready"
  | "reconnecting"
  | "failed";

/** 扫描结果：名字优先取扫描响应里的 localName。 */
export interface DiscoveredDevice {
  deviceId: string;
  name: string;
  rssi: number;
}
