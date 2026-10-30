/**
 * #34 使用日志：小程序侧写入、离线补报、幂等、与控制的解耦。
 *
 * 覆盖验收项：
 *  - 成功连接 → 提交一条「谁 × 哪台 × 什么时候」；
 *  - 断网 → 本地持久化排队，联网后补报（重开小程序也不丢）；
 *  - 重复提交命中后端幂等（200 duplicate）；
 *  - 后端不可达 / 超时**不阻塞、不影响** BLE 控制；
 *  - 只记连接事实，**不发送任何实时控制数据**（颜色/亮度/灯珠数/分段）。
 *
 * 假件只替换 HTTP（fetch 接缝）、计时器与存储后端——不 mock 协议字节、不碰 wx。
 */

import { describe, expect, it } from "vitest";

import { ControlSession } from "../utils/control/session";
import type { BleTransport, LinkDetail } from "../utils/ble/transport";
import type { CommandRequest, DeviceState, LinkState } from "../utils/protocol/types";
import {
  USAGE_LOGS_PATH,
  loadUsageConfig,
  normalizeBaseUrl,
  usageLogsUrl,
  type UsageConfig,
} from "../utils/usage/config";
import {
  buildUsageEvent,
  createClientEventId,
  createLocalUserKey,
  getOrCreateLocalUserKey,
  toUsagePlatform,
  LOCAL_USER_KEY_STORAGE_KEY,
  type ConnectionIdentity,
  type UsageEvent,
} from "../utils/usage/event";
import type { HttpFetch, HttpRequest, HttpResponse } from "../utils/usage/http";
import { UsageLogger, MAX_SENDS_PER_FLUSH } from "../utils/usage/logger";
import { UsageQueue, USAGE_QUEUE_MAX } from "../utils/usage/queue";
import { createMemoryUsageStorage, type UsageStorage } from "../utils/usage/storage";

const TOKEN = "test-app-token";

function enabledConfig(overrides: Partial<UsageConfig> = {}): UsageConfig {
  return {
    baseUrl: "https://lumen.test",
    appToken: TOKEN,
    requestTimeoutMs: 5000,
    enabled: true,
    ...overrides,
  };
}

/** 记录每次请求的假后端。 */
function recordingFetch(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): { fetch: HttpFetch; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const fetch: HttpFetch = async (req) => {
    calls.push(req);
    return responder(req);
  };
  return { fetch, calls };
}

function okResponse(status = 201): HttpResponse {
  return {
    status,
    body: JSON.stringify({ id: 1, duplicate: false, deviceKey: "name:LUMEN-1A2B" }),
  };
}

/** 每次调用都递增的伪随机：保证 clientEventId 互不相同，同时完全确定。 */
function counterRandom(): () => number {
  let n = 1;
  return () => {
    n = (n * 1103515245 + 12345) % 2147483648;
    return n / 2147483648;
  };
}

/** 可控计时器：超时断言不依赖真实时间。 */
function fakeClock() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const api = {
    setTimeout: (fn: () => void, ms: number) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, fn });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      let due: { handle: number; at: number; fn: () => void } | null = null;
      for (const [handle, entry] of timers) {
        if (entry.at <= target && (due === null || entry.at < due.at)) {
          due = { handle, at: entry.at, fn: entry.fn };
        }
      }
      if (due === null) break;
      timers.delete(due.handle);
      now = due.at;
      due.fn();
    }
    now = target;
  };
  return { api, advance, get pending() { return timers.size; } };
}

