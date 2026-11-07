/**
 * 演示用设备清单（mock 模式的唯一数据源）。
 *
 * 这里的设备**不是另一套数据结构**：每台都对应真实固件的身份字段
 * （`hwId` 是 6 字节 BT MAC、`stripCounts` 是逐带灯珠数），由
 * `utils/ble/mock-transport.ts` 用它构造与真机同形的 State / DeviceInfo /
 * StripConfig / SegmentReport。
 *
 * 为什么需要它：仓库里只有 1 台实机，而首页的交互（大卡片 + 下方设备小图
 * 切换）必须多台设备才看得见效果。关掉 mock 后这些字段一个都不用改。
 */

/** 一台演示设备能提供的一切（连接后由 mock transport 逐项产出）。 */
export interface MockDeviceSpec {
  /** 平台 BLE deviceId（真机上是 MAC 或 iOS UUID，这里用 MAC 形态）。 */
  deviceId: string;
  /** 设备自报的 6 字节 BT MAC（DeviceInfoReport 0x88）。 */
  hwId: string;
  /** 广播名（`Lumen-XXXX`），与真实固件一致。 */
  broadcastName: string;
  /** 用户备注名（登记表），空串表示没起名字。 */
  remark: string;
  /** 卡片照片（`/assets/devices/*.webp`）。真实设备将来由用户上传。 */
  photo: string;
  /** 逐带灯珠数（State.led_count[8]）；长度即条数，最多 8。 */
  stripCounts: number[];
  /** 开机默认状态。 */
  power: 0 | 1;
  brightness: number;
  /** 全局最大亮度（真实固件 #14 结论是 200）。 */
  maxBrightness: number;
  /** 每条带的独立开关掩码（State.strip_power_mask）。 */
  stripPowerMask: number;
  /**
   * 设备的初始布局（连接时按 `QueryLayout` 读回，可被 mock 写入修改）。
   *
   * v5 的布局是「灯组 → 部位 → 灯珠段」；每个部位出厂带 1 步常亮，
   * 与设备页上「点 + 播种整条 / 1 步 / 常亮」的语义一致。
   */
  parts: MockPartSeed[];
}

/** 一个部位的初始状态：真实设备里布局是持久配置，所以它也属于 spec。 */
export interface MockPartSeed {
  stripId: number;
  /** 部位号 0-7（该链内）。 */
  partId: number;
  name: string;
  /** 闭区间灯珠段（最多 8 条）。 */
  segs: Array<[number, number]>;
  /** 该部位出厂时的常亮色（hue 0-65535 / sat 0-255）。 */
  hue: number;
  sat: number;
}

/**
 * 三台演示设备，覆盖首页要展示的三种状态：
 *  - 书桌：2 条带、暖白、开着（主卡片默认选它）；
 *  - 客厅：8 条带、青色、关着；
 *  - 卧室：1 条带、紫色、开着但亮度很低。
 *
 * 名字用中文备注名——真实使用里用户几乎总会改备注，首页卡片显示的就是它。
 */
export const MOCK_DEVICES: readonly MockDeviceSpec[] = [
  {
    deviceId: "A4:CF:12:9B:3E:01",
    hwId: "A4:CF:12:9B:3E:01",
    broadcastName: "Lumen-9B01",
    remark: "书桌",
    photo: "/assets/devices/desk.webp",
    stripCounts: [30, 18, 0, 0, 0, 0, 0, 0],
    power: 1,
    brightness: 168,
    maxBrightness: 200,
    stripPowerMask: 0x03,
    parts: [
      { stripId: 0, partId: 0, name: "前半", segs: [[0, 13]], hue: 7281, sat: 255 },
      { stripId: 0, partId: 1, name: "后半", segs: [[14, 29]], hue: 43690, sat: 200 },
      { stripId: 1, partId: 0, name: "", segs: [[0, 17]], hue: 7281, sat: 255 },
    ],
  },
  {
    deviceId: "A4:CF:12:9B:3E:02",
    hwId: "A4:CF:12:9B:3E:02",
    broadcastName: "Lumen-9B02",
    remark: "客厅",
    photo: "/assets/devices/living.webp",
    stripCounts: [60, 60, 60, 60, 24, 24, 0, 0],
    power: 0,
    brightness: 120,
    maxBrightness: 200,
    stripPowerMask: 0x0f,
    parts: [
      { stripId: 0, partId: 0, name: "顶", segs: [[0, 59]], hue: 36409, sat: 180 },
      { stripId: 1, partId: 0, name: "左", segs: [[0, 59]], hue: 36409, sat: 180 },
      { stripId: 2, partId: 0, name: "右", segs: [[0, 59]], hue: 36409, sat: 180 },
      { stripId: 3, partId: 0, name: "底", segs: [[0, 59]], hue: 36409, sat: 180 },
    ],
  },
  {
    deviceId: "A4:CF:12:9B:3E:03",
    hwId: "A4:CF:12:9B:3E:03",
    broadcastName: "Lumen-9B03",
    remark: "卧室",
    photo: "/assets/devices/bedroom.webp",
    stripCounts: [24, 0, 0, 0, 0, 0, 0, 0],
    power: 1,
    brightness: 34,
    maxBrightness: 200,
    stripPowerMask: 0x01,
    parts: [{ stripId: 0, partId: 0, name: "床头", segs: [[0, 23]], hue: 50000, sat: 220 }],
  },
];

/** 按 deviceId 找 spec（连接时用）。 */
export function mockSpecOf(deviceId: string): MockDeviceSpec | null {
  return MOCK_DEVICES.find((spec) => spec.deviceId === deviceId) ?? null;
}
