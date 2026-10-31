import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { checkAdminAuth, checkAppToken } from "./auth.js";
import {
  findUserIdByKey,
  listDevices,
  listRegisteredDevices,
  listUserDevices,
  listUsers,
  parseLedCounts,
  recordUsage,
  registerDevice,
  renameDevice,
  touchDevice,
  unlinkDevice,
  upsertUserForKey,
  type Db,
} from "./db.js";
import {
  validateLogPayload,
  validateRegisterPayload,
  validateRenamePayload,
  validateSeenPayload,
  validateSessionPayload,
  validateUserKeyHeader,
} from "./validate.js";
import { devicesPage, registeredDevicesPage, unauthorizedPage, usersPage } from "./views.js";
import { exchangeCodeForOpenId } from "./wx.js";

/**
 * 微信凭据是可选的：不配就走 `local-<16hex>` 回落，设备登记照样能用，
 * 只是身份可伪造、列表只在单机有意义（docs/spec-v3.md §2.3）。
 * `fetchImpl` 只给测试注入假实现用，生产路径不传。
 */
export interface AppWxConfig {
  readonly appid: string;
  readonly secret: string;
  readonly fetchImpl?: typeof fetch;
}

export interface AppConfig {
  readonly db: Db;
  readonly adminUser: string;
  readonly adminPassword: string;
  readonly appToken: string;
  readonly wx?: AppWxConfig;
  readonly logger?: boolean;
}

const APP_TOKEN_HEADER = "x-lumen-app-token";

/**
 * 设备路由的用户身份。
 *
 * 这个头是**可伪造的自称**，不是认证凭据：谁能设置它谁就能冒充任何人。
 * 这是刻意为之 —— v3 明确「不做访问控制」（docs/spec-v3.md §2.3、
 * docs/agents/issue-tracker.md），`user_devices` 只回答「谁登记过」，
 * 不回答「谁能连」。配合共享 app token 只保证「请求来自这个构建的小程序」。
 *
 * 没有 HMAC、没有会话令牌、没有签名：那套东西只有在「设备归属即权限」时才有意义，
 * 而本项目刻意不做归属。上线前若要加，这里是唯一需要改的地方。
 */
const USER_KEY_HEADER = "x-lumen-user-key";

/** `:id` 只接受纯十进制，拒绝 `1abc`（SQLite 会把它当 1）。 */
const DEVICE_ID = /^\d+$/;

function unauthorized(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(401).send({ error: "unauthorized", message });
}

