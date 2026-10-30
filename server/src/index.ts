import { buildApp } from "./app.js";
import { ensureDbDir, readEnv } from "./config.js";
import { openDatabase } from "./db.js";

async function main(): Promise<void> {
  const env = readEnv(process.env);
  ensureDbDir(env.DB_PATH);
  const db = openDatabase(env.DB_PATH);

  const app = await buildApp({
    db,
    adminUser: env.ADMIN_USER,
    adminPassword: env.ADMIN_PASSWORD,
    appToken: env.APP_TOKEN,
    logger: true,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到 ${signal}，正在关闭`);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
