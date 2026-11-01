/**
 * 参数校验 + 错误码。不引第三方 schema 校验库：字段只有 8 个，
 * 手写校验能给出中文可读的错误，也避免 schema 与类型两份真相。
 */

import { normalizeMacAddress } from "./identity.js";

export interface DevicePayload {
  hardwareId?: unknown;
  deviceName?: unknown;
  deviceId?: unknown;
  platform?: unknown;
}

export interface LogPayload {
  userKey?: unknown;
  displayName?: unknown;
  device?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  clientEventId?: unknown;
}

export type Validated = {
  userKey: string;
  displayName: string | null;
  startedAt: number;
  endedAt: number | null;
  clientEventId: string;
  device: {
    hardwareId: string | null;
    deviceName: string | null;
    deviceId: string | null;
    platform: "android" | "ios" | "devtools" | "unknown";
  };
};

export interface ValidationError {
  field: string;
  message: string;
}

const MAX_TEXT = 128;
const PLATFORMS = new Set(["android", "ios", "devtools", "unknown"]);

function optionalString(value: unknown, field: string, errors: ValidationError[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    errors.push({ field, message: "必须是字符串" });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_TEXT) {
    errors.push({ field, message: `长度不能超过 ${MAX_TEXT}` });
    return null;
  }
  return trimmed;
}

function requiredTimestamp(value: unknown, field: string, errors: ValidationError[]): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    errors.push({ field, message: "必须是正的整型毫秒时间戳" });
    return null;
  }
  return value;
}

/**
 * 设备自报的硬件 id（#50）：归一化成 `AA:BB:CC:DD:EE:FF`。
 *
 * 归一化而不是报错：使用日志是旁路，一个诊断字段写格式不对就整条 400，
 * 会把「谁在什么时候用了哪台设备」这条事实丢掉。无法解析一律当作**没带**
 * （之后按广播名 / deviceId 的旧逻辑聚合），老客户端的行为因此完全不变。
 *
 * 与 `validateRegisterPayload` 的 hardwareId 同一口径（`normalizeMacAddress`），
 * 这样日志聚合键与 `devices.hardware_id` 是同一串字符。
 */
function optionalHardwareId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return normalizeMacAddress(value);
}

export function validateLogPayload(body: unknown): { ok: true; value: Validated } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "必须是 JSON 对象" }] };
  }
  const payload = body as LogPayload;

  const userKey = optionalString(payload.userKey, "userKey", errors);
  if (userKey === null && errors.length === 0) {
    errors.push({ field: "userKey", message: "必填" });
  }
  const displayName = optionalString(payload.displayName, "displayName", errors);
  const clientEventId = optionalString(payload.clientEventId, "clientEventId", errors);
  if (clientEventId === null && !errors.some((e) => e.field === "clientEventId")) {
    errors.push({ field: "clientEventId", message: "必填（用于断网补报去重）" });
  }
  const startedAt = requiredTimestamp(payload.startedAt, "startedAt", errors);

  let endedAt: number | null = null;
  if (payload.endedAt !== undefined && payload.endedAt !== null) {
    endedAt = requiredTimestamp(payload.endedAt, "endedAt", errors);
  }
  if (endedAt !== null && startedAt !== null && endedAt < startedAt) {
    errors.push({ field: "endedAt", message: "不能早于 startedAt" });
  }

  const rawDevice = payload.device;
  const device: Validated["device"] = {
    hardwareId: null,
    deviceName: null,
    deviceId: null,
    platform: "unknown",
  };
  if (typeof rawDevice !== "object" || rawDevice === null || Array.isArray(rawDevice)) {
    errors.push({ field: "device", message: "必填，且必须是对象" });
  } else {
    const d = rawDevice as DevicePayload;
    /* #50：hardwareId 可选；格式不对就当作没带，不 400（见 optionalHardwareId）。 */
    device.hardwareId = optionalHardwareId(d.hardwareId);
    device.deviceName = optionalString(d.deviceName, "device.deviceName", errors);
    device.deviceId = optionalString(d.deviceId, "device.deviceId", errors);
    if (d.platform !== undefined) {
      if (typeof d.platform !== "string" || !PLATFORMS.has(d.platform)) {
        errors.push({
          field: "device.platform",
          message: "必须是 android | ios | devtools | unknown",
        });
      } else {
        const p = d.platform;
        if (p === "android" || p === "ios" || p === "devtools" || p === "unknown") {
          device.platform = p;
        }
      }
    }
    if (
      device.hardwareId === null &&
      device.deviceName === null &&
      device.deviceId === null &&
      !errors.some((e) => e.field.startsWith("device."))
    ) {
      errors.push({
        field: "device",
        message: "hardwareId / deviceName / deviceId 至少提供一个",
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      userKey: userKey as string,
      displayName,
      startedAt: startedAt as number,
      endedAt,
      clientEventId: clientEventId as string,
      device,
    },
  };
}

// ---------------------------------------------------------------- 会话 + 设备
// 下面几个校验器只认白名单字段：请求体里塞 rgb / brightness / segment / script
// 之类的东西会被**直接忽略**，既不会 400 也不会落库。理由见 schema.ts v2 注释。

/** 本地身份的字面量格式，与小程序 `getOrCreateLocalUserKey` 保持一致。 */
const LOCAL_USER_KEY = /^local-[0-9a-f]{16}$/;

export interface SessionPayload {
  /** 本地模式下是自称的 user_key；openid 模式下被忽略。 */
  userKey: string | null;
  /** 配了 AppSecret 时必填。 */
  code: string | null;
}

export function validateSessionPayload(
  body: unknown,
): { ok: true; value: SessionPayload } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "必须是 JSON 对象" }] };
  }
  const payload = body as { userKey?: unknown; code?: unknown };

  let userKey: string | null = null;
  if (payload.userKey !== undefined && payload.userKey !== null) {
    if (typeof payload.userKey !== "string") {
      errors.push({ field: "userKey", message: "必须是字符串" });
    } else if (!LOCAL_USER_KEY.test(payload.userKey)) {
      // 本地身份可伪造，但格式必须对：否则任意字符串都能当 user_key，
      // 设备归属会变成一锅粥。openid 只有微信能给，不接受自称。
      errors.push({ field: "userKey", message: "本地身份必须形如 local-<16 位小写 hex>" });
    } else {
      userKey = payload.userKey;
    }
  }

  let code: string | null = null;
  if (payload.code !== undefined && payload.code !== null) {
    if (typeof payload.code !== "string" || payload.code.trim().length === 0) {
      errors.push({ field: "code", message: "必须是非空字符串" });
    } else {
      code = payload.code.trim();
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { userKey, code } };
}

