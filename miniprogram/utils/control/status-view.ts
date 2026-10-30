/**
 * 连接状态条 → 展示字段（纯函数，UI 与测试共用）。
 *
 * #11 断线语义：
 *  - 非主动断线后链路进入 idle（detail.reconnectable），状态条立即显示「未连接」，
 *    **不保留任何过期设备状态**；
 *  - 自动回连进行中（reconnectPending）副标题说明进度，动作按钮收起，
 *    避免用户以为可以重复点击；
 *  - 退避耗尽后链路停在 failed，仍显示「未连接」，有 deviceId 缓存时给「重连」，
 *    否则给「扫描」——这是唯一的手动入口，不会无限自动循环。
 */

import type { LinkState } from "../protocol/types";

export interface StatusView {
  statusText: string;
  statusSub: string;
  statusAction: string;
  linkClass: string;
}

export function statusView(
  state: LinkState,
  deviceName: string,
  message?: string,
  reconnectPending = false,
  hasCachedDevice = false,
): StatusView {
  switch (state) {
    case "ready":
      return {
        statusText: `已连接 · ${deviceName || "设备"}`,
        statusSub: "点击查看设备",
        statusAction: "设备",
        linkClass: "link-ready",
      };
    case "scanning":
      return {
        statusText: "扫描中…",
        statusSub: message ?? "正在查找 Lumen 设备",
        statusAction: "停止",
        linkClass: "link-busy",
      };
    case "connecting":
      return {
        statusText: "连接中…",
        statusSub: deviceName,
        statusAction: "取消",
        linkClass: "link-busy",
      };
    case "initializing":
      return {
        statusText: "同步状态…",
        statusSub: deviceName,
        statusAction: "取消",
        linkClass: "link-busy",
      };
    case "reconnecting":
      return {
        statusText: "正在重连…",
        statusSub: message ?? "正在尝试恢复连接",
        statusAction: "",
        linkClass: "link-busy",
      };
    case "adapter-off":
      return {
        statusText: "请打开蓝牙",
        statusSub: message ?? "打开系统蓝牙后会自动继续",
        statusAction: "重试",
        linkClass: "link-warn",
      };
    case "failed":
      return {
        statusText: "未连接",
        statusSub: message ?? "连接失败",
        // 退避耗尽：有缓存时一键重连，否则回扫描。
        statusAction: hasCachedDevice ? "重连" : "扫描",
        linkClass: "link-error",
      };
    case "idle":
      if (reconnectPending) {
        return {
          statusText: "未连接",
          statusSub: message ?? "正在自动重连…",
          statusAction: "",
          linkClass: "link-busy",
        };
      }
      return {
        statusText: "未连接",
        statusSub: message ?? "点击选择设备",
        statusAction: hasCachedDevice ? "重连" : "扫描",
        linkClass: "link-idle",
      };
    default:
      return {
        statusText: "未连接",
        statusSub: "点击选择设备",
        statusAction: "扫描",
        linkClass: "link-idle",
      };
  }
}
