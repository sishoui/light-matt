import Fastify, { type FastifyInstance } from "fastify";
import { checkAdminAuth, checkAppToken } from "./auth.js";
import { listDevices, listUsers, recordUsage, type Db } from "./db.js";
import { validateLogPayload } from "./validate.js";
import { devicesPage, unauthorizedPage, usersPage } from "./views.js";

export interface AppConfig {
  readonly db: Db;
  readonly adminUser: string;
  readonly adminPassword: string;
  readonly appToken: string;
  readonly logger?: boolean;
}

const APP_TOKEN_HEADER = "x-lumen-app-token";

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logger === true ? { level: "info" } : false,
    // 日志体很小，1MB 已绰绰有余；超限直接 413。
    bodyLimit: 1024 * 1024,
  });

  const adminCreds = { user: config.adminUser, password: config.adminPassword };
  const appToken = config.appToken;

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
