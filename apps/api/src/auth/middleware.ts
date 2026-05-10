import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isConfiguredAdminTelegramId } from "../config.js";
import { prisma } from "../prisma.js";
import { verifyAuthToken, type AuthTokenPayload } from "./jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthTokenPayload;
    user?: {
      id: string;
      telegramId: bigint;
      username: string | null;
      firstName: string | null;
      lastName: string | null;
      photoUrl: string | null;
      isAdmin: boolean;
      isBanned: boolean;
    };
  }
}

export async function registerAuth(fastify: FastifyInstance): Promise<void> {
  fastify.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const header = request.headers.authorization;
      const token = header?.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : undefined;
      if (!token) return reply.code(401).send({ error: "Missing auth token" });

      try {
        const payload = verifyAuthToken(token);
        const user = await prisma.user.findUnique({
          where: { id: payload.sub },
          select: {
            id: true,
            telegramId: true,
            username: true,
            firstName: true,
            lastName: true,
            photoUrl: true,
            isAdmin: true,
            isBanned: true,
          },
        });
        if (!user || user.isBanned)
          return reply.code(401).send({ error: "Account unavailable" });
        request.auth = payload;
        request.user = {
          ...user,
          isAdmin: user.isAdmin || isConfiguredAdminTelegramId(user.telegramId),
        };
      } catch {
        return reply.code(401).send({ error: "Invalid auth token" });
      }
    },
  );
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}
