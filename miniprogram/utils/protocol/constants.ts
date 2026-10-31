/**
 * 协议常量。唯一真相是 docs/protocol-v3.md；这里只是照抄字节值。
 *
 * 所有 UUID 统一用大写比较（微信在不同平台/系统版本返回的大小写不一致）。
 * 协议版本 v3（不向后兼容；v2 已退役）。
 */

export const SERVICE_UUID = "6C756D65-6E00-4B1E-9A3C-000000000001";
export const RX_UUID = "6C756D65-6E00-4B1E-9A3C-000000000002";
export const TX_UUID = "6C756D65-6E00-4B1E-9A3C-000000000003";
export const STATE_UUID = "6C756D65-6E00-4B1E-9A3C-000000000004";

/**
 * 逻辑帧信封：magic(1) version(1) command(1) seq(1) length(2 LE) payload crc16(2 LE)。
 * 整帧 = 8 + length；CRC16 覆盖 magic 到 payload 末字节。
 */
export const MAGIC = 0xa6;
export const PROTOCOL_VERSION = 0x03;
export const HEADER_BYTES = 6;
export const FRAME_OVERHEAD = 8;

/** 逻辑帧上限（§1.1）：载荷 232、整帧 240。 */
export const MAX_PAYLOAD_BYTES = 232;
export const MAX_FRAME_BYTES = 240;

/** BLE 默认 ATT MTU 23 − 3；MTU 未知时两端都按这个工作（§2.1）。 */
export const DEFAULT_MTU = 23;
export const DEFAULT_CHUNK_CAPACITY = DEFAULT_MTU - 3;
/** 单次写上限 180（§2.1）；数据上限 = capacity − 1（1 字节分片头）。 */
export const MAX_CHUNK_CAPACITY = 180;
export const MAX_CHUNK_DATA = MAX_CHUNK_CAPACITY - 1;
/** 分片头：bit7 FIRST、bit6 LAST、bit5-0 序号。 */
export const CHUNK_FIRST = 0x80;
export const CHUNK_LAST = 0x40;
export const CHUNK_INDEX_MASK = 0x3f;
/** 重组超时（自上一個分片起算，§3.2）。 */
export const ASSEMBLY_TIMEOUT_MS = 1000;

/** 协议常量，两端硬编码（不进 State）。 */
export const MAX_LEDS = 64;
export const MIN_LEDS = 1;
export const MAX_STRIPS = 8;
export const MAX_SEGMENTS = 8; // 每条灯带
export const MAX_STAGES = 8; // 每套剧本
/** 单阶段时长上限（2 字节字段）。0 非法（设备回 InvalidParam）。 */
export const MAX_STAGE_MS = 0xffff;
export const MAX_SCRIPTS = 4;
/** script_id 用 0xFF 表示「无激活剧本」。 */
export const NO_SCRIPT = 0xff;
/** 层类型用 0xFF 表示「该层为空」（§1.1 / §7.1）。 */
export const NO_EFFECT = 0xff;
/** 每段最多两层（§1.1）。 */
export const MAX_LAYERS = 2;

/** State 固定 37 字节（State read 与 StateReport 0x82 共用，§7.3）。 */
export const STATE_BYTES = 37;
/** 段载荷定宽：SetSegment 21、ScriptSegment 23、SegmentReport 21（§7.1）。 */
export const SEGMENT_BYTES = 21;
export const SCRIPT_SEGMENT_BYTES = 23;
/** 层编码定宽 8 字节（type + 7 字节参数）。 */
export const LAYER_BYTES = 8;
/** SegmentReport 0x87 / DeviceInfoReport 0x88 的固定载荷长度（§7.4）。 */
export const STRIP_CONFIG_BYTES = 24;
export const STRIP_CONFIG_RECORD_BYTES = 3;
export const DEVICE_INFO_BYTES = 15;

/** 播放状态（State 字节 9）：0 停止 / 1 播放 / 2 暂停。 */
export const PLAYBACK = {
  STOPPED: 0,
  PLAYING: 1,
  PAUSED: 2,
} as const;

/**
 * 小程序 → 设备命令字，docs/protocol-v3.md §6。
 *
 * v2 退役了 v1 的 0x03 SetColor / 0x04 SetAll：0x03 / 0x04 两个值不再出现在
 * 本表里（设备收到回 0x02 未知命令）。v3 新增 0x1B/0x1C/0x1D。
 */
export const CMD = {
  SET_POWER: 0x01,
  SET_BRIGHTNESS: 0x02,
  QUERY_STATE: 0x05,
  SET_LED_COUNT: 0x06,
  SELF_TEST: 0x07,

  SET_SEGMENT: 0x10,
  CLEAR_SEGMENT: 0x11,
  QUERY_STRIP: 0x12,
  SET_PLAYBACK: 0x13,
  SCRIPT_BEGIN: 0x14,
  SCRIPT_STAGE: 0x15,
  SCRIPT_SEGMENT: 0x16,
  SCRIPT_COMMIT: 0x17,
  SCRIPT_ABORT: 0x18,
  ACTIVATE_SCRIPT: 0x19,
  QUERY_SCRIPT: 0x1a,

  SET_STRIP_POWER: 0x1b,
  QUERY_STRIP_CONFIG: 0x1c,
  QUERY_DEVICE_INFO: 0x1d,
} as const;

/** 设备 → 小程序命令字，docs/protocol-v3.md §7.4。 */
export const DEVICE_CMD = {
  ACK: 0x80,
  EVENT: 0x81,
  STATE_REPORT: 0x82,
  SEGMENT_REPORT: 0x83,
  SEGMENT_LIST_END: 0x84,
  SCRIPT_SUMMARY: 0x85,
  SCRIPT_PROGRESS: 0x86,
  STRIP_CONFIG_REPORT: 0x87,
  DEVICE_INFO_REPORT: 0x88,
} as const;

