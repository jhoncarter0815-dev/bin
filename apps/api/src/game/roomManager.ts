import crypto from "node:crypto";
import { Prisma, type Room, type Seat, type User } from "@prisma/client";
import { customAlphabet } from "nanoid";
import { createCard, hasBingo } from "@bingo/shared";
import { env } from "../config.js";
import { ConflictError, ForbiddenError, NotFoundError, AppError } from "../errors.js";
import { prisma } from "../prisma.js";
import { emitMatch, emitRoom, emitUser } from "../realtime.js";
import { creditWallet, debitWallet } from "../services/wallet.js";
import { toMatchDto, toResultDto, toRoomDto, parseCard, parseNumberArray, parsePattern } from "./dto.js";
import { createFairSeed, randomFromSeed } from "./fairness.js";

const makeCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 7);

const roomInclude = {
  seats: {
    include: {
      user: {
        select: {
          username: true
        }
      }
    }
  }
} satisfies Prisma.RoomInclude;

const matchInclude = {
  room: {
    include: roomInclude
  }
} satisfies Prisma.MatchInclude;

export async function getOrCreatePublicRoom(userId?: string) {
  const existing = await prisma.room.findFirst({
    where: {
      type: "PUBLIC",
      status: { in: ["OPEN", "COUNTDOWN"] }
    },
    orderBy: { startsAt: "asc" },
    include: roomInclude
  });

  if (existing && existing.seats.length < existing.maxSeats) return toRoomDto(existing, userId);

  const room = await prisma.room.create({
    data: {
      code: makeCode(),
      type: "PUBLIC",
      status: "COUNTDOWN",
      entryFee: env.PUBLIC_ENTRY_FEE,
      maxSeats: 200,
      startsAt: new Date(Date.now() + env.PUBLIC_ROOM_SECONDS * 1000)
    },
    include: roomInclude
  });

  return toRoomDto(room, userId);
}

export async function getRoom(roomId: string, userId?: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: roomInclude
  });
  if (!room) throw new NotFoundError("Room not found");
  return toRoomDto(room, userId);
}

export async function joinSeat(roomId: string, userId: string, seatNumber: number) {
  if (!Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > 200) {
    throw new AppError("Seat must be between 1 and 200");
  }

  await prisma.$transaction(
    async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
        include: { seats: true }
      });
      if (!room) throw new NotFoundError("Room not found");
      if (!["OPEN", "COUNTDOWN"].includes(room.status)) throw new ConflictError("Room already started");
      if (seatNumber > room.maxSeats) throw new AppError("Seat is outside room capacity");

      const existingForUser = room.seats.find((seat) => seat.userId === userId);
      if (existingForUser) {
        if (existingForUser.seatNumber === seatNumber) return;
        throw new ConflictError(`You already hold seat #${existingForUser.seatNumber}`);
      }

      if (room.seats.some((seat) => seat.seatNumber === seatNumber)) {
        throw new ConflictError("Seat is already taken");
      }

      if (room.entryFee > 0) {
        await debitWallet(tx, {
          userId,
          amount: room.entryFee,
          type: "ENTRY_FEE",
          roomId,
          description: `Entry fee for room ${room.code}`
        });
      }

      const card = createCard(secureRandomSource());
      await tx.seat.create({
        data: {
          roomId,
          userId,
          seatNumber,
          card: card as unknown as Prisma.InputJsonValue
        }
      });

      if (room.status === "OPEN") {
        await tx.room.update({
          where: { id: roomId },
          data: { status: "COUNTDOWN" }
        });
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  await broadcastRoom(roomId, userId);
  return getRoom(roomId, userId);
}

