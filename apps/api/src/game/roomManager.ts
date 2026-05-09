import crypto from "node:crypto";
import { Prisma, type Room, type Seat, type User } from "@prisma/client";
import { customAlphabet } from "nanoid";
import { createCard, hasBingo } from "@bingo/shared";
import { env } from "../config.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  AppError,
} from "../errors.js";
import { prisma } from "../prisma.js";
import { emitMatch, emitRoom, emitUser } from "../realtime.js";
import {
  announceMatchFinished,
  announceMatchStarted,
  announceRoomReady,
} from "../services/announcements.js";
import { logAudit, matchTarget, roomTarget } from "../services/audit.js";
import {
  captureEntryFee,
  creditWallet,
  lockEntryFee,
  refundEntryFee,
} from "../services/wallet.js";
import {
  toMatchDto,
  toResultDto,
  toRoomDto,
  parseCard,
  parseNumberArray,
  parsePattern,
} from "./dto.js";
import { createFairSeed, randomFromSeed } from "./fairness.js";

const makeCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 7);

const roomInclude = {
  seats: {
    include: {
      user: {
        select: {
          username: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  },
} satisfies Prisma.RoomInclude;

const matchInclude = {
  room: {
    include: roomInclude,
  },
  results: {
    include: {
      user: {
        select: {
          username: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  },
} satisfies Prisma.MatchInclude;

type MatchWithSeats = Prisma.MatchGetPayload<{ include: typeof matchInclude }>;
type WinnerSeat = MatchWithSeats["room"]["seats"][number];
type ClaimBingoOptions = {
  markedNumbers?: number[];
};

export async function getOrCreatePublicRoom(userId?: string) {
  const existing = await prisma.room.findFirst({
    where: {
      type: "PUBLIC",
      status: { in: ["OPEN", "COUNTDOWN"] },
    },
    orderBy: { startsAt: "asc" },
    include: roomInclude,
  });

  if (existing && existing.seats.length < existing.maxSeats)
    return toRoomDto(existing, userId);

  const room = await prisma.room.create({
    data: {
      code: makeCode(),
      type: "PUBLIC",
      status: "COUNTDOWN",
      entryFee: env.PUBLIC_ENTRY_FEE,
      maxSeats: 200,
      startsAt: new Date(Date.now() + env.PUBLIC_ROOM_SECONDS * 1000),
    },
    include: roomInclude,
  });

  await logAudit(prisma, {
    action: "ROOM_CREATED",
    target: roomTarget(room.id),
    metadata: {
      code: room.code,
      type: room.type,
      entryFee: room.entryFee,
      maxSeats: room.maxSeats,
      startsAt: room.startsAt.toISOString(),
    },
  });

  return toRoomDto(room, userId);
}

export async function getRoom(roomId: string, userId?: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: roomInclude,
  });
  if (!room) throw new NotFoundError("Room not found");
  return toRoomDto(room, userId);
}

export async function joinSeat(
  roomId: string,
  userId: string,
  seatNumber: number,
) {
  if (!Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > 200) {
    throw new AppError("Seat must be between 1 and 200");
  }

  await prisma.$transaction(
    async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
        include: { seats: true },
      });
      if (!room) throw new NotFoundError("Room not found");
      if (!["OPEN", "COUNTDOWN"].includes(room.status))
        throw new ConflictError("Room already started");
      if (seatNumber > room.maxSeats)
        throw new AppError("Seat is outside room capacity");

      const existingForUser = room.seats.find((seat) => seat.userId === userId);
      if (existingForUser) {
        if (existingForUser.seatNumber === seatNumber) return;
        throw new ConflictError(
          `You already hold seat #${existingForUser.seatNumber}`,
        );
      }

      if (room.seats.some((seat) => seat.seatNumber === seatNumber)) {
        throw new ConflictError("Seat is already taken");
      }

      if (room.entryFee > 0) {
        await lockEntryFee(tx, {
          userId,
          amount: room.entryFee,
          roomId,
          description: `Entry fee locked for room ${room.code}`,
          metadata: { seatNumber },
        });
      }

      const card = createCard(secureRandomSource());
      await tx.seat.create({
        data: {
          roomId,
          userId,
          seatNumber,
          card: card as unknown as Prisma.InputJsonValue,
        },
      });

      await logAudit(tx, {
        actorId: userId,
        action: "SEAT_JOINED",
        target: roomTarget(roomId),
        metadata: {
          seatNumber,
          entryFee: room.entryFee,
          cardHash: hashJson(card),
        },
      });

      if (room.status === "OPEN") {
        await tx.room.update({
          where: { id: roomId },
          data: { status: "COUNTDOWN" },
        });
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  await broadcastRoom(roomId, userId);
  void announceRoomReady(roomId);
  return getRoom(roomId, userId);
}

export async function leaveRoom(roomId: string, userId: string) {
  await prisma.$transaction(
    async (tx) => {
      const seat = await tx.seat.findUnique({
        where: { roomId_userId: { roomId, userId } },
        include: { room: true },
      });
      if (!seat) return;
      if (!["OPEN", "COUNTDOWN"].includes(seat.room.status)) {
        throw new ConflictError("Use forfeit to leave an active match");
      }

      await tx.seat.delete({ where: { id: seat.id } });
      if (seat.room.entryFee > 0) {
        await refundEntryFee(tx, {
          userId,
          amount: seat.room.entryFee,
          roomId,
          description: `Refund for leaving room ${seat.room.code}`,
        });
      }

      await logAudit(tx, {
        actorId: userId,
        action: "SEAT_LEFT",
        target: roomTarget(roomId),
        metadata: {
          seatNumber: seat.seatNumber,
          entryFee: seat.room.entryFee,
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  await broadcastRoom(roomId, userId);
}

export async function startPractice(user: Pick<User, "id">) {
  const fair = createFairSeed(`practice:${user.id}`);
  const botUsers = await ensurePracticeBots();

  const match = await prisma.$transaction(async (tx) => {
    const room = await tx.room.create({
      data: {
        code: makeCode(),
        type: "PRACTICE",
        status: "ACTIVE",
        entryFee: 0,
        maxSeats: 5,
        startsAt: new Date(),
      },
    });

    const allPlayers = [user, ...botUsers].slice(0, 5);
    for (const [index, player] of allPlayers.entries()) {
      const seatNumber = index + 1;
      await tx.seat.create({
        data: {
          roomId: room.id,
          userId: player.id,
          seatNumber,
          status: "ACTIVE",
          card: createCard(
            randomFromSeed(`${fair.seed}:card:${player.id}:${seatNumber}`),
          ) as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return tx.match.create({
      data: {
        roomId: room.id,
        serverSeed: fair.seed,
        seedHash: fair.seedHash,
        drawOrder: fair.drawOrder as Prisma.InputJsonValue,
        calledNumbers: [],
        prizePool: 0,
      },
      include: matchInclude,
    });
  });

  emitUser(user.id, "match:state", toMatchDto(match, user.id));
  return toMatchDto(match, user.id);
}

export async function getActiveMatchForUser(userId: string) {
  const match = await prisma.match.findFirst({
    where: {
      status: "ACTIVE",
      room: {
        seats: {
          some: { userId },
        },
      },
    },
    orderBy: { startedAt: "desc" },
    include: matchInclude,
  });
  return match ? toMatchDto(match, userId) : null;
}

export async function claimBingo(
  matchId: string,
  userId: string,
  options: ClaimBingoOptions = {},
) {
  const result = await prisma.$transaction(
    async (tx) => {
      const match = await tx.match.findUnique({
        where: { id: matchId },
        include: matchInclude,
      });
      if (!match) throw new NotFoundError("Match not found");
      if (match.status !== "ACTIVE")
        throw new ConflictError("Match is already finished");

      const seat = match.room.seats.find((item) => item.userId === userId);
      if (!seat) throw new ForbiddenError("You are not seated in this match");
      if (seat.status === "FORFEIT")
        throw new ForbiddenError("Forfeited seats cannot claim bingo");

      if (options.markedNumbers)
        verifyManualBingoClaim(match, seat, options.markedNumbers);

      const winners = findWinningSeats(match);
      if (!winners.some((winner) => winner.userId === userId)) {
        throw new AppError(
          "That card does not have bingo yet",
          422,
          "INVALID_BINGO",
        );
      }

      await logAudit(tx, {
        actorId: userId,
        action: options.markedNumbers
          ? "MANUAL_BINGO_CLAIMED"
          : "BINGO_CLAIMED",
        target: matchTarget(match.id),
        metadata: {
          seatNumber: seat.seatNumber,
          currentIndex: match.currentIndex,
          calledCount: parseNumberArray(match.calledNumbers).length,
          markedNumbers: options.markedNumbers
            ? [...new Set(options.markedNumbers)].sort((a, b) => a - b)
            : undefined,
        },
      });

      return finishMatchWithWinners(tx, match, winners);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  await broadcastMatch(result.id);
  await broadcastRoom(result.roomId);
  void announceMatchFinished(result.id);
  return toMatchDto(result, userId);
}

export async function forfeitActiveMatch(matchId: string, userId: string) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: matchInclude,
  });
  if (!match) throw new NotFoundError("Match not found");
  const seat = match.room.seats.find((item) => item.userId === userId);
  if (!seat) return;

  await prisma.$transaction(async (tx) => {
    await tx.seat.update({
      where: { id: seat.id },
      data: { status: "FORFEIT" },
    });

    await tx.playerResult.upsert({
      where: { matchId_userId: { matchId, userId } },
      create: {
        matchId,
        userId,
        seatNumber: seat.seatNumber,
        status: "FORFEIT",
        pot: 0,
      },
      update: { status: "FORFEIT" },
    });

    await logAudit(tx, {
      actorId: userId,
      action: "SEAT_FORFEITED",
      target: matchTarget(matchId),
      metadata: { seatNumber: seat.seatNumber },
    });
  });

  await broadcastMatch(matchId);
}

export async function tickRooms() {
  const started = await startDueRooms();
  const drawn = await drawDueMatches();
  return { started, drawn };
}

export async function startDueRooms() {
  const dueRooms = await prisma.room.findMany({
    where: {
      status: { in: ["OPEN", "COUNTDOWN"] },
      startsAt: { lte: new Date() },
    },
    include: { seats: true },
    take: 25,
  });

  let started = 0;
  for (const room of dueRooms) {
    if (room.type === "PUBLIC" && room.seats.length === 0) {
      // Keep empty public rooms open, but start any seated room as soon as its countdown ends.
      await prisma.room.update({
        where: { id: room.id },
        data: {
          status: "COUNTDOWN",
          startsAt: new Date(Date.now() + env.PUBLIC_ROOM_SECONDS * 1000),
        },
      });
      await broadcastRoom(room.id);
      continue;
    }
    await startRoom(room);
    started += 1;
  }
  return started;
}

export async function drawDueMatches() {
  const matches = await prisma.match.findMany({
    where: {
      status: "ACTIVE",
      lastDrawAt: { lte: new Date(Date.now() - env.DRAW_INTERVAL_MS) },
    },
    include: matchInclude,
    take: 50,
  });

  let drawn = 0;
  for (const match of matches) {
    const drawOrder = parseNumberArray(match.drawOrder);

    if (match.currentIndex >= drawOrder.length) {
      await finishWithoutWinner(match.id);
      continue;
    }

    const updated = await prisma.$transaction(
      async (tx) => {
        const activeMatch = await tx.match.findUnique({
          where: { id: match.id },
          include: matchInclude,
        });
        if (!activeMatch || activeMatch.status !== "ACTIVE") return null;

        const activeDrawOrder = parseNumberArray(activeMatch.drawOrder);
        const calledNumbers = parseNumberArray(activeMatch.calledNumbers);
        if (activeMatch.currentIndex >= activeDrawOrder.length) return null;

        const nextNumber = activeDrawOrder[activeMatch.currentIndex]!;
        const drawnMatch = await tx.match.update({
          where: { id: activeMatch.id },
          data: {
            calledNumbers: [...calledNumbers, nextNumber],
            currentIndex: { increment: 1 },
            lastDrawAt: new Date(),
          },
          include: matchInclude,
        });

        await logAudit(tx, {
          action: "BALL_DRAWN",
          target: matchTarget(activeMatch.id),
          metadata: {
            number: nextNumber,
            index: activeMatch.currentIndex + 1,
            calledCount: calledNumbers.length + 1,
          },
        });

        const winners = findWinningSeats(drawnMatch);
        if (winners.length === 0) return drawnMatch;

        return finishMatchWithWinners(tx, drawnMatch, winners);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (updated) {
      await broadcastMatch(updated.id);
      if (updated.status === "FINISHED") {
        await broadcastRoom(updated.roomId);
        void announceMatchFinished(updated.id);
      }
      drawn += 1;
    }
  }
  return drawn;
}

async function finishMatchWithWinners(
  tx: Prisma.TransactionClient,
  match: MatchWithSeats,
  winners: WinnerSeat[],
) {
  if (winners.length === 0)
    throw new AppError("Cannot finish match without winners");

  const sortedWinners = [...winners].sort(
    (a, b) => a.seatNumber - b.seatNumber,
  );
  const payouts = splitPrizePool(match.prizePool, sortedWinners.length);
  const payoutByUserId = new Map(
    sortedWinners.map((winner, index) => [winner.userId, payouts[index] ?? 0]),
  );
  const firstWinner = sortedWinners[0]!;

  await tx.match.update({
    where: { id: match.id },
    data: {
      status: "FINISHED",
      winnerSeat: firstWinner.seatNumber,
      winnerUserId: firstWinner.userId,
      seedReveal: match.serverSeed,
      finishedAt: new Date(),
    },
  });

  await tx.room.update({
    where: { id: match.roomId },
    data: { status: "FINISHED" },
  });

  await tx.playerResult.createMany({
    data: match.room.seats.map((seat) => {
      const isWinner = payoutByUserId.has(seat.userId);
      const pot = payoutByUserId.get(seat.userId) ?? 0;
      return {
        matchId: match.id,
        userId: seat.userId,
        seatNumber: seat.seatNumber,
        status: isWinner
          ? "WINNER"
          : seat.status === "FORFEIT"
            ? "FORFEIT"
            : "LOST",
        pot,
      };
    }),
    skipDuplicates: true,
  });

  for (const winner of sortedWinners) {
    const amount = payoutByUserId.get(winner.userId) ?? 0;
    if (amount <= 0) continue;
    await creditWallet(tx, {
      userId: winner.userId,
      amount,
      type: "WIN_PAYOUT",
      roomId: match.roomId,
      matchId: match.id,
      description: `Bingo payout for room ${match.room.code}`,
    });
  }

  await logAudit(tx, {
    action: "MATCH_FINISHED",
    target: matchTarget(match.id),
    metadata: {
      roomId: match.roomId,
      roomCode: match.room.code,
      prizePool: match.prizePool,
      winnerSeats: sortedWinners.map((winner) => winner.seatNumber),
      payouts: sortedWinners.map((winner) => ({
        seatNumber: winner.seatNumber,
        amount: payoutByUserId.get(winner.userId) ?? 0,
      })),
      calledCount: parseNumberArray(match.calledNumbers).length,
    },
  });

  return tx.match.findUniqueOrThrow({
    where: { id: match.id },
    include: matchInclude,
  });
}

function findWinningSeats(match: MatchWithSeats): WinnerSeat[] {
  const calledNumbers = parseNumberArray(match.calledNumbers);
  const patterns = parsePattern(match.pattern);

  return match.room.seats
    .filter((seat) => seat.status !== "FORFEIT")
    .filter((seat) => hasBingo(parseCard(seat.card), calledNumbers, patterns))
    .sort((a, b) => a.seatNumber - b.seatNumber);
}

function verifyManualBingoClaim(
  match: MatchWithSeats,
  seat: WinnerSeat,
  markedNumbers: number[],
): void {
  const calledNumbers = parseNumberArray(match.calledNumbers);
  const called = new Set(calledNumbers);
  const uniqueMarkedNumbers = [...new Set(markedNumbers)];

  if (uniqueMarkedNumbers.some((value) => !called.has(value))) {
    throw new AppError(
      "Only called numbers can be marked",
      422,
      "INVALID_MARKS",
    );
  }

  if (
    !hasBingo(
      parseCard(seat.card),
      uniqueMarkedNumbers,
      parsePattern(match.pattern),
    )
  ) {
    throw new AppError(
      "Marked card does not have bingo yet",
      422,
      "INVALID_BINGO",
    );
  }
}

function splitPrizePool(prizePool: number, winnerCount: number): number[] {
  if (winnerCount <= 0) return [];
  const basePrize = Math.floor(prizePool / winnerCount);
  const remainder = prizePool % winnerCount;
  return Array.from(
    { length: winnerCount },
    (_, index) => basePrize + (index < remainder ? 1 : 0),
  );
}

export async function getHistory(userId: string) {
  const results = await prisma.playerResult.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      match: {
        include: {
          room: { select: { code: true } },
          results: {
            select: {
              status: true,
              seatNumber: true,
            },
          },
        },
      },
    },
  });
  return results.map(toResultDto);
}

export async function getFairProof(matchId: string) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      seedHash: true,
      seedReveal: true,
      drawOrder: true,
      calledNumbers: true,
      winnerSeat: true,
      results: {
        select: {
          status: true,
          seatNumber: true,
        },
      },
    },
  });
  if (!match) throw new NotFoundError("Match not found");
  return {
    matchId: match.id,
    seedHash: match.seedHash,
    seedReveal: match.seedReveal,
    drawOrder: parseNumberArray(match.drawOrder),
    calledNumbers: parseNumberArray(match.calledNumbers),
    winnerSeat: match.winnerSeat,
    winnerSeats: match.results
      .filter(
        (result) =>
          result.status === "WINNER" && typeof result.seatNumber === "number",
      )
      .map((result) => result.seatNumber!)
      .sort((a, b) => a - b),
  };
}

async function startRoom(room: Room & { seats: Seat[] }) {
  const fair = createFairSeed(room.id);
  const match = await prisma.$transaction(
    async (tx) => {
      const activeRoom = await tx.room.findUnique({
        where: { id: room.id },
        include: { seats: true },
      });
      if (!activeRoom || !["OPEN", "COUNTDOWN"].includes(activeRoom.status))
        return null;

      await tx.seat.updateMany({
        where: { roomId: room.id },
        data: { status: "ACTIVE" },
      });
      await tx.room.update({
        where: { id: room.id },
        data: { status: "ACTIVE" },
      });

      for (const seat of activeRoom.seats) {
        await captureEntryFee(tx, {
          userId: seat.userId,
          amount: activeRoom.entryFee,
          roomId: activeRoom.id,
        });
      }

      const match = await tx.match.create({
        data: {
          roomId: room.id,
          serverSeed: fair.seed,
          seedHash: fair.seedHash,
          drawOrder: fair.drawOrder as Prisma.InputJsonValue,
          calledNumbers: [],
          prizePool: activeRoom.seats.length * activeRoom.entryFee,
        },
        include: matchInclude,
      });

      await logAudit(tx, {
        action: "MATCH_STARTED",
        target: matchTarget(match.id),
        metadata: {
          roomId: room.id,
          roomCode: activeRoom.code,
          playerCount: activeRoom.seats.length,
          prizePool: match.prizePool,
          seedHash: fair.seedHash,
          drawOrderHash: hashJson(fair.drawOrder),
          pattern: match.pattern,
        },
      });

      return match;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  if (match) {
    await broadcastRoom(room.id);
    await broadcastMatch(match.id);
    void announceMatchStarted(match.id);
  }
}

async function finishWithoutWinner(matchId: string) {
  const existing = await prisma.match.findUnique({
    where: { id: matchId },
    select: { serverSeed: true },
  });
  if (!existing) return;

  const match = await prisma.$transaction(async (tx) => {
    const finished = await tx.match.update({
      where: { id: matchId },
      data: {
        status: "FINISHED",
        seedReveal: existing.serverSeed,
        finishedAt: new Date(),
      },
      include: matchInclude,
    });

    await tx.room.update({
      where: { id: finished.roomId },
      data: { status: "FINISHED" },
    });

    await tx.playerResult.createMany({
      data: finished.room.seats.map((seat) => ({
        matchId,
        userId: seat.userId,
        seatNumber: seat.seatNumber,
        status: seat.status === "FORFEIT" ? "FORFEIT" : "LOST",
        pot: 0,
      })),
      skipDuplicates: true,
    });

    await logAudit(tx, {
      action: "MATCH_FINISHED_NO_WINNER",
      target: matchTarget(matchId),
      metadata: {
        roomId: finished.roomId,
        roomCode: finished.room.code,
        calledCount: parseNumberArray(finished.calledNumbers).length,
      },
    });

    return finished;
  });

  await broadcastMatch(matchId);
  await broadcastRoom(match.roomId);
  void announceMatchFinished(matchId);
}

async function ensurePracticeBots() {
  const ids = [-900001n, -900002n, -900003n, -900004n];
  const bots = [];

  for (const [index, telegramId] of ids.entries()) {
    const bot = await prisma.user.upsert({
      where: { telegramId },
      create: {
        telegramId,
        username: `bot_${index + 1}`,
        firstName: `Bot ${index + 1}`,
        wallet: { create: { balance: 0 } },
      },
      update: {},
    });
    bots.push(bot);
  }

  return bots;
}

async function broadcastRoom(roomId: string, userId?: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: roomInclude,
  });
  if (!room) return;
  emitRoom(roomId, toRoomDto(room));
  if (userId) emitUser(userId, "room:state", toRoomDto(room, userId));
}

async function broadcastMatch(matchId: string) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: matchInclude,
  });
  if (!match) return;
  emitMatch(matchId, toMatchDto(match));
  for (const seat of match.room.seats) {
    emitUser(seat.userId, "match:state", toMatchDto(match, seat.userId));
  }
}

function secureRandomSource() {
  return () => crypto.randomInt(0, 1_000_000_000) / 1_000_000_000;
}

function hashJson(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
