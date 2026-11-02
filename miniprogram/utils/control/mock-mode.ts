/**
 * 演示模式（mock）的开关与数据播种。
 *
 * ## 为什么不是「页面里放假数组」
 *
 * 首页要知道「有哪些设备、哪台连着、亮度多少、几条灯带」，这些在真实链路里
 * 由 `session.recentDevices` / `session.deviceState` / 设备登记表提供。如果在
 * 页面里另写一份假数据，那么点击小图切换、进详情、拖亮度都只能做假动作，
 * 接上真机时整层要推翻重写。
 *
 * 所以这里做两件事，都发生在**真实数据结构**上：
 *  1. `seedMockDevices` —— 把演示设备写进 `lumen.recentDevices.v2` 与
 *     `lumen.deviceRegistry.v1`（与真机连接成功时写的完全同构）；
 *  2. `MockTransport` —— 连接演示设备时产出与真机同形的 State / DeviceInfo /
 *     StripConfig / SegmentReport，写命令真的改状态。
 *
 * ## 开关语义
 *
 * - 没有任何真实设备记录 → 默认开启（否则首次打开是空白首页，看不到设计）；
 * - 有真实设备记录 → 默认关闭（真机优先，不会混进假设备）；
 * - 用户在「发现」页底部显式切换过 → 以用户选择为准。
 */

import type { SessionStorage } from "./device-cache";
import { loadRecentDevices, RECENT_DEVICES_KEY, type RecentDevice } from "./device-history";
import {
  ALL_STRIPS_MASK,
  DEVICE_REGISTRY_KEY,
  loadRegistry,
  type DeviceRegistry,
} from "./device-registry";
import { MOCK_DEVICES } from "./mock-devices";

/** 用户显式选择（"1" 开 / "0" 关）；不存在表示「按有没有真机自动判断」。 */
export const MOCK_PREF_KEY = "lumen.mockMode.v1";

/** 播种时写的标记：这些 deviceId 是演示数据，删除时不该当成真设备。 */
export const MOCK_DEVICE_IDS: readonly string[] = MOCK_DEVICES.map((spec) => spec.deviceId);

export function isMockDeviceId(deviceId: string): boolean {
  return MOCK_DEVICE_IDS.includes(deviceId);
}

/**
 * 是否启用演示模式。
 *
 * 判断顺序（后面的不会覆盖前面的）：
 *  1. 用户显式开关；
 *  2. 已有真实设备记录 → 关闭；
 *  3. 否则 → 按运行环境决定（见 `mockDefaultForEnv`）。
 */
export function mockModeEnabled(
  storage: SessionStorage,
  /** 当前运行环境；省略时按「自动开启」（模拟器/测试路径）。 */
  env?: MockEnv,
): boolean {
  const pref = storage.get(MOCK_PREF_KEY);
  if (pref === "1") {
    return true;
  }
  if (pref === "0") {
    return false;
  }
  if (hasRealDevices(storage)) {
    return false;
  }
  return mockDefaultForEnv(env);
}

/** 运行环境（只影响「没有真机记录时」的默认值）。 */
export interface MockEnv {
  /** `wx.getDeviceInfo().platform`；开发者工具是 `devtools`。 */
  platform?: string;
}

/**
 * 自动判断时，这台环境该不该默认开演示模式。
 *
 * **只有开发者工具（模拟器）默认开。** 真机上必须默认关：
 *
 *  - 模拟器没有 BLE 外设，`openBluetoothAdapter` 会超时，页面什么都看不到；
 *    演示数据让设计可见，这是它存在的理由。
 *  - 真机有 BLE。若也默认开演示模式，`MockTransport` 根本不会去扫真实蓝牙，
 *    于是永远拿不到真机记录 → 自动开启条件永远成立 → **死循环**，
 *    用户必须在「发现」页底部找到那个开关才出得来。表现就是
 *    「手机上预览搜不到我的设备」（其实扫的是假设备）。
 */
export function mockDefaultForEnv(env?: MockEnv): boolean {
  const platform = String(env?.platform ?? "").toLowerCase();
  return platform === "devtools";
}

