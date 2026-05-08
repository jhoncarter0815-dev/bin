import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { devTelegramUser, verifyTelegramInitData } from "../auth/telegram.js";
import { signAuthToken } from "../auth/jwt.js";
import { toPublicUser, toWalletDto } from "../game/dto.js";
import { prisma } from "../prisma.js";
import { upsertTelegramUser } from "../services/users.js";

const authBodySchema = z.object({
  initData: z.string().optional(),
  dev: z.boolean().optional(),
  devUser: z
    .object({
      id: z.number().optional()
    })
    .optional()
});

export async function registerAuthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/api/auth/telegram", async (request) => {
    const body = authBodySchema.parse(request.body);
    const telegramUser = body.initData
      ? verifyTelegramInitData(body.initData)
      : devTelegramUser(body.devUser?.id);

    const user = await upsertTelegramUser(telegramUser);
    const token = signAuthToken({
      sub: user.id,
      telegramId: user.telegramId.toString(),
      username: user.username,
      isAdmin: user.isAdmin
    });

    return {
      token,
      user: toPublicUser(user),
      wallet: user.wallet ? toWalletDto(user.wallet) : { balance: 0, locked: 0 }
    };
  });

  fastify.get("/api/me", { preHandler: fastify.authenticate }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user!.id },
      include: { wallet: true }
    });
    return {
      user: toPublicUser(user),
      wallet: user.wallet ? toWalletDto(user.wallet) : { balance: 0, locked: 0 },
      isAdmin: user.isAdmin
    };
  });
}

