import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Env {
  PORT: number;
  HOST: string;
  DB_PATH: string;
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
  APP_TOKEN: string;
  /** 两个一起配才有 openid 身份；都不配就走 local-<hex> 回落。 */
  WX_APPID?: string;
  WX_SECRET?: string;
}

/** 三个秘密都必须在环境里显式给出：不提供任何可用的默认凭据。 */
export function readEnv(env: NodeJS.ProcessEnv): Env {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      missing.push(name);
      return "";
    }
    return value.trim();
  };

  const adminUser = required("ADMIN_USER");
  const adminPassword = required("ADMIN_PASSWORD");
  const appToken = required("APP_TOKEN");
  if (missing.length > 0) {
    throw new Error(`缺少必需的环境变量：${missing.join(", ")}（见 server/README.md）`);
  }

  const optional = (name: string): string | undefined => {
    const value = env[name];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  };

  const portRaw = env.PORT ?? "8787";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 非法：${portRaw}`);
  }

  // 微信凭据是可选的，但必须成对出现：只配一半会让运行期行为依赖「哪个先读到」，
  // 而且从外部看是「配了但登录总是 502」，不如启动就炸。
  const wxAppid = optional("WX_APPID");
  const wxSecret = optional("WX_SECRET");
  if ((wxAppid === undefined) !== (wxSecret === undefined)) {
    throw new Error("WX_APPID 与 WX_SECRET 必须同时配置或同时留空（见 server/README.md）");
  }

  return {
    PORT: port,
    HOST: env.HOST ?? "127.0.0.1",
    DB_PATH: env.DB_PATH ?? "./data/lumen.db",
    ADMIN_USER: adminUser,
    ADMIN_PASSWORD: adminPassword,
    APP_TOKEN: appToken,
    ...(wxAppid === undefined || wxSecret === undefined
      ? {}
      : { WX_APPID: wxAppid, WX_SECRET: wxSecret }),
  };
}

export function ensureDbDir(dbPath: string): void {
  if (dbPath === ":memory:") return;
  mkdirSync(dirname(dbPath), { recursive: true });
}
