import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Env {
  PORT: number;
  HOST: string;
  DB_PATH: string;
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
  APP_TOKEN: string;
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

  const portRaw = env.PORT ?? "8787";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 非法：${portRaw}`);
  }

  return {
    PORT: port,
    HOST: env.HOST ?? "127.0.0.1",
    DB_PATH: env.DB_PATH ?? "./data/lumen.db",
    ADMIN_USER: adminUser,
    ADMIN_PASSWORD: adminPassword,
    APP_TOKEN: appToken,
  };
}

export function ensureDbDir(dbPath: string): void {
  if (dbPath === ":memory:") return;
  mkdirSync(dirname(dbPath), { recursive: true });
}
