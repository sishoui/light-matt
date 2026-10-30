/**
 * 扫描结果缓存与派发：设备表、合并推送、无结果提示。
 *
 * 只负责「扫描期间看到什么」，不碰连接、不碰 GATT。传输层在
 * startScan/stopScan/handleDeviceFound 里驱动它；派发走 TransportListeners，
 * 与会话层/页面订阅的是同一份监听表。
 *
 * 两条节流规则保持拆分前不变：
 *  - 设备列表合并 300ms 再 setData（扫描回调可达每秒多次）；
 *  - 扫描开始后 hintMs 仍无结果才提示权限/定位问题。
 */

import type { DiscoveredDevice } from "../protocol/types";
import type { TransportListeners } from "./link-listeners";

const DEVICE_FLUSH_MS = 300;

export class DeviceScanner {
  private readonly devices = new Map<string, DiscoveredDevice>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private hint: string | null = null;

  constructor(
    private readonly listeners: TransportListeners,
    private readonly hintMs: number,
  ) {}

  get size(): number {
    return this.devices.size;
  }

  get currentHint(): string | null {
    return this.hint;
  }

  /** 开始新一轮扫描：清空设备表并立刻推一次空列表。 */
  reset(): void {
    this.devices.clear();
    this.flushNow();
  }

  /**
   * 记录一批扫描结果；返回是否真的加入了新设备。
   * 广播名优先取扫描响应里的 localName，name 仅兜底。
   */
  addDevices(found: any[]): boolean {
    let changed = false;
    for (const dev of found) {
      const id = dev?.deviceId;
      if (!id) {
        continue;
      }
      const name = dev.localName || dev.name || "(无名)";
      this.devices.set(id, { deviceId: id, name, rssi: dev.RSSI ?? 0 });
      changed = true;
    }
    if (changed) {
      this.scheduleFlush();
    }
    return changed;
  }

  /** 立刻按 rssi 降序推一次设备列表。 */
  flushNow(): void {
    const list = Array.from(this.devices.values()).sort((a, b) => b.rssi - a.rssi);
    this.listeners.emitDevices(list);
  }

  /** 300ms 合并窗口：窗口内多次发现只推一次。 */
  scheduleFlush(): void {
    if (this.flushTimer !== null) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, DEVICE_FLUSH_MS);
  }

  setHint(hint: string | null): void {
    this.hint = hint;
    this.listeners.emitScanHint(hint);
  }

  /** 扫描开始后计时：到时 check() 返回文案才提示（返回 null 表示不提示）。 */
  scheduleHint(check: () => string | null): void {
    this.clearHintTimer();
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      const hint = check();
      if (hint !== null) {
        this.setHint(hint);
      }
    }, this.hintMs);
  }

  clearHintTimer(): void {
    if (this.hintTimer !== null) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
  }

  /** 停止扫描 / 销毁时的统一清理：取消合并窗口与提示计时。 */
  clearTimers(): void {
    this.clearHintTimer();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
