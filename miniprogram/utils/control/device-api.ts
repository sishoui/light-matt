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
 * ## 微信身份（#47）
 *
 * 会话请求在**拿到 code 时**把它一起发出去：后端配置了 `WX_APPID` / `WX_SECRET`
 * 就用 code 换 openid，没配置则忽略 code（`validateSessionPayload` 允许它存在）。
 * 拿不到 code 或后端回 `invalid_code` 时**显式**降级：返回
 * `login_failed` / `invalid_code`，由同步层回落成 `local` 身份并在设备页提示
 * 「仅本机可见」，而不是静默失败。
 *
 * 纯逻辑 + 注入 `HttpFetch` / storage / 计时器 / 登录接缝：node 单测里零 wx 依赖。
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

/** 回落到 local 身份的原因（#47）：页面据此给出可读提示，不静默失败。 */
export type IdentityFallback = "login_failed" | "invalid_code";

export interface DeviceIdentity {
  /** 后端认的 key；openid 模式下**不是**本地生成的 `local-...`。 */
  readonly userKey: string;
  readonly identityKind: IdentityKind;
  /** 后端给的提示位（不是权限开关）。 */
  readonly trusted: boolean;
  /**
   * 后端是否认这份身份（#47）。
   *
   * `false` = 纯本地回落（`wx.login` 失败 / 后端回 `invalid_code` / 后端要求 code
   * 而我们没有）：设备接口不会再被调用，因为后端根本没有这个用户。
   */
  readonly backendBacked: boolean;
  /** 回落到 local 的原因；身份正常时为 `null`。 */
  readonly fallback: IdentityFallback | null;
  /**
   * 换这份身份时是否已经尝试过带 code（#47）。
   *
   * 旧版本留下的 local 缓存没有这个字段（按 `false` 读），值得重换一次争取升级
   * 成 openid；之后无论结果如何都不会重复打 session——后端没配 AppSecret 时
   * 会一直回 local，每次重试都是白发一轮请求。想重新登录请走 `forgetIdentity()`。
   */
  readonly loginTried: boolean;
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
  | "rejected"
  /**
   * 后端配置了微信登录（要求 code），但 `wx.login` 没拿到 code（#47）。
   * 不是网络问题：调用方应显式回落到 local 身份并提示。
   */
  | "login_failed"
  /** 后端把 code 判为无效 / 过期（401 `invalid_code`，#47）。 */
  | "invalid_code";

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ApiFailureReason };