/** ACK 载荷第二个字节，docs/protocol-v3.md §5。 */
export const RESULT = {
  OK: 0x00,
  INVALID_PARAM: 0x01,
  UNKNOWN_COMMAND: 0x02,
  BAD_CHECKSUM: 0x03,
  BAD_LENGTH: 0x04,
  BUSY: 0x05,
  STORAGE_FAILED: 0x06,
  UNSUPPORTED_VERSION: 0x07,
  BAD_MAGIC: 0x08,
  INTERNAL_ERROR: 0x09,
  SCRIPT_TOO_LARGE: 0x0a,
} as const;

export const EVENT = {
  STORAGE_FAILED: 0x01,
  /** ScriptCommit 校验失败（detail = 失败的 script_id）。 */
  SCRIPT_COMMIT_FAILED: 0x02,
} as const;

/** 段/层类型（effects-spec §2）：参数块长度随类型不同。 */
export const SEGMENT_TYPE = {
  STATIC: 0x00,
  BREATHING: 0x01,
  RAINBOW: 0x02,
  COMET: 0x03,
  /** 空层（只有 type 合法）。 */
  EMPTY: 0xff,
} as const;

/** blend：层 1 如何叠加到层 0（§7.2）。 */
export const BLEND = {
  OVER: 0x00,
  MULTIPLY: 0x01,
  ADD: 0x02,
} as const;

/**
 * 呼吸波形（flags bit1-2，effects-spec §2.2）。
 * UI 的顺序就是枚举值：0 正弦 / 1 三角 / 2 锯齿 / 3 方波。
 */
export const WAVEFORM = {
  SINE: 0,
  TRIANGLE: 1,
  SAWTOOTH: 2,
  SQUARE: 3,
} as const;

/** 波形展示名（只用于 UI 与日志，不参与协议）。 */
export const WAVEFORM_NAMES: Record<number, string> = {
  [WAVEFORM.SINE]: "正弦",
  [WAVEFORM.TRIANGLE]: "三角",
  [WAVEFORM.SAWTOOTH]: "锯齿",
  [WAVEFORM.SQUARE]: "方波",
};

/**
 * 呼吸周期下限（effects-spec §5，protocol §11.3 第 9 步）：
 * 334ms ≈ 3Hz，光敏性癫痫安全线。period_ms == 0 是「静止」，不受此限。
 */
export const BREATHING_MIN_PERIOD_MS = 334;

/**
 * 彩虹 / 流光的周期下限（effects-spec §5 / D5）：200ms = 5Hz。
 * 这两类是空间移动而不是亮度闪烁，所以比呼吸宽松；彩虹与流光共用同一条规则。
 */
export const ANIMATION_MIN_PERIOD_MS = 200;

/** 周期字段是 2 字节小端（D3）。 */
export const MAX_PERIOD_MS = 0xffff;

/** 连续量节流上限：20Hz（docs/ble-notes.md 实测结论）。 */
export const CONTINUOUS_INTERVAL_MS = 50;

/** 命令名表，只用于日志与提示，不参与协议。 */
export const COMMAND_NAMES: Record<number, string> = {
  [CMD.SET_POWER]: "SetPower",
  [CMD.SET_BRIGHTNESS]: "SetBrightness",
  [CMD.QUERY_STATE]: "QueryState",
  [CMD.SET_LED_COUNT]: "SetLedCount",
  [CMD.SELF_TEST]: "SelfTest",
  [CMD.SET_SEGMENT]: "SetSegment",
  [CMD.CLEAR_SEGMENT]: "ClearSegment",
  [CMD.QUERY_STRIP]: "QueryStrip",
  [CMD.SET_PLAYBACK]: "SetPlayback",
  [CMD.SCRIPT_BEGIN]: "ScriptBegin",
  [CMD.SCRIPT_STAGE]: "ScriptStage",
  [CMD.SCRIPT_SEGMENT]: "ScriptSegment",
  [CMD.SCRIPT_COMMIT]: "ScriptCommit",
  [CMD.SCRIPT_ABORT]: "ScriptAbort",
  [CMD.ACTIVATE_SCRIPT]: "ActivateScript",
  [CMD.QUERY_SCRIPT]: "QueryScript",
  [CMD.SET_STRIP_POWER]: "SetStripPower",
  [CMD.QUERY_STRIP_CONFIG]: "QueryStripConfig",
  [CMD.QUERY_DEVICE_INFO]: "QueryDeviceInfo",
  [DEVICE_CMD.ACK]: "ACK",
  [DEVICE_CMD.EVENT]: "Event",
  [DEVICE_CMD.STATE_REPORT]: "StateReport",
  [DEVICE_CMD.SEGMENT_REPORT]: "SegmentReport",
  [DEVICE_CMD.SEGMENT_LIST_END]: "SegmentListEnd",
  [DEVICE_CMD.SCRIPT_SUMMARY]: "ScriptSummary",
  [DEVICE_CMD.SCRIPT_PROGRESS]: "ScriptProgress",
  [DEVICE_CMD.STRIP_CONFIG_REPORT]: "StripConfigReport",
  [DEVICE_CMD.DEVICE_INFO_REPORT]: "DeviceInfoReport",
};

export function commandName(command: number): string {
  return COMMAND_NAMES[command] ?? `0x${command.toString(16).padStart(2, "0").toUpperCase()}`;
}
