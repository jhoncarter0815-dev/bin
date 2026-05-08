import { env } from "./config.js";
import { bot } from "./bot.js";
import { prisma } from "./prisma.js";
import { buildServer } from "./server.js";
import { registerRealtime } from "./realtime.js";
import { startGameScheduler } from "./jobs.js";

const app = await buildServer();
registerRealtime(app, app.server);
const scheduler = startGameScheduler(app.log);

const shutdown = async () => {
  clearInterval(scheduler);
  try {
    bot.stop("shutdown");
  } catch {
    // The bot may be skipped in local development.
  }
  await app.close();
  await prisma.$disconnect();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host: env.HOST, port: env.PORT });
