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
import { SERVICE_UUID } from "../protocol/constants";
import type { TransportListeners } from "./link-listeners";

const DEVICE_FLUSH_MS = 300;

/** 固件的广播名前缀（`Lumen-%02X%02X`，见 firmware/main/ble_link.c）。 */
const NAME_PREFIX = "lumen-";

/**
 * 这台扫描结果是不是 lumen 设备。
 *
 * 扫描是全量的（不带系统级 `services` 过滤，原因见 transport.startScan），
 * 所以判定必须在这里做。两条判据任一命中即可：
 *
 *  - 广播名以 `Lumen-` 开头；
 *  - 广告包里带 lumen 的 Service UUID。
 *
 * 为什么两条都要：iOS 经常不给 `advertisServiceUUIDs`；而广播名放在扫描
 * 响应包里，某些 Android 机型在只开被动扫描时也拿不到。只留一条会漏设备。
 */
export function isLumenDevice(dev: any): boolean {
  /*
   * 两个名字字段都要看，不能用 `localName ?? name`。
   *
   * Android 上常见 `localName: ""`（空串）配 `name: "Lumen-XXXX"`：空串不是
   * null，`??` 不会回落到 name，于是自己的过滤器把真设备丢掉——现象就是
   * 「手机上搜不到设备」。空白串同理，所以先去空白再判非空。
   */
  const names = [dev?.localName, dev?.name]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter((value) => value.length > 0);
  if (names.some((name) => name.startsWith(NAME_PREFIX))) {
    return true;
  }
  const uuids: unknown = dev?.advertisServiceUUIDs;
  if (!Array.isArray(uuids)) {
    return false;
  }
  const target = SERVICE_UUID.toLowerCase();
  return uuids.some((uuid) => String(uuid).toLowerCase() === target);
}

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
   *
   * **这里是唯一的过滤点**：扫描本身是全量的（不带 `services`，见 transport
   * 的 startScan 注释），所以必须在这里把非 lumen 设备挡掉。判据有两条，
   * 命中任意一条即算 lumen：
   *
   *  1. 广播名以 `Lumen-` 开头（固件用 `Lumen-%02X%02X` 生成）；
   *  2. 广播里带 lumen 的 Service UUID。
   *
   * 两条都要，因为不同平台/机型给的信息不一样：iOS 常常不给
   * `advertisServiceUUIDs`（只在系统缓存里有），而广播名在扫描响应包里、
   * 需要主动 scan 才能拿到。只靠 UUID 会漏，只靠名字会漏掉改名的情况。
   */
  addDevices(found: any[]): boolean {
    let changed = false;
    for (const dev of found) {
      const id = dev?.deviceId;
      if (!id) {
        continue;
      }
      if (!isLumenDevice(dev)) {
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
