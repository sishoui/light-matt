/**
 * 使用日志的事件构造与本地身份。
 *
 * ## 记录什么
 *
 * 一条记录 = 「谁 × 哪台 × 什么时候连上」。字段严格对应后端
 * `POST /api/v1/usage-logs` 的请求体（见 `server/README.md` §2.1）：
 *
 * ```json
 * {
 *   "userKey": "local-...",
 *   "startedAt": 1760000000000,
 *   "clientEventId": "...",
 *   "device": { "deviceName": "Lumen-1A2B", "deviceId": "AA:BB:...", "platform": "android" }
 * }
 * ```
 *
 * **不记录任何实时控制数据**：没有颜色、亮度、开关、灯珠数、分段、剧本、命令字节。
 * `tests/usage.test.ts` 有一条用例逐字段断言这一点。
 *
 * ## userKey 的来源（个人测试阶段的决定）
 *
 * 正式形态应当是 `wx.login()` → `code2session` → `openid`。本票不引入登录流程，
 * 所以这里退化为**本机生成的稳定随机串**（`local-xxxxxxxx`），首次使用时写入
 * storage，之后同一安装永远复用：
 *
 *  - 诚实地说：它不是 openid，不能跨手机识别同一个人；同一人换手机 = 两个用户。
 *  - 但它满足本阶段的运维问题「这台设备最近有没有人用」，且重装/清缓存前稳定。
 *  - 接入 `code2session` 后只需把 `getOrCreateLocalUserKey()` 换成 openid 来源，
 *    后端与 `userKey` 字段都不用改。
 *
 * ## 设备身份如实上报
 *
 * `deviceName` 是广播名（后端据此跨手机聚合），`deviceId` 是平台原始 id
 * （Android=MAC，iOS=UUID），只作诊断证据。两端都照实上报，不在小程序里
 * 做归一或猜测。
 */

/** 后端接受的平台值。`other`（含开发者工具）如实记为 `unknown`。 */
export type UsagePlatform = "android" | "ios" | "devtools" | "unknown";

export interface UsageDevice {
  deviceName: string | null;
  deviceId: string | null;
  platform: UsagePlatform;
}

/** 上报体（字段名与后端一致）。 */
export interface UsageEvent {
  userKey: string;
  startedAt: number;
  clientEventId: string;
  device: UsageDevice;
}

/** 一次成功连接的身份信息（session 在 ready 时提供）。 */
export interface ConnectionIdentity {
  deviceName: string | null;
  deviceId: string | null;
  platform: "android" | "ios" | "other";
}

export const LOCAL_USER_KEY_STORAGE_KEY = "lumen.usage.userkey.v1";

/**
 * 平台归一：小程序只有 android / ios / other（devtools 归 other）。
 * 后端枚举是 android | ios | devtools | unknown —— 无法区分 devtools 时记 unknown
 * 才是诚实的；把 other 猜成 devtools 会制造假数据。
 */
export function toUsagePlatform(platform: "android" | "ios" | "other"): UsagePlatform {
  if (platform === "android") return "android";
  if (platform === "ios") return "ios";
  return "unknown";
}

/** 32 bit 随机 hex。Math.random 足够——这是诊断标识，不是安全令牌。 */
function randomHex(random: () => number, bytes: number): string {
  let out = "";
  for (let i = 0; i < bytes; i += 1) {
    const value = Math.floor(random() * 256) & 0xff;
    out += value.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * UUID v4 形状的 clientEventId（幂等键）。
 * 不依赖 `crypto.randomUUID`：小程序基础库不保证有它，且后端只要求唯一。
 */
export function createClientEventId(random: () => number = Math.random): string {
  const hex = randomHex(random, 16).split("");
  // version 4 / variant 10xx（只改十六进制字符，保持形状可读）。
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** 本机稳定身份：`local-` + 16 hex。首次生成后写入 storage。 */
export function createLocalUserKey(random: () => number = Math.random): string {
  return `local-${randomHex(random, 8)}`;
}

/**
 * 取（或首次生成）本机 userKey。
 * storage 读写失败时返回一个进程内临时值，绝不抛错——日志是旁路。
 */
export function getOrCreateLocalUserKey(
  storage: { get(key: string): string | null; set(key: string, value: string): void },
  random: () => number = Math.random,
): string {
  const existing = storage.get(LOCAL_USER_KEY_STORAGE_KEY);
  if (existing !== null && existing.length > 0) {
    return existing;
  }
  const created = createLocalUserKey(random);
  storage.set(LOCAL_USER_KEY_STORAGE_KEY, created);
  return created;
}

/** 由连接身份构造一条待上报记录。纯函数，便于单测。 */
export function buildUsageEvent(input: {
  userKey: string;
  startedAt: number;
  clientEventId: string;
  device: ConnectionIdentity;
}): UsageEvent {
  const name =
    input.device.deviceName !== null && input.device.deviceName.trim().length > 0
      ? input.device.deviceName.trim()
      : null;
  const id =
    input.device.deviceId !== null && input.device.deviceId.trim().length > 0
      ? input.device.deviceId.trim()
      : null;
  return {
    userKey: input.userKey,
    startedAt: input.startedAt,
    clientEventId: input.clientEventId,
    device: {
      deviceName: name,
      deviceId: id,
      platform: toUsagePlatform(input.device.platform),
    },
  };
}
