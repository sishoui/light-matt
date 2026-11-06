/**
 * 协议常量。唯一真相是 docs/protocol-v5.md；这里只是照抄字节值。
 *
 * 所有 UUID 统一用大写比较（微信在不同平台/系统版本返回的大小写不一致）。
 * 协议版本 v5（不向后兼容；v2 / v3 / v4 已退役）。
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
export const PROTOCOL_VERSION = 0x05;
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

/** 协议常量，两端硬编码（不进 State）。docs/protocol-v5.md §1.1。 */
export const MAX_LEDS = 100;
export const MIN_LEDS = 1;
export const MAX_STRIPS = 8;
/** 每条链的部位数（§1.1）。 */
export const MAX_PARTS = 8;
/** 每个部位的灯珠段数。 */
export const MAX_PART_SEGS = 8;
/** 每个部位的步骤数。 */
export const MAX_STEPS = 8;
/** 设备侧场景数。 */
export const MAX_SCENES = 3;
/** 部位名 / 场景名的字节上限（UTF-8，不强制字符边界）。 */
export const NAME_BYTES = 24;
/** 步骤时长区间（§1.1）。 */
export const STEP_MIN_MS = 100;
export const STEP_MAX_MS = 60000;
/** 层类型用 0xFF 表示「该层为空」（§1.1 / §7.1）。 */
export const NO_EFFECT = 0xff;
/** 每段最多两层（§1.1）。 */
export const MAX_LAYERS = 2;

/** 一颗灯珠不属于任何部位时的哨兵值（只在本地派生里用）。 */
export const PART_NONE = 0xff;
/** State 固定 32 字节（State read 与 StateReport 0x82 共用，§7.3）。 */
export const STATE_BYTES = 32;
/** LayoutPart 0x21 载荷（28 字节，§1.1）。 */
export const LAYOUT_PART_BYTES = 28;
/** LayoutReport 0x89 载荷（44 字节，§7.2）。 */
export const LAYOUT_REPORT_BYTES = 44;
/** SceneStep 0x26 / SceneStepReport 0x8C 载荷（24 字节，§1.1）。 */
export const SCENE_STEP_BYTES = 24;
/** SceneName 0x27 / SceneListEnd 0x8D 载荷（26 字节）。 */
export const SCENE_NAME_BYTES = 26;
/** 层编码定宽 9 字节（type + 7 字节参数 + level）。 */
export const LAYER_BYTES = 9;
/** 本层亮度档位上限（§7.1）：100 满亮、0 不出光；> 100 一律 InvalidParam。 */
export const LAYER_LEVEL_MAX = 100;
/** StripConfigReport 0x87 / DeviceInfoReport 0x88 的固定载荷长度（§7.4）。 */
export const STRIP_CONFIG_BYTES = 24;
export const STRIP_CONFIG_RECORD_BYTES = 3;
export const DEVICE_INFO_BYTES = 15;

/**
 * 小程序 → 设备命令字，docs/protocol-v5.md §6。
 *
 * v5 删掉了整个段与剧本族（0x03 / 0x04 与 0x10-0x1E）：设备收到一律回 0x02
 * 未知命令，这些码**不复用**，所以本表里也不再有它们。
 */
export const CMD = {
  SET_POWER: 0x01,
  SET_BRIGHTNESS: 0x02,
  QUERY_STATE: 0x05,
  SET_LED_COUNT: 0x06,
  SELF_TEST: 0x07,

  SET_STRIP_POWER: 0x1b,
  QUERY_STRIP_CONFIG: 0x1c,
  QUERY_DEVICE_INFO: 0x1d,

  /** 布局族（§6）：灯组 → 部位 → 灯珠段。 */
  LAYOUT_WRITE: 0x20,
  LAYOUT_PART: 0x21,
  LAYOUT_SEG: 0x22,
  LAYOUT_COMMIT: 0x23,
  QUERY_LAYOUT: 0x24,

  /** 场景族（§6）：部位 → 步骤 → 两层。 */
  SCENE_PART: 0x25,
  SCENE_STEP: 0x26,
  SCENE_NAME: 0x27,
  ACTIVATE_SCENE: 0x28,
  QUERY_SCENE: 0x29,
} as const;