/** 把微任务队列跑空：flush 是逐条 await 的，每条约 4-6 个 tick。 */
async function settle(rounds = 400): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function makeLogger(opts: {
  fetch: HttpFetch;
  storage?: UsageStorage;
  config?: UsageConfig;
  timer?: ReturnType<typeof fakeClock>["api"];
  now?: () => number;
}): { logger: UsageLogger; storage: UsageStorage; diagnostics: string[] } {
  const storage = opts.storage ?? createMemoryUsageStorage();
  const diagnostics: string[] = [];
  const logger = new UsageLogger({
    config: opts.config ?? enabledConfig(),
    fetch: opts.fetch,
    storage,
    random: counterRandom(),
    ...(opts.timer !== undefined ? { timer: opts.timer } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    onDiagnostic: (m) => diagnostics.push(m),
  });
  return { logger, storage, diagnostics };
}

const IDENTITY: ConnectionIdentity = {
  deviceName: "Lumen-1A2B",
  deviceId: "AA:BB:CC:DD:1A:2B",
  platform: "android",
};

// ---------------------------------------------------------------------------
// 配置：唯一真相源，缺失时优雅降级
// ---------------------------------------------------------------------------

describe("#34 配置", () => {
  it("没有配置 → 禁用（不排队、不发送，控制不受影响）", () => {
    const cfg = loadUsageConfig(createMemoryUsageStorage());
    expect(cfg.enabled).toBe(false);
    expect(cfg.baseUrl).toBe("");
  });

  it("只有 baseUrl 没有 appToken → 仍然禁用", () => {
    const storage = createMemoryUsageStorage();
    storage.set("lumen.usage.config.v1", JSON.stringify({ baseUrl: "https://x.test" }));
    expect(loadUsageConfig(storage).enabled).toBe(false);
  });

  it("配置齐全 → 启用，并归一化末尾斜杠与空白", () => {
    const storage = createMemoryUsageStorage();
    storage.set(
      "lumen.usage.config.v1",
      JSON.stringify({
        baseUrl: "  https://x.test///  ",
        appToken: "  tok  ",
        requestTimeoutMs: 1234,
      }),
    );
    const cfg = loadUsageConfig(storage);
    expect(cfg).toEqual({
      baseUrl: "https://x.test",
      appToken: "tok",
      requestTimeoutMs: 1234,
      enabled: true,
    });
    expect(usageLogsUrl(cfg)).toBe(`https://x.test${USAGE_LOGS_PATH}`);
  });

  it("坏 JSON / 非对象 / 显式禁用都不抛错", () => {
    const storage = createMemoryUsageStorage();
    storage.set("lumen.usage.config.v1", "{not json");
    expect(loadUsageConfig(storage).enabled).toBe(false);

    storage.set(
      "lumen.usage.config.v1",
      JSON.stringify({ baseUrl: "https://x.test", appToken: "t", enabled: false }),
    );
    expect(loadUsageConfig(storage).enabled).toBe(false);

    storage.set("lumen.usage.config.v1", JSON.stringify([1, 2]));
    expect(loadUsageConfig(storage).enabled).toBe(false);
  });

  it("normalizeBaseUrl 去掉所有尾部斜杠", () => {
    expect(normalizeBaseUrl("https://a.test/")).toBe("https://a.test");
    expect(normalizeBaseUrl("https://a.test///")).toBe("https://a.test");
    expect(normalizeBaseUrl("  ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 事件内容：只有「谁 × 哪台 × 什么时候」
// ---------------------------------------------------------------------------

describe("#34 记录内容不含实时控制数据", () => {
  it("请求体的字段集合被严格限定（没有颜色/亮度/开关/灯珠/分段/命令）", () => {
    const event = buildUsageEvent({
      userKey: "local-abc",
      startedAt: 1_760_000_000_000,
      clientEventId: "evt-1",
      device: IDENTITY,
    });

    expect(Object.keys(event).sort()).toEqual(["clientEventId", "device", "startedAt", "userKey"]);
    expect(Object.keys(event.device).sort()).toEqual(["deviceId", "deviceName", "platform"]);

    const json = JSON.stringify(event).toLowerCase();
    for (const forbidden of [
      "color",
      "colour",
      "rgb",
      "brightness",
      "power",
      "ledcount",
      "led_count",
      "segment",
      "effect",
      "script",
      "command",
      "payload",
      "hex",
    ]) {
      expect(json, `不应包含 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("平台映射：other（含开发者工具）记 unknown，不猜 devtools", () => {
    expect(toUsagePlatform("android")).toBe("android");
    expect(toUsagePlatform("ios")).toBe("ios");
    expect(toUsagePlatform("other")).toBe("unknown");
  });

  it("真实控制流量发生在上报之外：所有发出的请求体都不含颜色/亮度/灯珠数", async () => {
    const { fetch: f, calls } = recordingFetch(() => okResponse());
    const { logger } = makeLogger({ fetch: f });
    const transport = new FakeTransport();
    const session = new ControlSession({
      platform: "android",
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage: createMemoryUsageStorage(),
      usageLogger: logger,
    });

    await session.connect("DEV-1", "Lumen-1A2B");
    // 制造一整套实时控制流量（开关 / 亮度 / 颜色 / 预设 / 灯珠数）。
    await session.setPower(true);
    session.commitBrightness(200);
    session.commitColor({ r: 255, g: 0, b: 0 });
    await session.applyPreset({ r: 0, g: 255, b: 0 });
    await session.setLedCount(42);
    await settle();

    // BLE 侧确实收到了这些命令……
    expect(transport.ackCalls.length + transport.writes.length).toBeGreaterThan(0);
    // ……但网上只发过「连接事实」，一条控制数据都没有。
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0].body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["clientEventId", "device", "startedAt", "userKey"]);
    const json = calls[0].body.toLowerCase();
    for (const forbidden of ["brightness", "rgb", "\"r\"", "ledcount", "setpower", "setall"]) {
      expect(json, `上报体不应包含 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("广播名 / deviceId 照实上报，空串归一成 null", () => {
    const event = buildUsageEvent({
      userKey: "u",
      startedAt: 1,
      clientEventId: "c",
      device: { deviceName: "  ", deviceId: "", platform: "ios" },
    });
    expect(event.device).toEqual({ deviceName: null, deviceId: null, platform: "ios" });
  });
});

// ---------------------------------------------------------------------------
// 本机 userKey
// ---------------------------------------------------------------------------

describe("#34 userKey（个人测试阶段的本机稳定标识）", () => {
  it("首次生成后写入 storage，此后稳定复用", () => {
    const storage = createMemoryUsageStorage();
    const first = getOrCreateLocalUserKey(storage, () => 0.5);
    expect(first).toMatch(/^local-[0-9a-f]{16}$/);
    expect(storage.get(LOCAL_USER_KEY_STORAGE_KEY)).toBe(first);
    expect(getOrCreateLocalUserKey(storage, () => 0.9)).toBe(first);
  });

  it("clientEventId 形状是 UUID v4，两次不同", () => {
    const a = createClientEventId(() => 0.1);
    const b = createClientEventId(() => 0.9);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(a).not.toBe(b);
  });

  it("userKey 前缀标明这是本机生成、不是 openid", () => {
    expect(createLocalUserKey(() => 0.3)).toMatch(/^local-/);
  });
});

// ---------------------------------------------------------------------------
// 队列：持久化、上限、FIFO
// ---------------------------------------------------------------------------

function sampleEvent(i: number): UsageEvent {
  return buildUsageEvent({
    userKey: "local-x",
    startedAt: 1_000 + i,
    clientEventId: `evt-${i}`,
    device: IDENTITY,
  });
}

describe("#34 离线队列", () => {
  it("持久化到 storage：新实例（模拟 App 重启）仍能读到", () => {
    const storage = createMemoryUsageStorage();
    const queue = new UsageQueue(storage);
    queue.enqueue(sampleEvent(1));
    queue.enqueue(sampleEvent(2));

    const reopened = new UsageQueue(storage);
    expect(reopened.size).toBe(2);
    expect(reopened.head()?.clientEventId).toBe("evt-1");
  });

  it(`上限 ${USAGE_QUEUE_MAX} 条，溢出丢最旧的并计数`, () => {
    const storage = createMemoryUsageStorage();
    const queue = new UsageQueue(storage);
    for (let i = 0; i < USAGE_QUEUE_MAX + 3; i += 1) {
      queue.enqueue(sampleEvent(i));
    }
    expect(queue.size).toBe(USAGE_QUEUE_MAX);
    // 最旧的 3 条被丢掉
    expect(queue.head()?.clientEventId).toBe("evt-3");
    expect(queue.droppedCount()).toBe(3);
    // 重启后上限仍然生效
    expect(new UsageQueue(storage).size).toBe(USAGE_QUEUE_MAX);
  });

  it("按 clientEventId 删除，不按下标（发送期间追加也不会删错）", () => {
    const storage = createMemoryUsageStorage();
    const queue = new UsageQueue(storage);
    queue.enqueue(sampleEvent(1));
    queue.enqueue(sampleEvent(2));
    queue.remove("evt-1");
    expect(queue.snapshot().map((e) => e.clientEventId)).toEqual(["evt-2"]);
    expect(new UsageQueue(storage).size).toBe(1);
  });

  it("损坏的 storage 内容不会抛错，也不会堵死队列", () => {
    const storage = createMemoryUsageStorage();
    storage.set("lumen.usage.queue.v1", "{oops");
    expect(new UsageQueue(storage).size).toBe(0);

    storage.set("lumen.usage.queue.v1", JSON.stringify({ version: 1, items: [{ nope: true }] }));
    expect(new UsageQueue(storage).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 发送：成功 / 幂等 / 离线 / 永久拒绝
// ---------------------------------------------------------------------------

describe("#34 发送", () => {
  it("201 → 一条记录送达，队列清空，带令牌与 JSON", async () => {
    const { fetch: f, calls } = recordingFetch(() => okResponse(201));
    const { logger } = makeLogger({ fetch: f });

    logger.recordConnection(IDENTITY);
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://lumen.test${USAGE_LOGS_PATH}`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["x-lumen-app-token"]).toBe(TOKEN);
    expect(calls[0].headers["content-type"]).toBe("application/json");

    const body = JSON.parse(calls[0].body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["clientEventId", "device", "startedAt", "userKey"]);
    expect(body.userKey).toMatch(/^local-/);
    expect(body.device).toEqual({
      deviceName: "Lumen-1A2B",
      deviceId: "AA:BB:CC:DD:1A:2B",
      platform: "android",
    });
    expect(logger.pending).toBe(0);
  });

  it("200 {duplicate:true} 视为送达（幂等重复被消费掉）", async () => {
    const { fetch: f } = recordingFetch(() => ({
      status: 200,
      body: JSON.stringify({ id: 7, duplicate: true }),
    }));
    const { logger } = makeLogger({ fetch: f });

    logger.recordConnection(IDENTITY);
    await settle();

    expect(logger.pending).toBe(0);
  });

  it("断网 → 记录留在队列；网络恢复后 replay 补报成功", async () => {
    let online = false;
    const { fetch: f, calls } = recordingFetch(() => {
      if (!online) throw new Error("ERR_INTERNET_DISCONNECTED");
      return okResponse(201);
    });
    const storage = createMemoryUsageStorage();
    const { logger } = makeLogger({ fetch: f, storage });

    logger.recordConnection(IDENTITY);
    await settle();
    expect(logger.pending).toBe(1);
    expect(calls).toHaveLength(1);

    // 模拟 App 被杀后重开：新实例从同一 storage 恢复队列
    const reopened = makeLogger({ fetch: f, storage }).logger;
    expect(reopened.pending).toBe(1);

    online = true;
    reopened.replay();
    await settle();

    expect(reopened.pending).toBe(0);
    // 两次请求用的是同一个 clientEventId（幂等键不随重放变化）
    expect(JSON.parse(calls[0].body).clientEventId).toBe(JSON.parse(calls[1].body).clientEventId);
  });

  it("多次离线连接按 FIFO 补报，且每条只发一次", async () => {
    let online = false;
    const { fetch: f, calls } = recordingFetch(() => {
      if (!online) throw new Error("offline");
      return okResponse();
    });
    const { logger } = makeLogger({ fetch: f });

    logger.recordConnection(IDENTITY);
    logger.recordConnection({ ...IDENTITY, deviceName: "Lumen-2B3C" });
    await settle();
    expect(logger.pending).toBe(2);
    expect(calls).toHaveLength(1); // 第一条失败就够了，整批停下保持顺序

    online = true;
    logger.replay();
    await settle();
    expect(logger.pending).toBe(0);

    const delivered = calls.slice(1).map((c) => JSON.parse(c.body).device.deviceName);
    expect(delivered).toEqual(["Lumen-1A2B", "Lumen-2B3C"]);
    expect(calls).toHaveLength(3);
  });

  it(`一次 flush 最多发 ${MAX_SENDS_PER_FLUSH} 条，其余留到下次`, async () => {
    let online = false;
    const { fetch: f, calls } = recordingFetch(() => {
      if (!online) throw new Error("offline");
      return okResponse();
    });
    // 先把队列灌满（后端离线），再恢复后只放一次 flush。
    const storage = createMemoryUsageStorage();
    const seeded = new UsageQueue(storage);
    for (let i = 0; i < MAX_SENDS_PER_FLUSH + 4; i += 1) {
      seeded.enqueue(sampleEvent(i));
    }

    online = true;
    const { logger } = makeLogger({ fetch: f, storage });
    logger.replay();
    await settle();

    expect(calls).toHaveLength(MAX_SENDS_PER_FLUSH);
    expect(logger.pending).toBe(4);
  });

  it("发送期间又入队：本轮结束后自动补一轮（不丢记录）", async () => {
    const calls: HttpRequest[] = [];
    let release: (() => void) | null = null;
    const fetch: HttpFetch = async (req) => {
      calls.push(req);
      if (calls.length === 1) {
        // 第一条挂起，模拟慢网络；期间第二条入队。
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return okResponse();
    };
    const { logger } = makeLogger({ fetch });

    logger.recordConnection(IDENTITY);
    logger.recordConnection({ ...IDENTITY, deviceName: "Lumen-2B3C" });
    // 第一条还没返回时，第二条已经进队列但没有新的外部触发。
    await settle();
    expect(logger.pending).toBe(2);

    release?.();
    await settle();
    expect(logger.pending).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("400 请求体非法 → 丢弃该条（重发不会成功，不堵住队列）", async () => {
    const { fetch: f } = recordingFetch(() => ({ status: 400, body: "{}" }));
    const { logger, diagnostics } = makeLogger({ fetch: f });

    logger.recordConnection(IDENTITY);
    await settle();

    expect(logger.pending).toBe(0);
    expect(diagnostics.some((d) => d.includes("400"))).toBe(true);
  });

  it("401（令牌错）/ 500 / 502 HTML 都保留记录等下次", async () => {
    for (const status of [401, 500, 502]) {
      const { fetch: f } = recordingFetch(() => ({ status, body: "<html>bad gateway</html>" }));
      const { logger } = makeLogger({ fetch: f });
      logger.recordConnection(IDENTITY);
      await settle();
      expect(logger.pending, `status ${status}`).toBe(1);
    }
  });

  it("未配置时不入队、不发请求", async () => {
    const { fetch: f, calls } = recordingFetch(() => okResponse());
    const { logger } = makeLogger({
      fetch: f,
      config: { baseUrl: "", appToken: "", requestTimeoutMs: 5000, enabled: false },
    });

    logger.recordConnection(IDENTITY);
    await settle();

    expect(calls).toHaveLength(0);
    expect(logger.pending).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 假传输：只实现 ControlSession 用到的部分
// ---------------------------------------------------------------------------

function baseState(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    power: 1,
    brightness: 128,
    r: 255,
    g: 180,
    b: 120,
    ledCount: 30,
    maxBrightness: 255,
    ...overrides,
  };
}

class FakeTransport {
  linkState: LinkState = "ready";
  connectResult: DeviceState | Error = baseState();
  writes: CommandRequest[] = [];
  ackCalls: CommandRequest[] = [];
  private deviceId: string | null = null;

  private readonly linkListeners: Array<(state: LinkState, detail?: LinkDetail) => void> = [];

  onLink(fn: (state: LinkState, detail?: LinkDetail) => void): () => void {
    this.linkListeners.push(fn);
    return () => undefined;
  }

  onState(): () => void {
    return () => undefined;
  }

  emitLink(state: LinkState, detail?: LinkDetail): void {
    this.linkState = state;
    for (const fn of this.linkListeners.slice()) fn(state, detail);
  }

  async connect(deviceId: string, name?: string): Promise<DeviceState> {
    // 与真 transport 一致：已连上同一台设备时只重读 State，不发 ready。
    if (this.linkState === "ready" && this.deviceId === deviceId) {
      return this.readState();
    }
    this.deviceId = deviceId;
    this.emitLink("connecting", { deviceName: name });
    this.emitLink("initializing", { deviceName: name });
    if (this.connectResult instanceof Error) {
      this.emitLink("failed", { message: this.connectResult.message });
      throw this.connectResult;
    }
    this.emitLink("ready", { deviceName: name });
    return this.connectResult;
  }

  readState(): Promise<DeviceState> {
    return Promise.resolve(this.connectResult as DeviceState);
  }

  async write(req: CommandRequest): Promise<{ seq: number }> {
    this.writes.push(req);
    return { seq: 1 };
  }

  sendAndWaitAck(req: CommandRequest): Promise<{
    seq: number;
    command: number;
    resultCode: number;
    ok: boolean;
  }> {
    this.ackCalls.push(req);
    return Promise.resolve({ seq: 1, command: req.command, resultCode: 0, ok: true });
  }

  async startScan(): Promise<void> {}
  async stopScan(): Promise<void> {}
  async openAdapter(): Promise<void> {}
  async disconnect(): Promise<void> {
    this.linkState = "idle";
    this.deviceId = null;
  }
  destroy(): void {
    this.linkListeners.length = 0;
  }
}

// ---------------------------------------------------------------------------
// 后端不可达 / 超时：不阻塞控制
// ---------------------------------------------------------------------------

describe("#34 后端不可达不影响控制", () => {
  it("HTTP 永不返回（后端黑洞）时：connect 正常完成，开关命令照常成功", async () => {
    const clock = fakeClock();
    // 黑洞后端：Promise 永远不 settle，只有 logger 自己的硬超时能结束它。
    const fetch: HttpFetch = () => new Promise<HttpResponse>(() => undefined);
    const { logger } = makeLogger({ fetch, timer: clock.api });

    const transport = new FakeTransport();
    const session = new ControlSession({
      platform: "other",
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage: createMemoryUsageStorage(),
      usageLogger: logger,
    });

    // 关键断言 1：连接不等待日志——计时器一次都没推进，connect 已经返回。
    const state = await session.connect("DEV-1", "Lumen-1A2B");
    expect(state.brightness).toBe(128);
    expect(session.linkState).toBe("ready");
    expect(logger.pending).toBe(1);

    // 关键断言 2：日志请求还挂在黑洞里，控制命令照常走通。
    const result = await session.setPower(false);
    expect(result.kind).toBe("ok");
    expect(transport.ackCalls).toHaveLength(1);

    // 关键断言 3：硬超时到点后，记录仍保留在队列（不丢），也没有异常冒出来。
    clock.advance(5000);
    await settle();
    expect(logger.pending).toBe(1);

    // 再等更久也不会有未处理的 rejection：logger 吞掉所有失败。
    clock.advance(60_000);
    await settle();
    expect(logger.pending).toBe(1);
  });

  it("fetch 同步抛异常（网络层直接失败）也不影响 connect / 控制", async () => {
    const fetch: HttpFetch = () => {
      throw new Error("network down");
    };
    const { logger, diagnostics } = makeLogger({ fetch });
    const transport = new FakeTransport();
    const session = new ControlSession({
      platform: "other",
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage: createMemoryUsageStorage(),
      usageLogger: logger,
    });

    await expect(session.connect("DEV-1", "Lumen-1A2B")).resolves.toBeDefined();
    const result = await session.setPower(true);
    expect(result.kind).toBe("ok");
    expect(logger.pending).toBe(1);
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("logger.recordConnection 内部抛错也不会冒泡到连接状态机", async () => {
    const throwingSink = {
      recordConnection: () => {
        throw new Error("boom");
      },
      replay: () => undefined,
    };
    const transport = new FakeTransport();
    const session = new ControlSession({
      platform: "other",
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage: createMemoryUsageStorage(),
      usageLogger: throwingSink,
    });

    await expect(session.connect("DEV-1", "Lumen-1A2B")).resolves.toBeDefined();
    expect(session.linkState).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// 与连接生命周期的接线：一次成功会话一条
// ---------------------------------------------------------------------------

describe("#34 连接时记录（session 接线）", () => {
  function makeHooked(platform: "android" | "ios" | "other" = "android") {
    const events: ConnectionIdentity[] = [];
    const sink = {
      recordConnection: (identity: ConnectionIdentity) => {
        events.push(identity);
      },
      replay: () => undefined,
    };
    const clock = fakeClock();
    const transport = new FakeTransport();
    const session = new ControlSession({
      platform,
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage: createMemoryUsageStorage(),
      reconnectTimer: clock.api,
      usageLogger: sink,
    });
    return { events, sink, transport, session, clock };
  }

  it("手动连接成功记录一条，带广播名 / deviceId / 平台", async () => {
    const h = makeHooked("android");
    await h.session.connect("AA:BB:CC:DD:1A:2B", "Lumen-1A2B");

    expect(h.events).toEqual([
      { deviceName: "Lumen-1A2B", deviceId: "AA:BB:CC:DD:1A:2B", platform: "android" },
    ]);
  });

  it("失败连接不记录", async () => {
    const h = makeHooked();
    h.transport.connectResult = new Error("设备不在附近");
    await expect(h.session.connect("DEV-1", "Lumen-1A2B")).rejects.toThrow("设备不在附近");
    expect(h.events).toHaveLength(0);
  });

  it("对已连接的同一台设备重复 connect（只重读 State）不重复记录", async () => {
    const h = makeHooked();
    await h.session.connect("DEV-1", "Lumen-1A2B");
    await h.session.connect("DEV-1", "Lumen-1A2B");
    expect(h.events).toHaveLength(1);
  });

  it("非主动断线后自动回连成功 → 再记一条（每次会话一条）", async () => {
    const h = makeHooked();
    await h.session.connect("DEV-1", "Lumen-1A2B");
    expect(h.events).toHaveLength(1);

    h.transport.emitLink("idle", { reconnectable: true });
    h.clock.advance(1000);
    await settle();

    expect(h.events).toHaveLength(2);
    expect(h.events[1]).toEqual({
      deviceName: "Lumen-1A2B",
      deviceId: "DEV-1",
      platform: "android",
    });
  });

  it("自动回连失败不记录", async () => {
    const h = makeHooked();
    await h.session.connect("DEV-1", "Lumen-1A2B");
    h.transport.connectResult = new Error("设备不在附近");

    h.transport.emitLink("idle", { reconnectable: true });
    h.clock.advance(1000);
    await settle();

    expect(h.events).toHaveLength(1);
  });

  it("未注入 logger 时连接照常工作", async () => {
    const transport = new FakeTransport();
    const session = new ControlSession({
      platform: "other",
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage: createMemoryUsageStorage(),
    });
    await expect(session.connect("DEV-1", "Lumen-1A2B")).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 端到端组装：真实 logger + 假 HTTP + 真实 session
// ---------------------------------------------------------------------------

describe("#34 组装后的完整链路（假后端）", () => {
  it("连接 → 记录落地；断线重连 → 再一条；后端不可用期间不丢", async () => {
    let backendUp = true;
    const received: UsageEvent[] = [];
    const fetch: HttpFetch = async (req) => {
      if (!backendUp) throw new Error("ECONNREFUSED");
      const event = JSON.parse(req.body) as UsageEvent;
      received.push(event);
      const duplicate = received.filter((e) => e.clientEventId === event.clientEventId).length > 1;
      return { status: duplicate ? 200 : 201, body: JSON.stringify({ id: 1, duplicate }) };
    };

    const clock = fakeClock();
    const { logger } = makeLogger({ fetch, now: () => 1_760_000_000_000, timer: clock.api });
    const transport = new FakeTransport();
    const session = new ControlSession({
      platform: "ios",
      devMode: false,
      transportOverride: transport as unknown as BleTransport,
      storage: createMemoryUsageStorage(),
      reconnectTimer: clock.api,
      usageLogger: logger,
    });

    await session.connect("IOS-UUID-1", "Lumen-4D5E");
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0].device).toEqual({
      deviceName: "Lumen-4D5E",
      deviceId: "IOS-UUID-1",
      platform: "ios",
    });

    // 后端挂了，期间又连了一次（本地记录进队列）
    backendUp = false;
    transport.emitLink("idle", { reconnectable: true });
    clock.advance(1000);
    await settle();
    expect(logger.pending).toBe(1);

    // 恢复后补报
    backendUp = true;
    logger.replay();
    await settle();
    expect(logger.pending).toBe(0);
    expect(received).toHaveLength(2);
    expect(received[0].clientEventId).not.toBe(received[1].clientEventId);
  });
});
