import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { prisma } from "../prisma.js";
import { creditWallet, debitWallet } from "../services/wallet.js";

const creditBodySchema = z.object({
  amount: z.coerce.number().int(),
  reason: z.string().max(200).optional()
});

export async function registerAdminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/api/admin")) assertAdminSecret(request);
  });

  fastify.get("/api/admin/users", async () => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { wallet: true }
    });

    return users.map((user) => ({
      id: user.id,
      telegramId: user.telegramId.toString(),
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      isAdmin: user.isAdmin,
      isBanned: user.isBanned,
      wallet: user.wallet ? { balance: user.wallet.balance, locked: user.wallet.locked } : null,
      createdAt: user.createdAt.toISOString()
    }));
  });

  fastify.get("/api/admin/rooms", async () => {
    return prisma.room.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        _count: { select: { seats: true } },
        match: {
          select: {
            id: true,
            status: true,
            winnerSeat: true,
            prizePool: true
          }
        }
      }
    });
  });

  fastify.post("/api/admin/users/:id/credits", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = creditBodySchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { id: params.id } });
    if (!user) throw new NotFoundError("User not found");

    await prisma.$transaction(async (tx) => {
      if (body.amount >= 0) {
        await creditWallet(tx, {
          userId: user.id,
          amount: body.amount,
          type: "ADMIN_ADJUSTMENT",
          description: body.reason ?? "Admin credit adjustment",
          metadata: { reason: body.reason ?? null } as Prisma.InputJsonValue
        });
      } else {
        await debitWallet(tx, {
          userId: user.id,
          amount: Math.abs(body.amount),
          type: "ADMIN_ADJUSTMENT",
          description: body.reason ?? "Admin debit adjustment",
          metadata: { reason: body.reason ?? null } as Prisma.InputJsonValue
        });
      }
    });

    return { ok: true };
  });
}

function assertAdminSecret(request: FastifyRequest): void {
  const secret = request.headers["x-admin-secret"];
  if (secret !== env.ADMIN_SECRET) throw new ForbiddenError("Invalid admin secret");
}