export async function leaveRoom(roomId: string, userId: string) {
  await prisma.$transaction(
    async (tx) => {
      const seat = await tx.seat.findUnique({
        where: { roomId_userId: { roomId, userId } },
        include: { room: true }
      });
      if (!seat) return;
      if (!["OPEN", "COUNTDOWN"].includes(seat.room.status)) {
        throw new ConflictError("Use forfeit to leave an active match");
      }

      await tx.seat.delete({ where: { id: seat.id } });
      if (seat.room.entryFee > 0) {
        await creditWallet(tx, {
          userId,
          amount: seat.room.entryFee,
          type: "REFUND",
          roomId,
          description: `Refund for leaving room ${seat.room.code}`
        });
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
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
        startsAt: new Date()
      }
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
          card: createCard(randomFromSeed(`${fair.seed}:card:${player.id}:${seatNumber}`)) as unknown as Prisma.InputJsonValue
        }
      });
    }

    return tx.match.create({
      data: {
        roomId: room.id,
        serverSeed: fair.seed,
        seedHash: fair.seedHash,
        drawOrder: fair.drawOrder as Prisma.InputJsonValue,
        calledNumbers: [],
        prizePool: 0
      },
      include: matchInclude
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
          some: { userId }
        }
      }
    },
    orderBy: { startedAt: "desc" },
    include: matchInclude
  });
  return match ? toMatchDto(match, userId) : null;
}

export async function claimBingo(matchId: string, userId: string) {
  const result = await prisma.$transaction(
    async (tx) => {
      const match = await tx.match.findUnique({
        where: { id: matchId },
        include: {
          room: {
            include: {
              seats: {
                include: { user: { select: { username: true } } }
              }
            }
          }
        }
      });
      if (!match) throw new NotFoundError("Match not found");
      if (match.status !== "ACTIVE") throw new ConflictError("Match is already finished");

      const seat = match.room.seats.find((item) => item.userId === userId);
      if (!seat) throw new ForbiddenError("You are not seated in this match");
      if (seat.status === "FORFEIT") throw new ForbiddenError("Forfeited seats cannot claim bingo");

      const card = parseCard(seat.card);
      const calledNumbers = parseNumberArray(match.calledNumbers);
      if (!hasBingo(card, calledNumbers, parsePattern(match.pattern))) {
        throw new AppError("That card does not have bingo yet", 422, "INVALID_BINGO");
      }

      await tx.match.update({
        where: { id: match.id },
        data: {
          status: "FINISHED",
          winnerSeat: seat.seatNumber,
          winnerUserId: userId,
          seedReveal: match.serverSeed,
          finishedAt: new Date()
        }
      });

      await tx.room.update({
        where: { id: match.roomId },
        data: { status: "FINISHED" }
      });

      await tx.playerResult.createMany({
        data: match.room.seats.map((item) => ({
          matchId: match.id,
          userId: item.userId,
          seatNumber: item.seatNumber,
          status: item.userId === userId ? "WINNER" : item.status === "FORFEIT" ? "FORFEIT" : "LOST",
          pot: item.userId === userId ? match.prizePool : 0
        })),
        skipDuplicates: true
      });

      if (match.prizePool > 0) {
        await creditWallet(tx, {
          userId,
          amount: match.prizePool,
          type: "WIN_PAYOUT",
          roomId: match.roomId,
          matchId: match.id,
          description: `Bingo payout for room ${match.room.code}`
        });
      }

      return tx.match.findUniqueOrThrow({
        where: { id: match.id },
        include: matchInclude
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  await broadcastMatch(result.id);
  await broadcastRoom(result.roomId);
  return toMatchDto(result, userId);
}

export async function forfeitActiveMatch(matchId: string, userId: string) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: matchInclude
  });
  if (!match) throw new NotFoundError("Match not found");
  const seat = match.room.seats.find((item) => item.userId === userId);
  if (!seat) return;

  await prisma.seat.update({
    where: { id: seat.id },
    data: { status: "FORFEIT" }
  });

  await prisma.playerResult.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: {
      matchId,
      userId,
      seatNumber: seat.seatNumber,
      status: "FORFEIT",
      pot: 0
    },
    update: { status: "FORFEIT" }
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
      startsAt: { lte: new Date() }
    },
    include: { seats: true },
    take: 25
  });

  let started = 0;
  for (const room of dueRooms) {
    if (room.type === "PUBLIC" && room.seats.length < env.MIN_PLAYERS_TO_START) {
      await prisma.room.update({
        where: { id: room.id },
        data: {
          status: "COUNTDOWN",
          startsAt: new Date(Date.now() + env.PUBLIC_ROOM_SECONDS * 1000)
        }
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
      lastDrawAt: { lte: new Date(Date.now() - env.DRAW_INTERVAL_MS) }
    },
    include: matchInclude,
    take: 50
  });

  let drawn = 0;
  for (const match of matches) {
    const drawOrder = parseNumberArray(match.drawOrder);
    const calledNumbers = parseNumberArray(match.calledNumbers);

    if (match.currentIndex >= drawOrder.length) {
      await finishWithoutWinner(match.id);
      continue;
    }

    const nextNumber = drawOrder[match.currentIndex]!;
    await prisma.match.update({
      where: { id: match.id },
      data: {
        calledNumbers: [...calledNumbers, nextNumber],
        currentIndex: { increment: 1 },
        lastDrawAt: new Date()
      }
    });
    await broadcastMatch(match.id);
    drawn += 1;
  }
  return drawn;
}

