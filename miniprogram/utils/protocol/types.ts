/** 协议层与界面层共用的数据类型。 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** 设备 14 字节 State 的内存表示，字段顺序见 docs/protocol.md §7。 */
export interface DeviceState {
  power: 0 | 1;
  /** 已按设备 maxBrightness 钳位后的生效值。 */
  brightness: number;
  /** strip 0 / seg 0 的基准色（不含动画包络）；无 seg 0 时为 0。 */
  r: number;
  g: number;
  b: number;
  /** 1-64，strip 0 的灯珠数。 */
  ledCount: number;
  /** 滑块上限，不许在 UI 里硬编码 255。 */
  maxBrightness: number;

  /* ---- v2 摘要（State 字节 8-13） ---- */
  /** 1-8，当前配置的灯带数。 */
  stripCount: number;
  /** strip 0 的活动段数。 */
  segCount: number;
  /** 0xFF = 无激活剧本。 */
  scriptId: number;
  /** 当前阶段；无剧本时 0。 */
  stageIndex: number;
  /** 0 停止 / 1 播放 / 2 暂停。 */
  playbackState: number;
  /** bit0 loop；bit1 script_active；bit2-7 保留 = 0。 */
  flags: number;
}

/** 一条待下发的命令。payload 由 commands.ts 的构造器生成。 */
export interface CommandRequest {
  command: number;
  payload: Uint8Array;
}

/**
 * 一个段配置（docs/protocol.md §6 / effects-spec §2）。
 *
 * `params` 只保存该类型对应的参数块（静态 3 字节，动画 7 字节），
 * 语义字段在下面单独给出——两者由 commands.ts 保持同步。
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

/** 一条 SegmentReport 0x83（与 SetSegment 载荷同构）。 */
export interface SegmentReport extends SegmentConfig {}

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
