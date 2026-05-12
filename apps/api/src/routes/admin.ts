import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { toWalletRequestDto } from "../game/dto.js";
import { prisma } from "../prisma.js";
import {
  clearNonDepositCredits,
  creditWallet,
  debitWallet,
} from "../services/wallet.js";
import {
  approveWalletRequest,
  rejectWalletRequest,
  revalidateTelebirrWalletRequest,
} from "../services/walletRequests.js";

const creditBodySchema = z.object({
  amount: z.coerce.number().int(),
  reason: z.string().max(200).optional(),
});

const clearCreditsBodySchema = z.object({
  reason: z.string().max(200).optional(),
});

const walletRequestQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
});

const walletRequestActionBodySchema = z.object({
  note: z.string().max(500).optional(),
});

export async function registerAdminRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/api/admin")) assertAdminSecret(request);
  });

  fastify.get("/api/admin/users", async () => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { wallet: true },
    });

    return users.map((user) => ({
      id: user.id,
      telegramId: user.telegramId.toString(),
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      phoneNumber: user.phoneNumber,
      phoneVerifiedAt: user.phoneVerifiedAt?.toISOString() ?? null,
      isAdmin: user.isAdmin,
      isBanned: user.isBanned,
      wallet: user.wallet
        ? { balance: user.wallet.balance, locked: user.wallet.locked }
        : null,
      createdAt: user.createdAt.toISOString(),
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
            prizePool: true,
          },
        },
      },
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
          metadata: { reason: body.reason ?? null } as Prisma.InputJsonValue,
        });
      } else {
        await debitWallet(tx, {
          userId: user.id,
          amount: Math.abs(body.amount),
          type: "ADMIN_ADJUSTMENT",
          description: body.reason ?? "Admin debit adjustment",
          metadata: { reason: body.reason ?? null } as Prisma.InputJsonValue,
        });
      }
    });

    return { ok: true };
  });

  fastify.post("/api/admin/users/:id/clear-free-credits", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = clearCreditsBodySchema.parse(request.body ?? {});
    const user = await prisma.user.findUnique({ where: { id: params.id } });
    if (!user) throw new NotFoundError("User not found");

    const result = await prisma.$transaction((tx) =>
      clearNonDepositCredits(tx, {
        userId: user.id,
        reason: body.reason ?? "Admin cleared credits not backed by deposits",
        metadata: { reason: body.reason ?? null } as Prisma.InputJsonObject,
      }),
    );

    return {
      ok: true,
      removed: result.removed,
      balance: result.wallet.balance,
      locked: result.wallet.locked,
      totalDepositCredits: result.totalDepositCredits,
      totalDebits: result.totalDebits,
      depositBackedAvailable: result.depositBackedAvailable,
    };
  });

  fastify.get("/api/admin/wallet-requests", async (request) => {
    const query = walletRequestQuerySchema.parse(request.query);
    const requests = await prisma.walletRequest.findMany({
      where: query.status ? { status: query.status } : undefined,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        user: {
          select: {
            id: true,
            telegramId: true,
            username: true,
            firstName: true,
            lastName: true,
            wallet: true,
          },
        },
      },
    });

    return requests.map((walletRequest) => ({
      ...toWalletRequestDto(walletRequest),
      user: {
        id: walletRequest.user.id,
        telegramId: walletRequest.user.telegramId.toString(),
        username: walletRequest.user.username,
        firstName: walletRequest.user.firstName,
        lastName: walletRequest.user.lastName,
        wallet: walletRequest.user.wallet
          ? {
              balance: walletRequest.user.wallet.balance,
              locked: walletRequest.user.wallet.locked,
            }
          : null,
      },
    }));
  });

  fastify.post("/api/admin/wallet-requests/:id/approve", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = walletRequestActionBodySchema.parse(request.body ?? {});
    const result = await approveWalletRequest({
      requestId: params.id,
      adminNote: body.note,
    });
    return {
      request: toWalletRequestDto(result.request),
      wallet: { balance: result.wallet.balance, locked: result.wallet.locked },
    };
  });

  fastify.post(
    "/api/admin/wallet-requests/:id/retry-telebirr",
    async (request) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      const body = walletRequestActionBodySchema.parse(request.body ?? {});
      const result = await revalidateTelebirrWalletRequest({
        requestId: params.id,
        adminNote: body.note,
      });
      return {
        request: toWalletRequestDto(result.request),
        wallet: result.wallet
          ? { balance: result.wallet.balance, locked: result.wallet.locked }
          : null,
        validation: {
          autoApprove: result.validation.autoApprove,
          status: result.validation.status,
          reason: result.validation.reason,
        },
      };
    },
  );

  fastify.post("/api/admin/wallet-requests/:id/reject", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = walletRequestActionBodySchema.parse(request.body ?? {});
    const walletRequest = await rejectWalletRequest({
      requestId: params.id,
      adminNote: body.note,
    });
    return toWalletRequestDto(walletRequest);
  });
}

function assertAdminSecret(request: FastifyRequest): void {
  const secret = request.headers["x-admin-secret"];
  if (secret !== env.ADMIN_SECRET)
    throw new ForbiddenError("Invalid admin secret");
}
