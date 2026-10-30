/**
 * 参数校验 + 错误码。不引第三方 schema 校验库：字段只有 8 个，
 * 手写校验能给出中文可读的错误，也避免 schema 与类型两份真相。
 */

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
    device.hardwareId = optionalString(d.hardwareId, "device.hardwareId", errors);
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