/** 设备 → 小程序命令字，docs/protocol-v5.md §7.4。 */
export const DEVICE_CMD = {
  ACK: 0x80,
  EVENT: 0x81,
  STATE_REPORT: 0x82,
  /* 0x83-0x86（段报告 / 段列表收尾 / 剧本摘要 / 剧本进度）在 v5 已删除。 */
  STRIP_CONFIG_REPORT: 0x87,
  DEVICE_INFO_REPORT: 0x88,
  LAYOUT_REPORT: 0x89,
  LAYOUT_LIST_END: 0x8a,
  SCENE_PART_REPORT: 0x8b,
  SCENE_STEP_REPORT: 0x8c,
  SCENE_LIST_END: 0x8d,
} as const;

/** ACK 载荷第二个字节，docs/protocol-v5.md §5。 */
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
  /* 0x0A 是 v4 的 ScriptTooLarge，v5 不再发送；编号不复用。 */
} as const;

export const EVENT = {
  STORAGE_FAILED: 0x01,
  /* 0x02 是 v4 的剧本提交失败，v5 不再发送。 */
} as const;

/** 灯效层类型（effects-spec §2；v5 未改）。 */
export const EFFECT_TYPE = {
  STATIC: 0x00,
  BREATHING: 0x01,
  RAINBOW: 0x02,
  COMET: 0x03,
  /** #74 爆闪：方波 + 两端斜坡；p5 是占空比，周期下限 100ms。 */
  STROBE: 0x04,
  /** #74 心跳：一个节拍内一大一小两次脉冲；flags bit0 = 双脉冲，周期 500-1500ms。 */
  HEARTBEAT: 0x05,
  /** #74 熄灭：参数全 0，永不发光（显式的「这里就是黑的」）。 */
  OFF: 0x06,
  /**
   * #98 随机闪烁：每颗灯按自己的哈希相位做确定性亮灭方波（不是逐帧白噪声）。
   * p5 = 同时亮着的比例；flags 必须 0；周期 0 或 ≥ 334ms。
   */
  FLICKER: 0x07,
  /** 空层（只有 type 合法）。 */
  EMPTY: 0xff,
} as const;

/**
 * v5 的混合方式**不在线上**：`layer1` 为空 → 覆盖；非空 → 按亮度叠加（§6.2）。
 * 这两个常量只是本地推导值，不参与编码。
 */
export const BLEND_LOCAL = {
  OVER: 0x00,
  LUMA: 0x03,
} as const;

/**
 * 哪些类型值是**真实灯效**（不含空层 `0xFF`）。
 *
 * 单一真相：任何「这个 type 认不认识」的判断都从这里出发。曾经
 * `segment-editor.isKnownType` 与 `script-view.typeName` 各写一份四类型清单，
 * #74 加了爆闪 / 心跳 / 熄灭之后它们没跟上——校验会把新灯效判成非法、摘要会
 * 显示成 `0x04`。这类「枚举扩了、判断没扩」的漏洞只靠单测很难发现，所以把
 * 清单放在枚举旁边，由 `isKnownEffectType` 统一回答。
 */
export const KNOWN_EFFECT_TYPES: readonly number[] = [
  EFFECT_TYPE.STATIC,
  EFFECT_TYPE.BREATHING,
  EFFECT_TYPE.RAINBOW,
  EFFECT_TYPE.COMET,
  EFFECT_TYPE.STROBE,
  EFFECT_TYPE.HEARTBEAT,
  EFFECT_TYPE.OFF,
  EFFECT_TYPE.FLICKER,
];

/** `type` 是否是真实灯效类型（空层 `0xFF` 不算）。 */
export function isKnownEffectType(type: number): boolean {
  return KNOWN_EFFECT_TYPES.includes(type);
}

/** 灯效类型的中文名（UI 与日志用；空层给「无」，未知给 hex）。 */
export const EFFECT_TYPE_NAMES: Record<number, string> = {
  [EFFECT_TYPE.STATIC]: "常亮",
  [EFFECT_TYPE.BREATHING]: "呼吸",
  [EFFECT_TYPE.RAINBOW]: "彩虹",
  [EFFECT_TYPE.COMET]: "流星",
  [EFFECT_TYPE.STROBE]: "爆闪",
  [EFFECT_TYPE.HEARTBEAT]: "心跳",
  [EFFECT_TYPE.OFF]: "熄灭",
  [EFFECT_TYPE.FLICKER]: "随机闪烁",
  [EFFECT_TYPE.EMPTY]: "无",
};

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

