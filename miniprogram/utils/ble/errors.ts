/**
 * 错误文案与错误码分诊。
 *
 * 依据 docs/ble-notes.md 与 spec §9：10001 非致命（等适配器），
 * 10006 走重连不重试写，10008 先怀疑「notify 后立即写」，
 * iOS 的 fail state 0-4 必须映射成可读文案。
 */

import { WxCallError, WxCallTimeoutError } from "./wx-promise";

export type TriageAction =
  | "reconnect" /* 连接已断：走重连，不重试写 */
  | "retry-after-gap" /* 疑似 notify 后立即写：等 300-500ms 重试一次 */
  | "wait-adapter" /* 蓝牙未开：显示「请打开蓝牙」，等适配器事件 */
  | "reinit" /* 模块未初始化 / 无服务：重新 openAdapter 或重连一次 */
  | "fatal"; /* 无法恢复：提示用户 */

const ERROR_TEXT: Record<number, string> = {
  [-1]: "设备已连接",
  [10000]: "蓝牙模块未初始化",
  [10001]: "请打开蓝牙",
  [10002]: "没有找到设备，请重新扫描",
  [10003]: "连接失败，设备可能已被其他手机连接",
  [10004]: "没有找到服务，请检查固件",
  [10005]: "没有找到特征值，请检查固件",
  [10006]: "连接已断开",
  [10007]: "特征值不支持该操作",
  [10008]: "系统蓝牙异常，正在重试",
  [10009]: "当前系统不支持 BLE",
  [10012]: "操作超时",
  [10013]: "设备标识无效，请重新扫描",
};

export function triage(err: unknown): TriageAction {
  if (err instanceof WxCallTimeoutError) {
    return "reconnect";
  }
  const code = err instanceof WxCallError ? err.errCode : undefined;
  switch (code) {
    case 10006:
      return "reconnect";
    case 10008:
      return "retry-after-gap";
    case 10001:
      return "wait-adapter";
    case 10000:
    case 10004:
    case 10005:
      return "reinit";
    default:
      return "fatal";
  }
}

/** iOS openBluetoothAdapter fail 的 state 0-4。 */
export function iosStateText(state: number | undefined): string {
  switch (state) {
    case 0:
      return "蓝牙状态未知，请稍后重试";
    case 1:
      return "蓝牙正在重置，请稍后重试";
    case 2:
      return "当前系统不支持 BLE";
    case 3:
      return "未授权微信使用蓝牙，请在系统设置中允许";
    case 4:
      return "请打开蓝牙";
    default:
      return "蓝牙不可用";
  }
}

/** 把任意错误折成一句给用户看的话。 */
export function errorText(err: unknown): string {
  if (err == null) {
    return "未知错误";
  }
  if (err instanceof WxCallError || err instanceof WxCallTimeoutError) {
    if (err instanceof WxCallError && err.errCode !== undefined) {
      const known = ERROR_TEXT[err.errCode];
      if (known) {
        return known;
      }
    }
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** 非零结果码的提示文案（ACK 结果码，protocol §5）。 */
export function resultText(resultCode: number): string {
  switch (resultCode) {
    case 0x01:
      return "参数非法";
    case 0x02:
      return "设备不支持该命令";
    case 0x03:
      return "校验失败";
    case 0x04:
      return "帧长度错误";
    case 0x05:
      return "设备忙，请稍后重试";
    case 0x06:
      return "设备存储失败";
    case 0x07:
      return "协议版本不匹配，请升级固件";
    case 0x08:
      return "帧头错误";
    case 0x09:
      return "设备内部错误";
    default:
      return `设备返回错误码 0x${resultCode.toString(16).padStart(2, "0")}`;
  }
}