/**
 * 让存储与演示模式开关保持一致（App 启动时调用一次）。
 *
 * 两个方向都要收敛，否则会出现「看起来像真机」的脏数据：
 *  - 开关关着、但演示设备还留在 recent/registry 里 → 清掉；
 *  - 开关开着（或自动开启）→ 播种（幂等）。
 *
 * 返回最终是否处于演示模式。
 */
export function reconcileMockMode(
  storage: SessionStorage,
  nowMs: number = Date.now(),
  env?: MockEnv,
): boolean {
  const enabled = mockModeEnabled(storage, env);
  if (enabled) {
    seedMockDevices(storage, nowMs);
    return true;
  }
  /* 关着（无论是用户显式关的，还是因为已经有真机记录）：把演示设备清掉，
   * 免得它们混在「我的设备」里被当成真机。 */
  clearMockDevices(storage);
  return false;
}

export function setMockMode(storage: SessionStorage, enabled: boolean): void {
  storage.set(MOCK_PREF_KEY, enabled ? "1" : "0");
}

/** 真机记录的判定：只要有一条不是演示设备，就算有真机。 */
export function hasRealDevices(storage: SessionStorage): boolean {
  const recent = loadRecentDevices(storage);
  if (recent.some((entry) => !isMockDeviceId(entry.deviceId))) {
    return true;
  }
  const registry = loadRegistry(storage);
  return registry.devices.some((entry) => !isMockDeviceId(entry.deviceId));
}

/**
 * 把演示设备写进最近连接列表与设备登记表。
 *
 * 幂等：已经存在的设备不会重置时间戳（否则用户每次启动都会看到「刚刚」）。
 * **必须在 `ControlSession` 构造之前调用**——它只在构造时读一次
 * `recentDevices`，之后再写 storage 不会刷新已存在的实例。
 */
export function seedMockDevices(storage: SessionStorage, nowMs: number = Date.now()): void {
  const existing = loadRecentDevices(storage);
  const knownIds = new Set(existing.map((entry) => entry.deviceId));
  const additions: RecentDevice[] = MOCK_DEVICES.filter(
    (spec) => !knownIds.has(spec.deviceId),
  ).map((spec, index) => ({
    deviceId: spec.deviceId,
    hardwareId: spec.hwId,
    name: spec.broadcastName,
    /* 递减 1 小时，让「书桌」排在最前面（与 spec 的声明顺序一致）。 */
    lastConnectedAt: nowMs - (index + 1) * 3_600_000,
    stripCount: spec.stripCounts.filter((count) => count > 0).length,
    firmwareVer: 0x0300,
  }));
  if (additions.length > 0) {
    storage.set(RECENT_DEVICES_KEY, JSON.stringify([...existing, ...additions]));
  }

  const registry = loadRegistry(storage);
  const knownRegistry = new Set(registry.devices.map((entry) => entry.deviceId));
  const entries = MOCK_DEVICES.filter((spec) => !knownRegistry.has(spec.deviceId)).map((spec) => ({
    deviceId: spec.deviceId,
    hardwareId: spec.hwId,
    stripMask: ALL_STRIPS_MASK,
    lastSeenAt: nowMs,
    ...(spec.remark.length > 0 ? { remark: spec.remark } : {}),
  }));
  if (entries.length > 0) {
    const next: DeviceRegistry = { devices: [...registry.devices, ...entries] };
    storage.set(DEVICE_REGISTRY_KEY, JSON.stringify(next));
  }
}

/**
 * 移除全部演示设备（关掉演示模式时调用）。
 *
 * 只删 deviceId 命中演示清单的记录；真机记录一条不动。
 */
export function clearMockDevices(storage: SessionStorage): void {
  const recent = loadRecentDevices(storage).filter((entry) => !isMockDeviceId(entry.deviceId));
  storage.set(RECENT_DEVICES_KEY, JSON.stringify(recent));
  const registry = loadRegistry(storage);
  storage.set(
    DEVICE_REGISTRY_KEY,
    JSON.stringify({ devices: registry.devices.filter((entry) => !isMockDeviceId(entry.deviceId)) }),
  );
}
