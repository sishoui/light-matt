/**
 * 设备同步 API（#44）：会话身份 + 设备登记接口的唯一客户端。
 *
 * ## 三条硬约束
 *
 * 1. **旁路，不是控制路径**：所有方法都返回结果对象，**永不抛出**。调用方
 *    （设备页）拿到 `{ok:false}` 后继续用本地列表，BLE 控制一个字节都不受影响。
 * 2. **身份先于设备**：后端在 `users` 行存在前对设备接口一律 404 `unknown_user`，
 *    所以 `POST /api/v1/session` 必须先成功，之后每个设备请求都带
 *    `x-lumen-user-key`（后端明示这是自称、不做访问控制，见 server.md §4）。
 * 3. **后端缓存不是权威**：`ledCounts` / `firmwareVer` 只会上报、只作离线展示，
 *    永远不会被当成设备的当前配置（docs/spec-v3.md §2.2）。
 *
 * ## 重试策略
 *
 * 只有**瞬时失败**（网络异常 / 超时 / 5xx / 429 / 408）**静默重试一次**；
 * 4xx 是确定性拒绝，重试只会重复撞墙。`404 unknown_user` 是特例：后端库被
 * 重置后旧 userKey 失效，重建一次会话再试一次（仍然只多一次请求）。
 *
 * 纯逻辑 + 注入 `HttpFetch` / storage / 计时器：node 单测里零 wx 依赖。
 */

import { loadUsageConfig, type UsageConfig } from "../usage/config";
import type { HttpFetch, HttpMethod, HttpResponse } from "../usage/http";
import type { UsageStorage } from "../usage/storage";

/** 后端字段名（与 server/src/app.ts 一致，只在这里写一次）。 */
export const APP_TOKEN_HEADER = "x-lumen-app-token";
export const USER_KEY_HEADER = "x-lumen-user-key";

export const SESSION_PATH = "/api/v1/session";
export const DEVICES_PATH = "/api/v1/devices";

/** 身份缓存键。带版本号：`identityKind` 的语义以后可能扩展。 */
export const IDENTITY_STORAGE_KEY = "lumen.identity.v1";

/** 后端明示的身份种类：`local` = 仅本机可见，`openid` = 跨设备同步。 */
export type IdentityKind = "local" | "openid";

export interface DeviceIdentity {
  /** 后端认的 key；openid 模式下**不是**本地生成的 `local-...`。 */
  readonly userKey: string;
  readonly identityKind: IdentityKind;
  /** 后端给的提示位（不是权限开关）。 */
  readonly trusted: boolean;
}

/** GET /api/v1/devices 的一行。缓存字段见上：非权威。 */
export interface SyncedDevice {
  readonly id: number;
  readonly hardwareId: string;
  readonly displayName: string | null;
  readonly lastSeenAt: number;
  readonly addedAt: number;
  /** 后端缓存（非权威）：上次上报的逐带灯珠数。 */
  readonly ledCounts: number[] | null;
  /** 后端缓存（非权威）：上次上报的固件版本。 */
  readonly firmwareVer: number | null;
}

/** `POST /devices/:id/seen` 的响应（后端回显整行）。 */
export interface SeenDevice {
  readonly id: number;
  readonly hardwareId: string;
  readonly displayName: string | null;
  readonly lastSeenAt: number;
  readonly ledCounts: number[] | null;
  readonly firmwareVer: number | null;
}

export interface RegisteredDevice {
  readonly deviceId: number;
  readonly hardwareId: string;
  readonly displayName: string | null;
}

/** 失败原因：页面据此决定提示文案，不需要解析 HTTP。 */
export type ApiFailureReason =
  /** 未配置后端（baseUrl / appToken 缺失）：功能关闭，不是错误。 */
  | "disabled"
  /** 网络不可达 / 超时：显示「离线，仅显示本机记录」。 */
  | "offline"
  /** 后端 5xx：同样按离线处理，但可区分诊断。 */
  | "server"
  /** 401/403：app token 错或身份被拒。 */
  | "unauthorized"
  /** 其它 4xx（400 参数非法 / 404 设备不在列表里 / 409 …）。 */
  | "rejected";

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ApiFailureReason };

