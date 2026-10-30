/**
 * 设备标识归一化。
 *
 * 核心事实（docs/protocol.md §2）：广播名 `Lumen-XXXX` 的 XXXX 只是蓝牙 MAC 的
 * 最后 2 个字节，跨手机不变，但在设备数量多时会重名。
 * 而连接后的 `deviceId` 是另一回事：Android 给 MAC，iOS 给每台手机各不相同的
 * UUID —— 它既不稳定也不跨手机一致，**不能**当聚合键。
 *
 * 因此聚合键的优先级是：
 *   1. `hardwareId`（设备自报的稳定硬件 id，例如芯片 MAC）—— 唯一真相。
 *   2. 广播名 `name:LUMEN-XXXX` —— 当前唯一同时「跨手机一致 + 无需改固件」的标识。
 *   3. `raw:<platform>:<deviceId>` —— 兜底（没有广播名时），分组会按手机分裂，
 *      只保证「不是丢数据」，不保证聚合正确。
 */
export const PLATFORMS = ["android", "ios", "devtools", "unknown"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type DeviceKeyKind = "hardware" | "name" | "raw";

export interface DeviceIdentityInput {
  readonly hardwareId?: string | null;
  readonly deviceName?: string | null;
  readonly deviceId?: string | null;
  readonly platform: Platform;
}

export interface ResolvedDeviceKey {
  /** 写进 usage_logs.device_key 的值，也是聚合的分组键。 */
  readonly key: string;
  readonly kind: DeviceKeyKind;
  /** 归一化后的广播名，没有则为 null。 */
  readonly name: string | null;
}

export function normalizeBroadcastName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHardwareId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRawDeviceId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveDeviceKey(input: DeviceIdentityInput): ResolvedDeviceKey {
  const name = normalizeBroadcastName(input.deviceName);
  const hardwareId = normalizeHardwareId(input.hardwareId);
  if (hardwareId !== null) {
    return { key: `hw:${hardwareId}`, kind: "hardware", name };
  }
  if (name !== null) {
    return { key: `name:${name}`, kind: "name", name };
  }
  const rawId = normalizeRawDeviceId(input.deviceId);
  if (rawId !== null) {
    return { key: `raw:${input.platform}:${rawId}`, kind: "raw", name };
  }
  throw new Error("resolveDeviceKey 需要 hardwareId / deviceName / deviceId 之一");
}
