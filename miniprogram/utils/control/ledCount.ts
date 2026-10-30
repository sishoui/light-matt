/**
 * 灯珠数量的前端语义（纯函数 + 常量），#12。
 *
 * 与协议的关系（docs/protocol.md §6 / §11.3）：
 *  - SetLedCount 0x06 载荷 2 字节小端，合法 1-64；越界设备回 0x01。
 *  - 数量变更要在渲染任务里重建 led_strip 句柄，ACK 可能明显晚于普通命令，
 *    因此这类命令的 ACK 超时必须单独放宽到 3000ms（普通命令 600ms）。
 *  - 重建失败回 0x09（InternalError）；重建进行中再发回 0x05（Busy）。
 *
 * 输入校验放在前端：非法值（0、超过 64、非数字、小数）明确拒绝且不发帧，
 * 界面上保留旧值，避免把设备配置写坏。
 *
 * 本模块不接触 wx / BLE，可在 vitest 里直接测。
 */

import { MAX_LEDS, MIN_LEDS } from "../protocol/constants";

/** SetLedCount 的 ACK 等待上限：重建句柄比普通命令慢得多。 */
export const LED_COUNT_ACK_TIMEOUT_MS = 3000;

export type LedCountParse =
  | { ok: true; value: number }
  | { ok: false; message: string };

/**
 * 把输入框里的原始文本解析成合法灯珠数量。
 *
 * 只接受纯十进制整数（`/^\d+$/`）：`"0x10"`、`"1e2"`、`" 12 "`（修剪后仍含空格的
 * 内部空格）、`"1.5"`、`"+2"` 都不是用户会想输入的数量，一律拒绝而不是「猜」。
 */
export function parseLedCountInput(raw: unknown): LedCountParse {
  if (typeof raw === "number") {
    return validateLedCount(raw);
  }
  if (typeof raw !== "string") {
    return { ok: false, message: "请输入灯珠数量" };
  }
  const text = raw.trim();
  if (text.length === 0) {
    return { ok: false, message: "请输入灯珠数量" };
  }
  if (!/^\d+$/.test(text)) {
    return { ok: false, message: "灯珠数量必须是整数" };
  }
  return validateLedCount(Number(text));
}

function validateLedCount(value: number): LedCountParse {
  if (!Number.isInteger(value)) {
    return { ok: false, message: "灯珠数量必须是整数" };
  }
  if (value < MIN_LEDS) {
    return { ok: false, message: `灯珠数量至少 ${MIN_LEDS} 颗` };
  }
  if (value > MAX_LEDS) {
    return { ok: false, message: `灯珠数量最多 ${MAX_LEDS} 颗` };
  }
  return { ok: true, value };
}

/**
 * 失败结果码 → 给用户的提示。
 *
 * 只覆盖 SetLedCount 真正会遇到的三种：参数非法、设备忙（重建进行中）、
 * 内部错误（句柄重建失败）。其余交给通用的 resultText。
 */
export function ledCountResultHint(resultCode: number): string {
  switch (resultCode) {
    case 0x01:
      return "灯珠数量非法，设备未修改";
    case 0x05:
      return "设备正在应用上一次数量，请稍后重试";
    case 0x09:
      return "设备重建灯带失败，已保留原数量";
    default:
      return "";
  }
}
