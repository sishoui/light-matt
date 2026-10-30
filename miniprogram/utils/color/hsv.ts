/**
 * 颜色工具（纯函数 + 预设表），#10 颜色与预设端到端。
 *
 * 与协议的分工（docs/protocol.md §7 / spec §6）：
 *  - 小程序只产生**用户空间 RGB**（0-255），不做 gamma、不把亮度折进 RGB；
 *  - gamma 校正与亮度乘算只发生在固件渲染路径（lumen_gamma_apply）；
 *  - 亮度是独立字段，色环只决定色相与饱和度（V 恒为 1），亮度由滑块负责。
 *
 * 本模块不接触 wx / canvas / BLE，可在 vitest 里直接测。
 */

import type { RGB } from "../protocol/types";

export interface HSV {
  /** 0-360（返回时归一化，可能带小数）。 */
  h: number;
  /** 0-1。 */
  s: number;
  /** 0-1。 */
  v: number;
}

/** 把任意角度归一化到 [0, 360)。非有限值按 0 处理。 */
export function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) {
    return 0;
  }
  const mod = hue % 360;
  return mod < 0 ? mod + 360 : mod;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * HSV → 用户空间 RGB（0-255 整数）。
 *
 * h 归一化到 [0,360)；s / v 越界钳到 [0,1]。
 * 这就是标准的 HSV→RGB 公式，**不包含 gamma**：固件会在渲染时对每个通道
 * 做 gamma 2.2，再由亮度乘算。App 侧再做一次 gamma 会让低亮度偏色。
 */
export function hsvToRgb(h: number, s: number, v: number): RGB {
  const hue = normalizeHue(h) / 60;
  const sat = clamp01(s);
  const val = clamp01(v);

  const c = val * sat;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const m = val - c;

  let r = 0;
  let g = 0;
  let b = 0;
  switch (Math.floor(hue) % 6) {
    case 0:
      r = c;
      g = x;
      break;
    case 1:
      r = x;
      g = c;
      break;
    case 2:
      g = c;
      b = x;
      break;
    case 3:
      g = x;
      b = c;
      break;
    case 4:
      r = x;
      b = c;
      break;
    default:
      r = c;
      b = x;
      break;
  }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/** RGB（0-255）→ HSV。用于把设备状态 / 预设色块反推回色环位置与饱和度。 */
export function rgbToHsv(rgb: RGB): HSV {
  const r = clamp01(rgb.r / 255);
  const g = clamp01(rgb.g / 255);
  const b = clamp01(rgb.b / 255);

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta > 0) {
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
  }

  return {
    h: normalizeHue(h),
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

/**
 * 把设备 RGB 反推成色环展示用的 HSV。
 *
 * 灰阶（R=G=B）时色相在数学上无定义，rgbToHsv 会返回 0°，直接套用会让
 * 选中点跳到正红。这里在饱和度接近 0 时保留 fallbackHue（通常是用户上次
 * 选中的色相），只同步饱和度。
 */
export function hsvForWheel(rgb: RGB, fallbackHue: number): HSV {
  const hsv = rgbToHsv(rgb);
  if (hsv.s < 0.01) {
    return { h: normalizeHue(fallbackHue), s: hsv.s, v: hsv.v };
  }
  return hsv;
}


/**
 * 段颜色（协议 hue 0-65535 + sat 0-255）→ 用户空间 RGB，供分段列表展示。
 *
 * 与固件 effects.c 的 static 分支同一套扇区映射（V 恒为 1）；两端不做同一套
 * gamma，展示色只是近似。写成整数运算，方便与 firmware 的 65536 刻度对齐。
 */
function channelByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

export function segmentHueSatToRgb(hue: number, sat: number): RGB {
  const h = ((hue % 0x10000) + 0x10000) % 0x10000; // 归一化到 0-65535
  const s = Math.min(255, Math.max(0, Math.round(sat)));
  const scaled = h * 6;
  const sector = Math.min(5, Math.floor(scaled / 0x10000));
  const frac = scaled % 0x10000;
  const c = s;
  const m = 255 - s;
  const u = sector % 2 === 1 ? 0x10000 - frac : frac;
  const x = Math.round((c * u) / 0x10000);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (sector) {
    case 0:
      r = c;
      g = x;
      break;
    case 1:
      r = x;
      g = c;
      break;
    case 2:
      g = c;
      b = x;
      break;
    case 3:
      g = x;
      b = c;
      break;
    case 4:
      r = x;
      b = c;
      break;
    default:
      r = c;
      b = x;
      break;
  }
  return { r: channelByte(r + m), g: channelByte(g + m), b: channelByte(b + m) };
}

/**
 * 用户空间 RGB → 协议段参数（hue 0-65535 + sat 0-255）。
 *
 * V 恒为 1（饱和度承载明暗），与色环一致：色环只产生色相 + 饱和度，
 * 亮度由独立滑块负责。灰阶（s≈0）时 hue 无定义，返回 0。
 */
export function rgbToSegmentParams(rgb: RGB): { hue: number; sat: number } {
  const hsv = rgbToHsv(rgb);
  return {
    hue: Math.round((hsv.h / 360) * 0x10000) & 0xffff,
    sat: Math.round(hsv.s * 255),
  };
}

/** 单通道钳成 0-255 的整数；非有限值按 0。 */
function channel(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** RGB → "#RRGGBB"（大写，UI 与日志用）。 */
export function rgbToHex(rgb: RGB): string {
  const parts = [channel(rgb.r), channel(rgb.g), channel(rgb.b)].map((value) =>
    value.toString(16).padStart(2, "0"),
  );
  return `#${parts.join("")}`.toUpperCase();
}

/** "#RRGGBB" / "RRGGBB" → RGB；格式不对返回 null（不猜测）。 */
export function hexToRgb(hex: string): RGB | null {
  const text = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(text)) {
    return null;
  }
  return {
    r: parseInt(text.slice(0, 2), 16),
    g: parseInt(text.slice(2, 4), 16),
    b: parseInt(text.slice(4, 6), 16),
  };
}

export interface ColorPreset {
  name: string;
  /** 色块展示色；下发时用 rgb（同一来源解析，避免两套值漂移）。 */
  hex: string;
  rgb: RGB;
}

function preset(name: string, hex: string): ColorPreset {
  const rgb = hexToRgb(hex);
  if (rgb === null) {
    throw new Error(`预设颜色非法：${name} ${hex}`);
  }
  return { name, hex: hex.toUpperCase(), rgb };
}

/**
 * 预设色块：6-8 个常用颜色（issue #10）。
 *
 * 暖白取协议默认值 255/180/120（同时是测试向量 set_color_warm_white 的载荷），
 * 红/绿/蓝/青用纯通道，方便真机核对通道顺序与色相；橙/紫为中间色。
 * 预设不是协议命令：v1 是 SetAll 的快捷入口，v2 改由 #25 的静态段承担。
 */
export const PRESETS: readonly ColorPreset[] = [
  preset("暖白", "#FFB478"),
  preset("冷白", "#DCEBFF"),
  preset("红", "#FF0000"),
  preset("橙", "#FF7A00"),
  preset("绿", "#00FF00"),
  preset("青", "#00FFFF"),
  preset("蓝", "#0000FF"),
  preset("紫", "#8000FF"),
];
