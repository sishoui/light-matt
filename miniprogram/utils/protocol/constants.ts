/**
 * 协议常量。唯一真相是 docs/protocol.md；这里只是照抄字节值。
 *
 * 所有 UUID 统一用大写比较（微信在不同平台/系统版本返回的大小写不一致）。
 */

export const SERVICE_UUID = "6C756D65-6E00-4B1E-9A3C-000000000001";
export const RX_UUID = "6C756D65-6E00-4B1E-9A3C-000000000002";
export const TX_UUID = "6C756D65-6E00-4B1E-9A3C-000000000003";
export const STATE_UUID = "6C756D65-6E00-4B1E-9A3C-000000000004";

/** 帧信封：magic(1) version(1) command(1) seq(1) length(1) payload checksum(1)。 */
export const MAGIC = 0xa5;
export const PROTOCOL_VERSION = 0x01;

/** BLE 默认 ATT MTU 23 − 3；协议不允许分包，encode 超过这个长度必须抛错。 */
export const MAX_FRAME_BYTES = 20;
export const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - 6;
export const HEADER_BYTES = 5;
export const FRAME_OVERHEAD = 6;

/** 协议常量，两端硬编码（不进 State）。 */
export const MAX_LEDS = 64;
export const MIN_LEDS = 1;

/** 小程序 → 设备命令字，docs/protocol.md §6。 */
export const CMD = {
  SET_POWER: 0x01,
  SET_BRIGHTNESS: 0x02,
  SET_COLOR: 0x03,
  SET_ALL: 0x04,
  QUERY_STATE: 0x05,
  SET_LED_COUNT: 0x06,
  SELF_TEST: 0x07,
} as const;

/** 设备 → 小程序命令字，docs/protocol.md §8。 */
export const DEVICE_CMD = {
  ACK: 0x80,
  EVENT: 0x81,
  STATE_REPORT: 0x82,
} as const;

/** ACK 载荷第二个字节，docs/protocol.md §5。 */
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
} as const;

export const EVENT = {
  STORAGE_FAILED: 0x01,
} as const;

/** 连续量节流上限：20Hz（docs/ble-notes.md 实测结论）。 */
export const CONTINUOUS_INTERVAL_MS = 50;

/** 命令名表，只用于日志与提示，不参与协议。 */
export const COMMAND_NAMES: Record<number, string> = {
  [CMD.SET_POWER]: "SetPower",
  [CMD.SET_BRIGHTNESS]: "SetBrightness",
  [CMD.SET_COLOR]: "SetColor",
  [CMD.SET_ALL]: "SetAll",
  [CMD.QUERY_STATE]: "QueryState",
  [CMD.SET_LED_COUNT]: "SetLedCount",
  [CMD.SELF_TEST]: "SelfTest",
  [DEVICE_CMD.ACK]: "ACK",
  [DEVICE_CMD.EVENT]: "Event",
  [DEVICE_CMD.STATE_REPORT]: "StateReport",
};

export function commandName(command: number): string {
  return COMMAND_NAMES[command] ?? `0x${command.toString(16).padStart(2, "0").toUpperCase()}`;
}
