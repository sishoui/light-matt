/**
 * 设备标识归一化。
 *
 * 核心事实（docs/protocol.md §2）：广播名 `Lumen-XXXX` 的 XXXX 只是蓝牙 MAC 的
 * 最后 2 个字节，跨手机不变，但在设备数量多时会重名。
 * 而连接后的 `deviceId` 是另一回事：Android 给 MAC，iOS 给每台手机各不相同的
 * UUID —— 它既不稳定也不跨手机一致，**不能**当聚合键。
 *
 * 因此聚合键的优先级是：
 *   1. `hardwareId`（设备自报的 6 字节 BT MAC，即 `DeviceInfoReport` 的 hw_id）
 *      —— 唯一真相，也是设备登记表 `devices.hardware_id` 的同一个值（#50）。
 *   2. 广播名 `name:LUMEN-XXXX` —— 老客户端 / 旧固件读不到 hw_id 时的路径；
 *      「跨手机一致 + 无需改固件」，但只有 16 bit，会撞名。
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

/**
 * 日志聚合键里的硬件 id 片段。
 *
 * #50：小程序现在上报的是 `hw_id`（6 字节 BT MAC），所以这里**先按 MAC 归一化**
 * （`AA:BB:CC:DD:EE:FF` → `aa:bb:cc:dd:ee:ff`），再落到 `hw:` 前缀上。
 * 这一步不能省：同一个 MAC 可能以 `aabbccddeeff` / `AA-BB-...` / `aa:bb:...`
 * 三种形态到达，不归一就会把同一台设备拆成三行——而 #50 要解决的正是
 * 「同一台设备出现两行」。
 *
 * 不是合法 MAC 的字符串（历史客户端 / 测试夹具里的短 id）仍按原样小写处理：
 * 聚合是日志口径，不因为格式不认识就丢数据。
 */
function normalizeHardwareId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const mac = normalizeMacAddress(raw);
  if (mac !== null) return mac.toLowerCase();
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRawDeviceId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 蓝牙 MAC 全地址归一化，输出 `AA:BB:CC:DD:EE:FF`。
 *
 * 与 `normalizeHardwareId` 不是一回事：那个是日志聚合键的一部分（小写、加 `hw:` 前缀），
 * 这里要的是**设备实体的天然主键**（大写冒号、人类可读、跨手机一致）。
 *
 * 接受：`AA:BB:CC:DD:EE:FF` / `aa-bb-cc-dd-ee-ff` / `aabbccddeeff` / 可选 `0x` 前缀。
 * 其余一律返回 null —— 宁可 400，也不要拿脏数据当主键（UNIQUE 一旦被污染无法回滚）。
 */
export function normalizeMacAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const compressed = raw.trim().toLowerCase().replace(/^0x/, "").replace(/[:\-\s]/g, "");
  if (!/^[0-9a-f]{12}$/.test(compressed)) return null;
  const pairs = compressed.match(/.{2}/g);
  if (pairs === null) return null;
  return pairs.join(":").toUpperCase();
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