/**
 * 爆闪周期下限（effects-spec §2.5）：100ms = 10Hz。
 *
 * 这是**固件能表现的上界**（默认 20fps，每帧 50ms），不是安全线；#74 不提高帧率。
 * period_ms == 0 是「静止不出光」，不受此限。
 */
export const STROBE_MIN_PERIOD_MS = 100;

/**
 * 心跳周期区间（effects-spec §2.6）：500-1500ms = 40-120 BPM。
 * period_ms == 0 同样是「静止」。
 */
export const HEARTBEAT_MIN_PERIOD_MS = 500;
export const HEARTBEAT_MAX_PERIOD_MS = 1500;

/**
 * 随机闪烁周期下限（#98）：334ms，与呼吸同一条光敏性癫痫安全线。
 *
 * 它**不是**空间移动而是亮度闪烁，所以不能借用彩虹 / 流光的 200ms。
 * period_ms == 0 是「静止」：时间相位不动，画面冻结在一张固定分布上。
 */
export const FLICKER_MIN_PERIOD_MS = 334;

/**
 * 流光的 flags 位域（#98，全部挤在已有的 1 字节里，不新增字段）：
 *   bit0 reverse / bit1 实色拖尾 / bit2-3 头数量-1 / bit4-7 保留 = 0
 *
 * 多个头在同一帧**取最大值**合成，绝不相加（固件侧实现），这里只负责编码。
 */
export const COMET_FLAG = {
  REVERSE: 0x01,
  SOLID_TAIL: 0x02,
} as const;
export const COMET_DENSITY_SHIFT = 2;
export const COMET_DENSITY_MASK = 0x0c;
export const COMET_HEADS_MIN = 1;
export const COMET_HEADS_MAX = 4;
/** 流光 flags 的保留位（bit4-7 必须为 0）。 */
export const COMET_FLAGS_RESERVED = 0xf0;

/**
 * 循环三值（§7.5）：0 不循环 / 1 全部循环 / 2 最后一步循环。
 *
 * **v5 的宿主变了**：从 v4 的「剧本 / 方案级」变成**每个部位一份**（T2）。
 * 取值不变，仍是线上字节，不做重映射。
 */
export const LOOP = {
  NONE: 0,
  ALL: 1,
  LAST: 2,
} as const;
export const LOOP_MAX = LOOP.LAST;

/**
 * 循环三值类型。凡是下发循环的接口都收这个类型：布尔在那里过不了编译，
 * 于是「把三值压成布尔」在类型层面就被拦住。
 */
export type LoopMode = (typeof LOOP)[keyof typeof LOOP];

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
  [CMD.SET_STRIP_POWER]: "SetStripPower",
  [CMD.QUERY_STRIP_CONFIG]: "QueryStripConfig",
  [CMD.QUERY_DEVICE_INFO]: "QueryDeviceInfo",
  [CMD.LAYOUT_WRITE]: "LayoutWrite",
  [CMD.LAYOUT_PART]: "LayoutPart",
  [CMD.LAYOUT_SEG]: "LayoutSeg",
  [CMD.LAYOUT_COMMIT]: "LayoutCommit",
  [CMD.QUERY_LAYOUT]: "QueryLayout",
  [CMD.SCENE_PART]: "ScenePart",
  [CMD.SCENE_STEP]: "SceneStep",
  [CMD.SCENE_NAME]: "SceneName",
  [CMD.ACTIVATE_SCENE]: "ActivateScene",
  [CMD.QUERY_SCENE]: "QueryScene",
  [DEVICE_CMD.ACK]: "ACK",
  [DEVICE_CMD.EVENT]: "Event",
  [DEVICE_CMD.STATE_REPORT]: "StateReport",
  [DEVICE_CMD.STRIP_CONFIG_REPORT]: "StripConfigReport",
  [DEVICE_CMD.DEVICE_INFO_REPORT]: "DeviceInfoReport",
  [DEVICE_CMD.LAYOUT_REPORT]: "LayoutReport",
  [DEVICE_CMD.LAYOUT_LIST_END]: "LayoutListEnd",
  [DEVICE_CMD.SCENE_PART_REPORT]: "ScenePartReport",
  [DEVICE_CMD.SCENE_STEP_REPORT]: "SceneStepReport",
  [DEVICE_CMD.SCENE_LIST_END]: "SceneListEnd",
};

export function commandName(command: number): string {
  return COMMAND_NAMES[command] ?? `0x${command.toString(16).padStart(2, "0").toUpperCase()}`;
}