export async function getHistory(userId: string) {
  const results = await prisma.playerResult.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      match: {
        include: {
          room: { select: { code: true } }
        }
      }
    }
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
      winnerSeat: true
    }
  });
  if (!match) throw new NotFoundError("Match not found");
  return {
    matchId: match.id,
    seedHash: match.seedHash,
    seedReveal: match.seedReveal,
    drawOrder: parseNumberArray(match.drawOrder),
    calledNumbers: parseNumberArray(match.calledNumbers),
    winnerSeat: match.winnerSeat
  };
}

async function startRoom(room: Room & { seats: Seat[] }) {
  const fair = createFairSeed(room.id);
  const match = await prisma.$transaction(
    async (tx) => {
      const activeRoom = await tx.room.findUnique({
        where: { id: room.id },
        include: { seats: true }
      });
      if (!activeRoom || activeRoom.status === "ACTIVE") return null;

      await tx.seat.updateMany({
        where: { roomId: room.id },
        data: { status: "ACTIVE" }
      });
      await tx.room.update({
        where: { id: room.id },
        data: { status: "ACTIVE" }
      });

      return tx.match.create({
        data: {
          roomId: room.id,
          serverSeed: fair.seed,
          seedHash: fair.seedHash,
          drawOrder: fair.drawOrder as Prisma.InputJsonValue,
          calledNumbers: [],
          prizePool: activeRoom.seats.length * room.entryFee
        },
        include: matchInclude
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  if (match) {
    await broadcastRoom(room.id);
    await broadcastMatch(match.id);
  }
}

async function finishWithoutWinner(matchId: string) {
  const existing = await prisma.match.findUnique({
    where: { id: matchId },
    select: { serverSeed: true }
  });
  if (!existing) return;

  const match = await prisma.match.update({
    where: { id: matchId },
    data: {
      status: "FINISHED",
      seedReveal: existing.serverSeed,
      finishedAt: new Date()
    },
    include: matchInclude
  });

  await prisma.room.update({
    where: { id: match.roomId },
    data: { status: "FINISHED" }
  });

  await prisma.playerResult.createMany({
    data: match.room.seats.map((seat) => ({
      matchId,
      userId: seat.userId,
      seatNumber: seat.seatNumber,
      status: seat.status === "FORFEIT" ? "FORFEIT" : "LOST",
      pot: 0
    })),
    skipDuplicates: true
  });

  await broadcastMatch(matchId);
  await broadcastRoom(match.roomId);
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
        wallet: { create: { balance: 0 } }
      },
      update: {}
    });
    bots.push(bot);
  }

  return bots;
}

async function broadcastRoom(roomId: string, userId?: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: roomInclude
  });
  if (!room) return;
  emitRoom(roomId, toRoomDto(room));
  if (userId) emitUser(userId, "room:state", toRoomDto(room, userId));
}

async function broadcastMatch(matchId: string) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: matchInclude
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
