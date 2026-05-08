import type { FastifyBaseLogger } from "fastify";
import { env } from "./config.js";
import { tickRooms } from "./game/roomManager.js";

export function startGameScheduler(log: FastifyBaseLogger): NodeJS.Timeout {
  const intervalMs = Math.max(500, Math.min(env.DRAW_INTERVAL_MS, 2500));
  const timer = setInterval(async () => {
    try {
      const result = await tickRooms();
      if (result.started || result.drawn) log.info(result, "game scheduler tick");
    } catch (error) {
      log.error({ error }, "game scheduler failed");
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

