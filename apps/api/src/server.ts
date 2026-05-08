import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import { env } from "./config.js";
import { registerAuth } from "./auth/middleware.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCoreRoutes } from "./routes/core.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerBot } from "./bot.js";
import { AppError } from "./errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      transport: env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" }
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: false
  });
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true
  });
  await app.register(rateLimit, {
    max: 180,
    timeWindow: "1 minute"
  });

  await registerAuth(app);
  await registerAuthRoutes(app);
  await registerCoreRoutes(app);
  await registerAdminRoutes(app);
  await registerBot(app);

  const miniAppDist = path.resolve(__dirname, "../../mini-app/dist");
  if (fs.existsSync(miniAppDist)) {
    await app.register(fastifyStatic, {
      root: miniAppDist,
      prefix: "/app/",
      decorateReply: false
    });
  } else {
    app.log.warn({ miniAppDist }, "mini app dist folder not found; static serving disabled");
  }

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ error }, "request failed");
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: error.issues });
    }
    return reply.code(500).send({ error: "Internal server error" });
  });

  return app;
}
