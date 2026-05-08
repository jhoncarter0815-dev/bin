import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
  startPractice
} from "../game/roomManager.js";
import { toTransactionDto, toWalletDto } from "../game/dto.js";
import { prisma } from "../prisma.js";

const seatBodySchema = z.object({
  seatNumber: z.coerce.number().int().positive()
});

export async function registerCoreRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/health", async () => ({ ok: true, service: "telegram-bingo-platform" }));

  fastify.get("/api/rooms/current", { preHandler: fastify.authenticate }, async (request) => {
    return getOrCreatePublicRoom(request.user!.id);
  });

  fastify.get("/api/rooms/:id", { preHandler: fastify.authenticate }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return getRoom(params.id, request.user!.id);
  });

  fastify.post("/api/rooms/:id/join-seat", { preHandler: fastify.authenticate }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = seatBodySchema.parse(request.body);
    return joinSeat(params.id, request.user!.id, body.seatNumber);
  });

  fastify.post("/api/rooms/:id/leave", { preHandler: fastify.authenticate }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    await leaveRoom(params.id, request.user!.id);
    return { ok: true };
  });

  fastify.post("/api/practice/start", { preHandler: fastify.authenticate }, async (request) => {
    return startPractice(request.user!);
  });

  fastify.get("/api/match/active", { preHandler: fastify.authenticate }, async (request) => {
    return getActiveMatchForUser(request.user!.id);
  });

  fastify.post("/api/match/:id/bingo", { preHandler: fastify.authenticate }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return claimBingo(params.id, request.user!.id);
  });

  fastify.post("/api/match/:id/exit", { preHandler: fastify.authenticate }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    await forfeitActiveMatch(params.id, request.user!.id);
    return { ok: true };
  });

  fastify.get("/api/match/:id/fair", { preHandler: fastify.authenticate }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return getFairProof(params.id);
  });

  fastify.get("/api/matches/history", { preHandler: fastify.authenticate }, async (request) => {
    return getHistory(request.user!.id);
  });

  fastify.get("/api/wallet", { preHandler: fastify.authenticate }, async (request) => {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId: request.user!.id }
    });
    return toWalletDto(wallet);
  });

  fastify.get("/api/transactions", { preHandler: fastify.authenticate }, async (request) => {
    const txns = await prisma.transaction.findMany({
      where: { userId: request.user!.id },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    return txns.map(toTransactionDto);
  });

  fastify.get("/api/profile", { preHandler: fastify.authenticate }, async (request) => {
    const [totalMatches, wins, losses] = await Promise.all([
      prisma.playerResult.count({ where: { userId: request.user!.id } }),
      prisma.playerResult.count({ where: { userId: request.user!.id, status: "WINNER" } }),
      prisma.playerResult.count({ where: { userId: request.user!.id, status: "LOST" } })
    ]);

    return { totalMatches, wins, losses };
  });
}