/** 必需的用户标识头：只校验非空与长度，不校验格式（信任边界见 app.ts）。 */
export function validateUserKeyHeader(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;
  return trimmed;
}

export interface RegisterPayload {
  hardwareId: string;
  displayName: string | null;
}

export function validateRegisterPayload(
  body: unknown,
): { ok: true; value: RegisterPayload } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "必须是 JSON 对象" }] };
  }
  const payload = body as { hardwareId?: unknown; displayName?: unknown };

  const hardwareId = normalizeMacAddress(
    typeof payload.hardwareId === "string" ? payload.hardwareId : null,
  );
  if (hardwareId === null) {
    errors.push({ field: "hardwareId", message: "必填，且必须是 48 位蓝牙 MAC 地址" });
  }
  const displayName = optionalString(payload.displayName, "displayName", errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { hardwareId: hardwareId as string, displayName } };
}

export function validateRenamePayload(
  body: unknown,
): { ok: true; value: { displayName: string } } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "必须是 JSON 对象" }] };
  }
  const payload = body as { displayName?: unknown };
  // 改名不允许「改成空」来清除备注：清空在 UI 上是另一种操作，
  // 混进同一个接口会让 PATCH 的语义变成两义（改名 / 删名）。
  if (typeof payload.displayName !== "string") {
    return { ok: false, errors: [{ field: "displayName", message: "必填，且必须是字符串" }] };
  }
  const trimmed = payload.displayName.trim();
  if (trimmed.length === 0) {
    return { ok: false, errors: [{ field: "displayName", message: "不能为空" }] };
  }
  if (trimmed.length > MAX_TEXT) {
    return { ok: false, errors: [{ field: "displayName", message: `长度不能超过 ${MAX_TEXT}` }] };
  }
  return { ok: true, value: { displayName: trimmed } };
}

const MAX_STRIPS = 16;
const MAX_FIRMWARE_VER = 65_535;

export interface SeenPayload {
  ledCounts: number[] | null;
  firmwareVer: number | null;
}

export function validateSeenPayload(
  body: unknown,
): { ok: true; value: SeenPayload } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  // 空 body（没 Content-Type / 空对象）是合法的：只推进 last_seen_at。
  if (body === undefined || body === null) return { ok: true, value: { ledCounts: null, firmwareVer: null } };
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "必须是 JSON 对象" }] };
  }
  const payload = body as { ledCounts?: unknown; firmwareVer?: unknown };

  let ledCounts: number[] | null = null;
  if (payload.ledCounts !== undefined && payload.ledCounts !== null) {
    if (!Array.isArray(payload.ledCounts)) {
      errors.push({ field: "ledCounts", message: "必须是正整数数组" });
    } else if (payload.ledCounts.length > MAX_STRIPS) {
      errors.push({ field: "ledCounts", message: `最多 ${MAX_STRIPS} 条灯带` });
    } else {
      const parsed: number[] = [];
      let bad = false;
      for (const value of payload.ledCounts) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
          bad = true;
          break;
        }
        parsed.push(value);
      }
      if (bad) errors.push({ field: "ledCounts", message: "每项都必须是正整数" });
      else ledCounts = parsed;
    }
  }

  let firmwareVer: number | null = null;
  if (payload.firmwareVer !== undefined && payload.firmwareVer !== null) {
    const value = payload.firmwareVer;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > MAX_FIRMWARE_VER
    ) {
      errors.push({ field: "firmwareVer", message: `必须是 0..${MAX_FIRMWARE_VER} 的整数` });
    } else {
      firmwareVer = value;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { ledCounts, firmwareVer } };
}