interface ApiTimer {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface DeviceApiOptions {
  readonly config: UsageConfig;
  readonly fetch: HttpFetch;
  readonly storage: UsageStorage;
  /**
   * 本地身份来源。生产是 `getOrCreateLocalUserKey`（`local-<16hex>`）；
   * 可注入以便测试固定键。只在 session 请求里用，**不**直接当 userKey 用：
   * 以后端返回的为准（openid 模式下完全不同）。
   */
  readonly localUserKey: () => string;
  readonly timer?: ApiTimer;
}

const defaultTimer: ApiTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** 一次 HTTP 尝试的结论。`retry` 表示瞬时失败（可再试一次）。 */
type Attempt<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "retry"; readonly reason: "offline" | "server" }
  | { readonly kind: "unknown_user" }
  | { readonly kind: "fail"; readonly reason: ApiFailureReason };

/** `send` 的结论：成功后只带回原始 body，解析交给各接口（形状不同）。 */
type SendOutcome =
  | { readonly kind: "ok"; readonly body: string }
  | { readonly kind: "retry"; readonly reason: "offline" | "server" }
  | { readonly kind: "unknown_user" }
  | { readonly kind: "fail"; readonly reason: ApiFailureReason };

function parseJson(body: string): unknown {
  if (body.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseLedCounts(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item) || item <= 0) {
      return null;
    }
    out.push(item);
  }
  return out;
}

function parseSyncedDevice(value: unknown): SyncedDevice | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = numberOrNull(value.id);
  const hardwareId = stringOrNull(value.hardwareId);
  if (id === null || hardwareId === null) {
    return null;
  }
  return {
    id,
    hardwareId,
    displayName: stringOrNull(value.displayName),
    lastSeenAt: numberOrNull(value.lastSeenAt) ?? 0,
    addedAt: numberOrNull(value.addedAt) ?? 0,
    ledCounts: parseLedCounts(value.ledCounts),
    firmwareVer: numberOrNull(value.firmwareVer),
  };
}

export class DeviceApi {
  private readonly config: UsageConfig;
  private readonly fetchImpl: HttpFetch;
  private readonly storage: UsageStorage;
  private readonly localUserKey: () => string;
  private readonly timer: ApiTimer;
  private readonly active: boolean;
  /** 进程内缓存（storage 是持久化；这里避免每次调用都反序列化）。 */
  private identity: DeviceIdentity | null;
  /** 进行中的 session 请求：并发调用只打一次。 */
  private identityPending: Promise<ApiResult<DeviceIdentity>> | null = null;

  constructor(opts: DeviceApiOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetch;
    this.storage = opts.storage;
    this.localUserKey = opts.localUserKey;
    this.timer = opts.timer ?? defaultTimer;
    this.active =
      opts.config.enabled &&
      opts.config.baseUrl.length > 0 &&
      opts.config.appToken.length > 0;
    this.identity = this.loadStoredIdentity();
  }

  /** 配置是否可用（未配置 = 功能关闭，页面不该报错）。 */
  get enabled(): boolean {
    return this.active;
  }

  /** 当前身份（不含网络）；未换过 session 时为 null。 */
  get currentIdentity(): DeviceIdentity | null {
    return this.identity;
  }

  // ------------------------------------------------------------------
  // 身份
  // ------------------------------------------------------------------

  /**
   * 取身份：命中缓存直接用，否则 `POST /api/v1/session`。
   *
   * 失败**不**缓存：下次调用还有机会（后端恢复后自然成功）。
   */
  async ensureIdentity(): Promise<ApiResult<DeviceIdentity>> {
    if (!this.active) {
      return { ok: false, reason: "disabled" };
    }
    if (this.identity !== null) {
      return { ok: true, value: this.identity };
    }
    if (this.identityPending !== null) {
      return this.identityPending;
    }
    this.identityPending = this.exchangeSession().finally(() => {
      this.identityPending = null;
    });
    return this.identityPending;
  }

