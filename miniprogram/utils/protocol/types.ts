/** 协议层与界面层共用的数据类型。 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** 设备 8 字节 State 的内存表示，字段顺序见 docs/protocol.md §7。 */
export interface DeviceState {
  power: 0 | 1;
  /** 已按设备 maxBrightness 钳位后的生效值。 */
  brightness: number;
  r: number;
  g: number;
  b: number;
  /** 1-64。 */
  ledCount: number;
  /** 滑块上限，不许在 UI 里硬编码 255。 */
  maxBrightness: number;
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