interface ApiTimer {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * `wx.login` 接缝：返回一次性 code；拿不到（未授权 / 网络 / 平台不支持）返回 null。
 *
 * 单独做类型而不是直接调 wx：node 单测注入假实现，生产由 `createWxLoginCode()`
 * 提供——`exchangeSession` 因此仍然零 wx 依赖。**约定永不抛错**（实现自带守卫），
 * 这里仍包一层 try，避免注入方违约打断会话。
 */
export type LoginCodeFetcher = () => Promise<string | null>;

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
  /**
   * 微信登录 code 来源（#47）。未注入 = 不发 code（等价于未配 AppSecret 的旧路径）。
   * 后端未配置 AppSecret 时会忽略 code；配置了则必须靠它换 openid。
   */
  readonly loginCode?: LoginCodeFetcher;
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

/** 后端 400 是否在抱怨「缺 code」（说明它配了 AppSecret，要求走微信登录）。 */
function complainsAboutCode(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.details)) {
    return false;
  }
  return payload.details.some((item) => isRecord(item) && item.field === "code");
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
  private readonly loginCode: LoginCodeFetcher | null;
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
    this.loginCode = opts.loginCode ?? null;
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
   * 回落身份只在内存里（不落盘），但同一进程内会复用，避免每次设备调用都
   * 重打一轮 `wx.login`；页面「重试」走 `forgetIdentity()` 再问一次。
   */
  async ensureIdentity(): Promise<ApiResult<DeviceIdentity>> {
    if (!this.active) {
      return { ok: false, reason: "disabled" };
    }
    if (this.identity !== null && !this.needsLoginUpgrade(this.identity)) {
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

  /**
   * 旧缓存是 local，而这次有机会带 code：重换一次，争取升级成 openid（#47）。
   *
   * 只看身份自身记录的 `loginTried`，所以未配微信的部署（没有登录接缝，
   * 缓存里也不会有 code 记录）与旧单测行为完全不变。
   */
  private needsLoginUpgrade(identity: DeviceIdentity): boolean {
    return (
      this.loginCode !== null &&
      identity.identityKind === "local" &&
      !identity.loginTried
    );
  }

  /** 重新换一次身份（后端 404 unknown_user 后调用；忽略缓存）。 */
  private async forceIdentity(): Promise<ApiResult<DeviceIdentity>> {
    if (!this.active) {
      return { ok: false, reason: "disabled" };
    }
    this.forgetIdentity();
    return this.exchangeSession();
  }

  /**
   * 丢掉内存与持久化的身份，下一次 `ensureIdentity` 重新换（页面手动重试用）。
   *
   * 回落身份本来就不落盘，这里主要是让「上次 `wx.login` 失败」不会粘住整个
   * 进程：点一次「重试」就能重新尝试升级成 openid（#47）。
   */
  forgetIdentity(): void {
    this.identity = null;
    this.storage.remove(IDENTITY_STORAGE_KEY);
  }

  /**
   * 换会话：`userKey` 一直带，拿到 `wx.login` 的 code 时一并带上（#47）。
   *
   * 后端配了 AppSecret 时必须靠 code 换 openid；没配则忽略 code、仍按
   * `userKey` 回 local。两种情况都不需要客户端知道后端配置。
   */
  private async exchangeSession(): Promise<ApiResult<DeviceIdentity>> {
    const code = await this.requestLoginCode();
    const body: Record<string, string> = { userKey: this.localUserKey() };
    if (code !== null) {
      body.code = code;
    }
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

    const payload = parseJson(response.body);

    if (response.status === 401 || response.status === 403) {
      /* `invalid_code` 与 app token 错都是 401，靠 error 字段区分：
       * 前者是「这张 code 废了」（重新 wx.login 还能好），后者是部署配置问题。 */
      if (isRecord(payload) && payload.error === "invalid_code") {
        return this.localFallback("invalid_code");
      }
      return { ok: false, reason: "unauthorized" };
    }
    if (response.status >= 500) {
      return { ok: false, reason: "server" };
    }
    if (response.status === 400 && complainsAboutCode(payload)) {
      /* 后端配了 AppSecret，而我们没有 code（wx.login 失败 / 未接登录）：
       * 显式回落到 local，让页面显示「仅本机可见」而不是一直转圈。 */
      return this.localFallback("login_failed");
    }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, reason: "rejected" };
    }

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
      /* 后端明确接受了这份身份（local 也罢），设备接口可用。 */
      backendBacked: true,
      fallback: null,
      /* 这次问过微信了：后端没配 AppSecret 时不必下次再问。 */
      loginTried: this.loginCode !== null,
    };
    this.identity = identity;
    this.storeIdentity(identity);
    return { ok: true, value: identity };
  }

  /**
   * 回落身份：只在内存里，**不落盘**（下次启动 / 手动重试还有机会升级）。
   *
   * `backendBacked: false` 让 `call()` 直接放弃设备接口——后端根本没有这个用户，
   * 打过去也只会 404，反而把「登录失败」误报成「离线」。
   */
  private localFallback(fallback: IdentityFallback): ApiResult<DeviceIdentity> {
    const identity: DeviceIdentity = {
      userKey: this.localUserKey(),
      identityKind: "local",
      trusted: false,
      backendBacked: false,
      fallback,
      /* 同一进程内复用这份回落身份：不在每次设备调用里重打 wx.login。
       * 页面「重试」会调 `forgetIdentity()` 再走一遍。 */
      loginTried: true,
    };
    this.identity = identity;
    return { ok: true, value: identity };
  }

  /** 取 `wx.login` 的 code；没有接缝 / 调用失败一律 null（回落路径不报错）。 */
  private async requestLoginCode(): Promise<string | null> {
    if (this.loginCode === null) {
      return null;
    }
    try {
      const code = await this.loginCode();
      return typeof code === "string" && code.trim().length > 0 ? code.trim() : null;
    } catch {
      /* 注入方违约抛错也只当「没拿到 code」：登录失败永远不该炸掉同步旁路。 */
      return null;
    }
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
    /* 只有后端确认过的身份才会落盘，所以 `backendBacked` 恒为 true
     * （旧版本缓存里没有这个字段，同样按 true 读）。 */
    return {
      userKey,
      identityKind: parsed.identityKind === "openid" ? "openid" : "local",
      trusted: parsed.trusted === true,
      backendBacked: true,
      fallback: null,
      /* 旧版本缓存没有这个字段 → false：值得重换一次争取升级成 openid。 */
      loginTried: parsed.loginTried === true,
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
    if (!first.value.backendBacked) {
      /* 回落身份：后端没有这个用户，设备接口一定 404。直接返回原因，
       * 避免把「登录失败」误报成「离线」（#47）。 */
      return { ok: false, reason: first.value.fallback ?? "login_failed" };
    }
    let identity = first.value;
    let outcome = await run(identity);

    if (outcome.kind === "unknown_user") {
      /* 后端库被重置 / 换了 app token：旧 userKey 不存在。重建一次会话。 */
      const rebuilt = await this.forceIdentity();
      if (!rebuilt.ok) {
        return rebuilt;
      }
      if (!rebuilt.value.backendBacked) {
        /* 重建时登录照样失败：按回落原因返回，不当作「离线」。 */
        return { ok: false, reason: rebuilt.value.fallback ?? "login_failed" };
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
  /** #47：`wx.login` 的 code 来源；不传 = 不发 code（旧路径行为不变）。 */
  loginCode?: LoginCodeFetcher;
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
    ...(options.loginCode !== undefined ? { loginCode: options.loginCode } : {}),
  });
}