  /** 重新换一次身份（后端 404 unknown_user 后调用；忽略缓存）。 */
  private async forceIdentity(): Promise<ApiResult<DeviceIdentity>> {
    if (!this.active) {
      return { ok: false, reason: "disabled" };
    }
    this.identity = null;
    this.storage.remove(IDENTITY_STORAGE_KEY);
    return this.exchangeSession();
  }

  private async exchangeSession(): Promise<ApiResult<DeviceIdentity>> {
    const body = { userKey: this.localUserKey() };
    let response: HttpResponse;
    try {
      response = await this.withTimeout(
        this.fetchImpl({
          url: `${this.config.baseUrl}${SESSION_PATH}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            [APP_TOKEN_HEADER]: this.config.appToken,
          },
          body: JSON.stringify(body),
          timeoutMs: this.config.requestTimeoutMs,
        }),
      );
    } catch {
      /* 会话只尝试一次：重试留给设备调用，避免一次连接打两轮 session。 */
      return { ok: false, reason: "offline" };
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "unauthorized" };
    }
    if (response.status >= 500) {
      return { ok: false, reason: "server" };
    }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, reason: "rejected" };
    }

    const payload = parseJson(response.body);
    if (!isRecord(payload)) {
      return { ok: false, reason: "server" };
    }
    const userKey = stringOrNull(payload.userKey);
    const kind = payload.identityKind === "openid" ? "openid" : "local";
    if (userKey === null) {
      return { ok: false, reason: "server" };
    }
    const identity: DeviceIdentity = {
      userKey,
      identityKind: kind,
      trusted: payload.trusted === true,
    };
    this.identity = identity;
    this.storeIdentity(identity);
    return { ok: true, value: identity };
  }

  private loadStoredIdentity(): DeviceIdentity | null {
    const raw = this.storage.get(IDENTITY_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = parseJson(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    const userKey = stringOrNull(parsed.userKey);
    if (userKey === null) {
      return null;
    }
    return {
      userKey,
      identityKind: parsed.identityKind === "openid" ? "openid" : "local",
      trusted: parsed.trusted === true,
    };
  }

  private storeIdentity(identity: DeviceIdentity): void {
    try {
      this.storage.set(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
    } catch {
      /* 存储失败只影响下次启动要不要重新换 session，不影响本次。 */
    }
  }

  // ------------------------------------------------------------------
  // 设备接口
  // ------------------------------------------------------------------

  /** `GET /api/v1/devices`：调用者登记过的设备（按 last_seen 降序）。 */
  async listDevices(): Promise<ApiResult<SyncedDevice[]>> {
    return this.call(async (identity) => {
      const outcome = await this.send(identity, "GET", DEVICES_PATH);
      if (outcome.kind !== "ok") {
        return outcome;
      }
      const payload = parseJson(outcome.body);
      if (!isRecord(payload) || !Array.isArray(payload.devices)) {
        return { kind: "retry", reason: "server" };
      }
      const devices: SyncedDevice[] = [];
      for (const item of payload.devices) {
        const parsed = parseSyncedDevice(item);
        if (parsed !== null) {
          devices.push(parsed);
        }
      }
      return { kind: "ok", value: devices };
    });
  }

  /**
   * `POST /api/v1/devices/register`：把设备挂到当前用户下。
   *
   * 幂等（201 新建 / 200 已存在，同一 id）。**不带任何灯光配置**：
   * 后端只存 hardwareId 与备注名（§2.2）。
   */
  async registerDevice(
    hardwareId: string,
    displayName?: string | null,
  ): Promise<ApiResult<RegisteredDevice>> {
    const body =
      displayName !== undefined && displayName !== null && displayName.length > 0
        ? { hardwareId, displayName }
        : { hardwareId };
    return this.call(async (identity) => {
      const outcome = await this.send(identity, "POST", `${DEVICES_PATH}/register`, body);
      if (outcome.kind !== "ok") {
        return outcome;
      }
      const payload = parseJson(outcome.body);
      if (!isRecord(payload)) {
        return { kind: "retry", reason: "server" };
      }
      const deviceId = numberOrNull(payload.deviceId);
      const hw = stringOrNull(payload.hardwareId);
      if (deviceId === null || hw === null) {
        return { kind: "retry", reason: "server" };
      }
      return {
        kind: "ok",
        value: {
          deviceId,
          hardwareId: hw,
          displayName: stringOrNull(payload.displayName),
        },
      };
    });
  }

  /** `PATCH /api/v1/devices/:id`：改本人备注名（后端按 user 存）。 */
  async renameDevice(deviceId: number, displayName: string): Promise<ApiResult<true>> {
    return this.call(async (identity) => {
      const outcome = await this.send(identity, "PATCH", `${DEVICES_PATH}/${deviceId}`, {
        displayName,
      });
      return outcome.kind === "ok" ? { kind: "ok", value: true } : outcome;
    });
  }

  /** `DELETE /api/v1/devices/:id`：只解除关联，设备记录保留。 */
  async deleteDevice(deviceId: number): Promise<ApiResult<true>> {
    return this.call(async (identity) => {
      const outcome = await this.send(identity, "DELETE", `${DEVICES_PATH}/${deviceId}`);
      return outcome.kind === "ok" ? { kind: "ok", value: true } : outcome;
    });
  }

  /**
   * `POST /api/v1/devices/:id/seen`：推进 last_seen，并顺带上报缓存字段。
   *
   * `ledCounts` / `firmwareVer` 是**缓存快照**，后端用 COALESCE 保存，
   * 从不回写设备。它们让另一台手机在离线时能显示点东西（且明确标注非权威）。
   */
  async markSeen(
    deviceId: number,
    seen: { ledCounts?: number[] | null; firmwareVer?: number | null } = {},
  ): Promise<ApiResult<SeenDevice>> {
    const body: Record<string, unknown> = {};
    if (seen.ledCounts !== undefined && seen.ledCounts !== null) {
      body.ledCounts = seen.ledCounts;
    }
    if (seen.firmwareVer !== undefined && seen.firmwareVer !== null) {
      body.firmwareVer = seen.firmwareVer;
    }
    return this.call(async (identity) => {
      const outcome = await this.send(identity, "POST", `${DEVICES_PATH}/${deviceId}/seen`, body);
      if (outcome.kind !== "ok") {
        return outcome;
      }
      const payload = parseJson(outcome.body);
      if (!isRecord(payload)) {
        return { kind: "retry", reason: "server" };
      }
      const id = numberOrNull(payload.id);
      const hardwareId = stringOrNull(payload.hardwareId);
      if (id === null || hardwareId === null) {
        return { kind: "retry", reason: "server" };
      }
      return {
        kind: "ok",
        value: {
          id,
          hardwareId,
          displayName: stringOrNull(payload.displayName),
          lastSeenAt: numberOrNull(payload.lastSeenAt) ?? 0,
          ledCounts: parseLedCounts(payload.ledCounts),
          firmwareVer: numberOrNull(payload.firmwareVer),
        },
      };
    });
  }

  // ------------------------------------------------------------------
  // 内部：一次调用的重试编排
  // ------------------------------------------------------------------

  /**
   * 「确保身份 → 发请求 → 瞬时失败重试一次 / unknown_user 重建身份再试一次」。
   *
   * 请求预算有上限：普通瞬时失败最多 2 次；`unknown_user` 重建身份后最多再 1 次
   * （不叠加成 3 次）。身份只在首次和重建时各换一次。
   */
  private async call<T>(
    run: (identity: DeviceIdentity) => Promise<Attempt<T>>,
  ): Promise<ApiResult<T>> {
    if (!this.active) {
      return { ok: false, reason: "disabled" };
    }
    const first = await this.ensureIdentity();
    if (!first.ok) {
      return first;
    }
    let identity = first.value;
    let outcome = await run(identity);

    if (outcome.kind === "unknown_user") {
      /* 后端库被重置 / 换了 app token：旧 userKey 不存在。重建一次会话。 */
      const rebuilt = await this.forceIdentity();
      if (!rebuilt.ok) {
        return rebuilt;
      }
      identity = rebuilt.value;
      outcome = await run(identity);
      if (outcome.kind === "unknown_user") {
        /* 重建后仍然 unknown_user：身份不可用，不再重试。 */
        return { ok: false, reason: "unauthorized" };
      }
      /* 重建后这一次若仍是瞬时失败，直接按失败返回：预算不叠加。 */
      return outcome.kind === "ok"
        ? { ok: true, value: outcome.value }
        : { ok: false, reason: outcome.reason };
    }

    if (outcome.kind === "retry") {
      outcome = await run(identity);
    }

    if (outcome.kind === "ok") {
      /* Attempt 的内部形状是 `{kind:"ok"}`；对外统一成 `{ok:true}`。 */
      return { ok: true, value: outcome.value };
    }
    if (outcome.kind === "retry") {
      return { ok: false, reason: outcome.reason };
    }
    if (outcome.kind === "unknown_user") {
      return { ok: false, reason: "unauthorized" };
    }
    return { ok: false, reason: outcome.reason };
  }

  /** 一次 HTTP 尝试 + 状态码分类。永不抛错。 */
  private async send(
    identity: DeviceIdentity,
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<SendOutcome> {
    let response: HttpResponse;
    try {
      response = await this.withTimeout(
        this.fetchImpl({
          url: `${this.config.baseUrl}${path}`,
          method,
          headers: {
            "content-type": "application/json",
            [APP_TOKEN_HEADER]: this.config.appToken,
            [USER_KEY_HEADER]: identity.userKey,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          timeoutMs: this.config.requestTimeoutMs,
        }),
      );
    } catch {
      return { kind: "retry", reason: "offline" };
    }

    const status = response.status;
    if (status >= 200 && status < 300) {
      return { kind: "ok", body: response.body };
    }
    if (status === 401 || status === 403) {
      return { kind: "fail", reason: "unauthorized" };
    }
    if (status === 404) {
      const payload = parseJson(response.body);
      if (isRecord(payload) && payload.error === "unknown_user") {
        return { kind: "unknown_user" };
      }
      /* device_not_found：设备不在当前用户列表里（不泄露存在性）。 */
      return { kind: "fail", reason: "rejected" };
    }
    if (status === 408 || status === 429 || status >= 500) {
      return { kind: "retry", reason: "server" };
    }
    return { kind: "fail", reason: "rejected" };
  }

  /** 硬超时：wx.request 的 timeout 不保证回调（与 logger 同一套理由）。 */
  private withTimeout(promise: Promise<HttpResponse>): Promise<HttpResponse> {
    const ms = this.config.requestTimeoutMs;
    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const handle = this.timer.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`设备 API 超时 ${ms}ms`));
      }, ms);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.timer.clearTimeout(handle);
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          this.timer.clearTimeout(handle);
          reject(err);
        },
      );
    });
  }
}

/**
 * 生产入口：配置缺失时返回 null（功能关闭，页面不提示）。
 *
 * 与 `createDefaultUsageLogger` 同一套配置（`lumen.usage.config.v1`）：
 * 后端地址与 app token 只配一次。
 */
export function createDefaultDeviceApi(options: {
  storage: UsageStorage;
  fetch: HttpFetch;
  localUserKey: () => string;
}): DeviceApi | null {
  const config = loadUsageConfig(options.storage);
  if (!config.enabled) {
    return null;
  }
  return new DeviceApi({
    config,
    fetch: options.fetch,
    storage: options.storage,
    localUserKey: options.localUserKey,
  });
}
