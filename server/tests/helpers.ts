import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type Db } from "../src/db.js";

export const ADMIN_USER = "admin";
export const ADMIN_PASSWORD = "test-admin-password";
export const APP_TOKEN = "test-app-token";

export interface Harness {
  app: FastifyInstance;
  db: Db;
  close: () => Promise<void>;
}

/** 每个用例一套独立内存库 + fastify.inject，不监听端口、不联网。 */
export async function makeHarness(): Promise<Harness> {
  const db = openDatabase(":memory:");
  const app = await buildApp({
    db,
    adminUser: ADMIN_USER,
    adminPassword: ADMIN_PASSWORD,
    appToken: APP_TOKEN,
  });
  await app.ready();
  return {
    app,
    db,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

export function basicAuth(user = ADMIN_USER, password = ADMIN_PASSWORD): string {
  return "Basic " + Buffer.from(`${user}:${password}`, "utf8").toString("base64");
}

let seq = 0;
export function logBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    userKey: "openid-user-a",
    displayName: "小明",
    startedAt: 1_760_000_000_000 + seq * 1000,
    clientEventId: `evt-${process.pid}-${seq}`,
    device: {
      deviceName: "Lumen-1A2B",
      deviceId: "AA:BB:CC:DD:1A:2B",
      platform: "android",
    },
    ...overrides,
  };
}