function invalidPayload(
  reply: FastifyReply,
  details: ReadonlyArray<{ field: string; message: string }>,
): FastifyReply {
  return reply.code(400).send({ error: "invalid_payload", details });
}

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logger === true ? { level: "info" } : false,
    // 日志体很小，1MB 已绰绰有余；超限直接 413。
    bodyLimit: 1024 * 1024,
  });

  const adminCreds = { user: config.adminUser, password: config.adminPassword };
  const appToken = config.appToken;

  /** app token 校验，五个设备路由与 session 共用。 */
  function hasAppToken(request: FastifyRequest): boolean {
    return checkAppToken(request.headers[APP_TOKEN_HEADER] as string | undefined, appToken);
  }

  type UserResolution = { readonly userId: number } | { readonly reply: FastifyReply };

  /**
   * 解析调用者。顺序固定：app token(401) → 头存在(401) → 用户已登记(404)。
   * 「用户不存在」不能顺手建行：设备归属的口径是「先有 session 才有设备」。
   */
  function resolveUser(request: FastifyRequest, reply: FastifyReply): UserResolution {
    if (!hasAppToken(request)) {
      return { reply: unauthorized(reply, `缺少或无效的 ${APP_TOKEN_HEADER}`) };
    }
    const userKey = validateUserKeyHeader(request.headers[USER_KEY_HEADER] as string | undefined);
    if (userKey === null) {
      return { reply: unauthorized(reply, `缺少 ${USER_KEY_HEADER}`) };
    }
    const userId = findUserIdByKey(config.db, userKey);
    if (userId === null) {
      return {
        reply: reply.code(404).send({
          error: "unknown_user",
          message: "先调用 POST /api/v1/session 换取身份",
        }),
      };
    }
    return { userId };
  }

  /** 路径里的设备 id；格式不对返回 null，调用方给 400。 */
  function parseDeviceId(request: FastifyRequest): number | null {
    const raw = (request.params as { id?: string }).id;
    if (typeof raw !== "string" || !DEVICE_ID.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  // ---------------------------------------------------------------- 健康检查
  // 无鉴权、无数据，只回答「进程还活着」。小程序用它决定要不要补报缓存。
  app.get("/health", async () => ({ ok: true }));

  // ------------------------------------------------ 小程序写入端（应用级令牌）
  // 这里只有一个写接口。没有读接口、没有配置接口、没有控制通道。
  app.post("/api/v1/usage-logs", async (request, reply) => {
    if (!checkAppToken(request.headers[APP_TOKEN_HEADER] as string | undefined, appToken)) {
      return reply
        .code(401)
        .send({ error: "unauthorized", message: `缺少或无效的 ${APP_TOKEN_HEADER}` });
    }

    const parsed = validateLogPayload(request.body);
    if (parsed.ok === false) {
      return reply.code(400).send({ error: "invalid_payload", details: parsed.errors });
    }

    const result = recordUsage(config.db, {
      userKey: parsed.value.userKey,
      displayName: parsed.value.displayName,
      device: parsed.value.device,
      startedAt: parsed.value.startedAt,
      endedAt: parsed.value.endedAt,
      clientEventId: parsed.value.clientEventId,
      reportedAt: Date.now(),
    });

    // 重复补报返回 200，让小程序可以安全重试（幂等）。
    return reply.code(result.duplicate ? 200 : 201).send({
      id: result.id,
      duplicate: result.duplicate,
      deviceKey: result.deviceKey,
      deviceKeyKind: result.deviceKeyKind,
    });
  });

  // ------------------------------------------------------------ 会话 / 身份
  //
  // 配了 WX_APPID + WX_SECRET：code → openid，identityKind = "openid"，trusted = true。
  // 没配：接受自称的 local-<16hex>，identityKind = "local"，trusted = false。
  //
  // `trusted` 不是权限开关，只是让 App 能显示「仅本机可见」的提示。
  // 两种模式都没有签名令牌，见 USER_KEY_HEADER 的注释。
  app.post("/api/v1/session", async (request, reply) => {
    if (!hasAppToken(request)) {
      return unauthorized(reply, `缺少或无效的 ${APP_TOKEN_HEADER}`);
    }

    const parsed = validateSessionPayload(request.body);
    if (parsed.ok === false) return invalidPayload(reply, parsed.errors);

    const now = Date.now();
    const wx = config.wx;

    if (wx !== undefined) {
      if (parsed.value.code === null) {
        return invalidPayload(reply, [{ field: "code", message: "已配置微信登录，code 必填" }]);
      }
      const result = await exchangeCodeForOpenId(parsed.value.code, wx, wx.fetchImpl ?? fetch);
      if (result.ok === false) {
        if (result.reason === "invalid_code") {
          return reply.code(401).send({
            error: "invalid_code",
            message: "wx.login 的 code 无效或已过期，请重新登录",
          });
        }
        return reply.code(502).send({
          error: "upstream_unavailable",
          message: "微信 code2session 暂时不可用，请稍后重试",
        });
      }
      const userId = upsertUserForKey(config.db, result.openid, now);
      return reply.code(200).send({
        userKey: result.openid,
        identityKind: "openid",
        trusted: true,
        userId,
      });
    }

    if (parsed.value.userKey === null) {
      return invalidPayload(reply, [
        { field: "userKey", message: "未配置微信登录，必须提供 local-<16 位小写 hex> 身份" },
      ]);
    }
    const userId = upsertUserForKey(config.db, parsed.value.userKey, now);
    return reply.code(200).send({
      userKey: parsed.value.userKey,
      identityKind: "local",
      trusted: false,
      userId,
    });
  });

  // ------------------------------------------------------------ 设备登记 API
  app.post("/api/v1/devices/register", async (request, reply) => {
    const user = resolveUser(request, reply);
    if ("reply" in user) return user.reply;

    const parsed = validateRegisterPayload(request.body);
    if (parsed.ok === false) return invalidPayload(reply, parsed.errors);

    const result = registerDevice(config.db, {
      userId: user.userId,
      hardwareId: parsed.value.hardwareId,
      displayName: parsed.value.displayName,
      now: Date.now(),
    });
    return reply.code(result.created ? 201 : 200).send({
      deviceId: result.deviceId,
      hardwareId: parsed.value.hardwareId,
      displayName: result.displayName,
    });
  });

  app.get("/api/v1/devices", async (request, reply) => {
    const user = resolveUser(request, reply);
    if ("reply" in user) return user.reply;

    const rows = listUserDevices(config.db, user.userId);
    return reply.code(200).send({
      devices: rows.map((row) => ({
        id: Number(row.id),
        hardwareId: row.hardware_id,
        displayName: row.display_name,
        lastSeenAt: Number(row.last_seen_at),
        addedAt: Number(row.added_at),
        ledCounts: parseLedCounts(row.led_counts),
        firmwareVer: row.firmware_ver === null ? null : Number(row.firmware_ver),
      })),
    });
  });

  app.patch("/api/v1/devices/:id", async (request, reply) => {
    const user = resolveUser(request, reply);
    if ("reply" in user) return user.reply;

    const deviceId = parseDeviceId(request);
    if (deviceId === null) return invalidPayload(reply, [{ field: "id", message: "必须是正整数" }]);

    const parsed = validateRenamePayload(request.body);
    if (parsed.ok === false) return invalidPayload(reply, parsed.errors);

    // 只改调用者自己的备注名；不是本人的关联一律 404（不泄露设备是否存在）。
    if (!renameDevice(config.db, user.userId, deviceId, parsed.value.displayName)) {
      return reply.code(404).send({ error: "device_not_found", message: "该设备不在你的列表里" });
    }
    return reply.code(200).send({ id: deviceId, displayName: parsed.value.displayName });
  });

  app.delete("/api/v1/devices/:id", async (request, reply) => {
    const user = resolveUser(request, reply);
    if ("reply" in user) return user.reply;

    const deviceId = parseDeviceId(request);
    if (deviceId === null) return invalidPayload(reply, [{ field: "id", message: "必须是正整数" }]);

    // 只删关联，不删 devices 行：设备是跨用户共享实体，别人可能还登记着。
    if (!unlinkDevice(config.db, user.userId, deviceId)) {
      return reply.code(404).send({ error: "device_not_found", message: "该设备不在你的列表里" });
    }
    return reply.code(200).send({ deleted: true });
  });

  app.post("/api/v1/devices/:id/seen", async (request, reply) => {
    const user = resolveUser(request, reply);
    if ("reply" in user) return user.reply;

    const deviceId = parseDeviceId(request);
    if (deviceId === null) return invalidPayload(reply, [{ field: "id", message: "必须是正整数" }]);

    // 只认 ledCounts / firmwareVer 两个字段，其余（rgb/brightness/segment/script…）
    // 一概忽略 —— 后端不存灯光配置。
    const parsed = validateSeenPayload(request.body);
    if (parsed.ok === false) return invalidPayload(reply, parsed.errors);

    const row = touchDevice(config.db, {
      userId: user.userId,
      deviceId,
      ledCounts: parsed.value.ledCounts,
      firmwareVer: parsed.value.firmwareVer,
      now: Date.now(),
    });
    if (row === null) {
      return reply.code(404).send({ error: "device_not_found", message: "该设备不在你的列表里" });
    }
    return reply.code(200).send({
      id: Number(row.id),
      hardwareId: row.hardware_id,
      displayName: row.display_name,
      lastSeenAt: Number(row.last_seen_at),
      ledCounts: parseLedCounts(row.led_counts),
      firmwareVer: row.firmware_ver === null ? null : Number(row.firmware_ver),
      createdAt: Number(row.created_at),
    });
  });

  // -------------------------------------------------- 后台只读端（Basic Auth）
  await app.register(
    async (admin) => {
      admin.addHook("onRequest", async (request, reply) => {
        const header = request.headers.authorization;
        if (!checkAdminAuth(header, adminCreds)) {
          return reply
            .code(401)
            .header("WWW-Authenticate", 'Basic realm="lumen admin", charset="UTF-8"')
            .type("text/html; charset=utf-8")
            .send(unauthorizedPage());
        }
        return undefined;
      });

      admin.get("/", async (_request, reply) => reply.redirect("/admin/devices", 302));

      admin.get("/devices", async (_request, reply) => {
        const rows = listDevices(config.db);
        return reply.type("text/html; charset=utf-8").send(devicesPage(rows));
      });

      admin.get("/users", async (_request, reply) => {
        const rows = listUsers(config.db);
        return reply.type("text/html; charset=utf-8").send(usersPage(rows));
      });

      // v3：设备登记表。只读；写方法由下面的通配器拦掉。
      admin.get("/registry", async (_request, reply) => {
        const rows = listRegisteredDevices(config.db);
        return reply.type("text/html; charset=utf-8").send(registeredDevicesPage(rows));
      });

      // 显式拦截后台的所有变更方法。后台没有写路由，也不允许被「顺手」加上：
      // 任何 POST / PUT / PATCH / DELETE 到 /admin/** 一律 405。
      admin.route({
        method: ["POST", "PUT", "PATCH", "DELETE"],
        url: "/*",
        handler: async (_request, reply) =>
          reply.code(405).header("Allow", "GET, HEAD").send({
            error: "method_not_allowed",
            message: "只读看板不接受写操作",
          }),
      });
      admin.route({
        method: ["POST", "PUT", "PATCH", "DELETE"],
        url: "/",
        handler: async (_request, reply) =>
          reply.code(405).header("Allow", "GET, HEAD").send({
            error: "method_not_allowed",
            message: "只读看板不接受写操作",
          }),
      });
    },
    { prefix: "/admin" },
  );

  return app;
}
