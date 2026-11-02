/** 协议层与界面层共用的数据类型（docs/protocol-v3.md §7）。 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * 一个段的一层灯效（§7.1 的 8 字节定宽编码在内存里的形状）。
 *
 * 参数语义沿用 effects-spec §2：`p5` 按 type 解释为 min_level / span / tail；
 * 静态层的 periodMs / p5 / flags 恒为 0。空层用 `type = NO_EFFECT`（0xFF）。
 */
export interface EffectLayer {
  /** SEGMENT_TYPE.*，或 NO_EFFECT（0xFF）表示该层为空。 */
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
}

/** 空层常量。构造器与解析器共用，避免各处手写 0xFF。 */
export const EMPTY_EFFECT: EffectLayer = {
  type: 0xff,
  hue: 0,
  sat: 0,
  periodMs: 0,
  p5: 0,
  flags: 0,
};

/** blend：层 1 如何叠加到层 0（§7.2）。0 覆盖 / 1 相乘 / 2 相加。 */
export type BlendMode = 0 | 1 | 2;

/**
 * 一条段配置的线上形状（SetSegment / ScriptSegment / SegmentReport 同构）。
 *
 * 两层定宽，没有「按 type 变长」的分支——这是 v3 刻意的选择（§7.1）。
 */
export interface SegmentSpec {
  /** 灯带号 0-7。 */
  stripId: number;
  /** 槽位号 0-7（每条灯带独立 8 段）。 */
  segId: number;
  /** 闭区间起点。 */
  start: number;
  /** 闭区间终点，必须 < 该灯带灯珠数。 */
  end: number;
  /** 层 1 叠加到层 0 的方式；层 1 为空时必须为 0。 */
  blend: BlendMode;
  /** 必填层，不得为空。 */
  layer0: EffectLayer;
  /** 可选层；`type = NO_EFFECT` 表示不使用。 */
  layer1: EffectLayer;
}

/**
 * 一条 SegmentReport 0x83。
 *
 * 线上形状与 SegmentSpec 完全同构；额外的扁平字段是 **layer0 的投影**，
 * 供 #41 之前的页面（只编辑层 0）沿用原有字段名，不需要改页面代码。
 * 双层的权威数据始终在 `layer0` / `layer1`。
 */
export interface SegmentReport extends SegmentSpec {
  /** 兼容字段：= layer0.type。 */
  type: number;
  /** 兼容字段：= layer0.hue。 */
  hue: number;
  /** 兼容字段：= layer0.sat。 */
  sat: number;
  /** 兼容字段：= layer0.periodMs。 */
  periodMs: number;
  /** 兼容字段：= layer0.p5。 */
  p5: number;
  /** 兼容字段：= layer0.flags。 */
  flags: number;
}

/**
 * 页面 API 用的扁平段草稿（#41 之前只有层 0，且没有 blend）。
 *
 * 这是 **UI 形态**，不是线上形态：写到设备前由 `segment-model.toSpec`
 * 转成 `SegmentSpec`（layer1 = 空层、blend = 覆盖）。
 * 保留这个类型是为了让 pages/ 与既有的 `session.setSegment*` 签名不动。
 */
export interface SegmentConfig {
  /** 灯带号；多灯带（#29）之前恒为 0。 */
  stripId: number;
  /** 槽位号 0-7。 */
  segId: number;
  /** 闭区间起点。 */
  start: number;
  /** 闭区间终点，必须 < ledCount。 */
  end: number;
  /** 灯效类型（SEGMENT_TYPE）。 */
  type: number;
  /** 色相 0-65535。 */
  hue: number;
  /** 饱和度 0-255。 */
  sat: number;
  /** 周期毫秒；静态段恒 0。 */
  periodMs: number;
  /** min_level / span / tail，按 type 解释；静态段恒 0。 */
  p5: number;
  /** 动画类 flags；静态段恒 0。 */
  flags: number;
}

/** 一条 SegmentListEnd 0x84：某灯带的段位图。 */
export interface SegmentListEnd {
  stripId: number;
  /** bit i = 槽位 i 有活动段。 */
  segMask: number;
}

/**
 * 「当前选中的段」：颜色控件要写到哪个槽位、以及它的区间。
 *
 * 区间是用户刚划定的目标区间；设备侧仍会做权威校验（越界 / 重叠 → InvalidParam）。
 */
export interface SegmentTarget {
  stripId: number;
  segId: number;
  start: number;
  end: number;
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
  /** major<<8 | minor。 */
  firmwareVersion: number;
  firmwareMajor: number;
  firmwareMinor: number;
  /** 6 字节 BT MAC，按 "AA:BB:CC:DD:EE:FF" 的自然顺序（大写字面量）。 */
  hwId: string;
  maxLeds: number;
  maxStrips: number;
  maxSegments: number;
  maxStages: number;
  maxScripts: number;
  /** bit0 = 支持两层叠加；bit1 = fade 已实现。 */
  caps: number;
  /** caps bit0 的投影。 */
  supportsTwoLayers: boolean;
  /** caps bit1 的投影。 */
  fadeImplemented: boolean;
}

/**
 * 设备 37 字节 State 的内存表示，字段顺序见 docs/protocol-v3.md §7.3。
 *
 * `ledCount` / `segCount` 是**派生字段**（= strip 0 的值），保留它们是为了让
 * #41 之前的页面与既有 session API 继续按「单灯带」使用，不必改页面。
 * 多头灯带的权威数据是 `stripCounts` / `stripSegCounts`。
 */
export interface DeviceState {
  power: 0 | 1;
  /** 已按设备 maxBrightness 钳位后的生效值。 */
  brightness: number;
  /** strip 0 / seg 0 **层 0** 的基准色（不含动画包络）。 */
  r: number;
  g: number;
  b: number;
  /** 派生字段：= stripCounts[0]。 */
  ledCount: number;
  /** 滑块上限，不许在 UI 里硬编码 255。 */
  maxBrightness: number;

  /* ---- v3 摘要（State 字节 6-36） ---- */
  /** 1-8，当前配置的灯带数。 */
  stripCount: number;
  /** 派生字段：= stripSegCounts[0]。 */
  segCount: number;
  /** 0xFF = 无激活剧本。 */
  scriptId: number;
  /** 当前阶段；无剧本时 0。 */
  stageIndex: number;
  /** 0 停止 / 1 播放 / 2 暂停。 */
  playbackState: number;
  /** bit0 loop；bit1 script_active；bit2-7 保留 = 0。 */
  flags: number;
  /** bit i = 第 i 条灯带的独立开关（实际出光 = power && 对应位）。 */
  stripPowerMask: number;
  /** bit i = 第 i 条灯带当前有动画类活动段（只作显示提示）。 */
  stripAnimMask: number;
  /** 每条灯带的灯珠数（u16 × 8）；未使用的槽位为 0。 */
  stripCounts: number[];
  /** 每条灯带的活动段数（u8 × 8）；未使用的槽位为 0。 */
  stripSegCounts: number[];
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
