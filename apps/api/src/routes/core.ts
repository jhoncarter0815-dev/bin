import type { FastifyInstance } from "fastify";
import { BINGO_MAX_BALL } from "@bingo/shared";
import { z } from "zod";
import { env } from "../config.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import {
  claimBingo,
  forfeitActiveMatch,
  getActiveMatchForUser,
  getFairProof,
  getHistory,
  getOrCreatePublicRoom,
  getRoom,
  joinSeat,
  leaveRoom,
  startPractice,
} from "../game/roomManager.js";
import { toTransactionDto, toWalletDto } from "../game/dto.js";
import { prisma } from "../prisma.js";

const seatBodySchema = z.object({
  seatNumber: z.coerce.number().int().positive(),
});

const bingoClaimBodySchema = z.object({
  markedNumbers: z
    .array(z.coerce.number().int().min(1).max(BINGO_MAX_BALL))
    .max(BINGO_MAX_BALL)
    .optional(),
});

export async function registerCoreRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get("/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, service: "telegram-bingo-platform", storage: "ready" };
  });

  fastify.get(
    "/api/rooms/current",
    { preHandler: fastify.authenticate },
    async (request) => {
      return getOrCreatePublicRoom(request.user!.id);
    },
  );

  fastify.get(
    "/api/rooms/:id",
    { preHandler: fastify.authenticate },
    async (request) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      return getRoom(params.id, request.user!.id);
    },
  );

  fastify.post(
    "/api/rooms/:id/join-seat",
    { preHandler: fastify.authenticate },
    async (request) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      const body = seatBodySchema.parse(request.body);
      return joinSeat(params.id, request.user!.id, body.seatNumber);
    },
  );

  fastify.post(
    "/api/rooms/:id/leave",
    { preHandler: fastify.authenticate },
    async (request) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      await leaveRoom(params.id, request.user!.id);
      return { ok: true };
    },
  );

  fastify.post(
    "/api/practice/start",
    { preHandler: fastify.authenticate },
    async (request) => {
      return startPractice(request.user!);
    },
  );

  fastify.get(
    "/api/match/active",
    { preHandler: fastify.authenticate },
    async (request) => {
      return getActiveMatchForUser(request.user!.id);
    },
  );

  fastify.post(
    "/api/match/:id/bingo",
    { preHandler: fastify.authenticate },
    async (request) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      const body = bingoClaimBodySchema.parse(request.body ?? {});
      return claimBingo(params.id, request.user!.id, {
        markedNumbers: body.markedNumbers,
      });
    },
  );

  fastify.post(
    "/api/match/:id/exit",
    { preHandler: fastify.authenticate },
    async (request) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      await forfeitActiveMatch(params.id, request.user!.id);
      return { ok: true };
    },
  );

  fastify.get(
    "/api/match/:id/fair",
    { preHandler: fastify.authenticate },
    async (request) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      return getFairProof(params.id);
    },
  );

  fastify.get(
    "/api/match/:id/audit",
    { preHandler: fastify.authenticate },
    async (request) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      const match = await prisma.match.findUnique({
        where: { id: params.id },
        include: {
          room: {
            include: {
              seats: { select: { userId: true } },
            },
          },
        },
      });
      if (!match) throw new NotFoundError("Match not found");
      const seated = match.room.seats.some(
        (seat) => seat.userId === request.user!.id,
      );
      if (!seated && !request.user!.isAdmin)
        throw new ForbiddenError("You are not seated in this match");

      const logs = await prisma.auditLog.findMany({
        where: {
          action: {
            in: [
              "ROOM_CREATED",
              "SEAT_JOINED",
              "SEAT_FORFEITED",
              "MATCH_STARTED",
              "BALL_DRAWN",
              "BINGO_CLAIMED",
              "MANUAL_BINGO_CLAIMED",
              "MATCH_FINISHED",
              "MATCH_FINISHED_NO_WINNER",
              "ANNOUNCEMENT_MATCH_STARTED",
              "ANNOUNCEMENT_MATCH_FINISHED",
            ],
          },
          OR: [
            { target: `match:${match.id}` },
            { target: `room:${match.roomId}` },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: 250,
      });

      return logs.map((log) => ({
        id: log.id,
        action: log.action,
        target: log.target,
        metadata: log.metadata,
        createdAt: log.createdAt.toISOString(),
      }));
    },
  );

  fastify.get(
    "/api/matches/history",
    { preHandler: fastify.authenticate },
    async (request) => {
      return getHistory(request.user!.id);
    },
  );

  fastify.get(
    "/api/wallet",
    { preHandler: fastify.authenticate },
    async (request) => {
      const wallet = await prisma.wallet.findUniqueOrThrow({
        where: { userId: request.user!.id },
      });
      return toWalletDto(wallet);
    },
  );

  fastify.get(
    "/api/transactions",
    { preHandler: fastify.authenticate },
    async (request) => {
      const txns = await prisma.transaction.findMany({
        where: { userId: request.user!.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return txns.map(toTransactionDto);
    },
  );

  fastify.get(
    "/api/profile",
    { preHandler: fastify.authenticate },
    async (request) => {
      const [totalMatches, wins, losses] = await Promise.all([
        prisma.playerResult.count({ where: { userId: request.user!.id } }),
        prisma.playerResult.count({
          where: { userId: request.user!.id, status: "WINNER" },
        }),
        prisma.playerResult.count({
          where: { userId: request.user!.id, status: "LOST" },
        }),
      ]);

      const [user, referralCount, referralRewards] = await Promise.all([
        prisma.user.findUniqueOrThrow({
          where: { id: request.user!.id },
          select: { referralCode: true },
        }),
        prisma.referral.count({ where: { referrerId: request.user!.id } }),
        prisma.transaction.aggregate({
          where: {
            userId: request.user!.id,
            type: "REFERRAL_BONUS",
          },
          _sum: { amount: true },
        }),
      ]);

      return {
        totalMatches,
        wins,
        losses,
        referralCode: user.referralCode,
        referralCount,
        referralRewards: referralRewards._sum.amount ?? 0,
        referralLink: user.referralCode
          ? referralLink(user.referralCode)
          : undefined,
      };
    },
  );
}

function referralLink(referralCode: string): string {
  if (env.TELEGRAM_BOT_USERNAME) {
    return `https://t.me/${env.TELEGRAM_BOT_USERNAME.replace(/^@/, "")}?start=ref_${referralCode}`;
  }
  return `${env.PUBLIC_APP_URL || env.MINI_APP_DEV_URL}?ref=${encodeURIComponent(referralCode)}`;
}
