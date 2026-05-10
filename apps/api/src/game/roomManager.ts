import crypto from "node:crypto";
import { Prisma, type Room, type Seat, type User } from "@prisma/client";
import { customAlphabet } from "nanoid";
import { createCard, hasBingo, type MatchmakingStateDto } from "@bingo/shared";
import { env } from "../config.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  AppError,
} from "../errors.js";
import { prisma } from "../prisma.js";
import {
  emitMatch,
  emitRoom,
  emitSpectatorMatch,
  emitUser,
} from "../realtime.js";
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
  toSpectatorMatchDto,
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

export async function joinPublicMatchmaking(
  userId: string,
): Promise<MatchmakingStateDto> {
  const activeMatch = await getActiveMatchForUser(userId);
  if (activeMatch) {
    await prisma.publicQueueEntry.deleteMany({ where: { userId } });
    return withQueueMeta({ mode: "GAME", match: activeMatch });
  }

  const seatedRoom = await getWaitingPublicRoomForUser(userId);
  if (seatedRoom) {
    await prisma.publicQueueEntry.deleteMany({ where: { userId } });
    return withQueueMeta({ mode: "ROOM", room: seatedRoom });
  }

  const assignedRoomId = await assignUserToAvailablePublicRoom(userId);
  if (assignedRoomId) {
    const room = await getRoom(assignedRoomId, userId);
    await broadcastRoom(assignedRoomId, userId);
    void announceRoomReady(assignedRoomId);
    return withQueueMeta({ mode: "ROOM", room });
  }

  await assertCanPayEntryFee(userId);
  await prisma.publicQueueEntry.upsert({
    where: { userId },
    create: { userId },
    update: { updatedAt: new Date() },
  });
  await processPublicQueue();

  return getPublicMatchmakingState(userId);
}

export async function getPublicMatchmakingState(
  userId: string,
): Promise<MatchmakingStateDto> {
  const activeMatch = await getActiveMatchForUser(userId);
  if (activeMatch) return withQueueMeta({ mode: "GAME", match: activeMatch });

  const seatedRoom = await getWaitingPublicRoomForUser(userId);
  if (seatedRoom) return withQueueMeta({ mode: "ROOM", room: seatedRoom });

  const queue = await prisma.publicQueueEntry.findMany({
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  const queueIndex = queue.findIndex((entry) => entry.userId === userId);
  const spectatorMatch = await getPublicSpectatorMatch();

  return {
    mode: spectatorMatch ? "SPECTATE" : "QUEUE",
    spectatorMatch: spectatorMatch ?? undefined,
    queuePosition: queueIndex >= 0 ? queueIndex + 1 : undefined,
    queuedCount: queue.length,
    minPlayers: publicMinPlayers(),
    maxSeats: publicMaxSeats(),
  };
}

export async function getPublicSpectatorMatch() {
  const activeMatch = await prisma.match.findFirst({
    where: {
      status: "ACTIVE",
      room: { type: "PUBLIC" },
    },
    orderBy: { startedAt: "desc" },
    include: matchInclude,
  });
  if (activeMatch) return toSpectatorMatchDto(activeMatch);

  const match = await prisma.match.findFirst({
    where: {
      status: "FINISHED",
      finishedAt: { gte: new Date(Date.now() - 30_000) },
      room: { type: "PUBLIC" },
    },
    orderBy: { finishedAt: "desc" },
    include: matchInclude,
  });
  return match ? toSpectatorMatchDto(match) : null;
}

export async function processPublicQueue() {
  if (await isMatchmakingPaused()) {
    return { roomsCreated: 0, queuedAssigned: 0, paused: true };
  }

  const createdRooms: Array<{ roomId: string; userIds: string[] }> = [];

  while (true) {
    const created = await createPublicRoomFromQueue();
    if (!created) break;
    createdRooms.push(created);
  }

  for (const room of createdRooms) {
    await notifyRoomAssigned(room.roomId, room.userIds);
  }

  if (createdRooms.length > 0) await emitQueueStates();

  return {
    roomsCreated: createdRooms.length,
    queuedAssigned: createdRooms.reduce(
      (total, room) => total + room.userIds.length,
      0,
    ),
    paused: false,
  };
}

export async function forceCreatePublicRoomFromQueue() {
  if (await isMatchmakingPaused()) {
    throw new AppError("Matchmaking is paused");
  }

  const created = await createPublicRoomFromQueue({ force: true });
  if (!created) return { roomsCreated: 0, queuedAssigned: 0 };

  await notifyRoomAssigned(created.roomId, created.userIds);
  await emitQueueStates();
  return { roomsCreated: 1, queuedAssigned: created.userIds.length };
}

export async function forceStartPublicRoom(roomCode: string) {
  const room = await prisma.room.findUnique({
    where: { code: normalizeRoomCode(roomCode) },
    include: { seats: true },
  });
  if (!room) throw new NotFoundError("Room not found");
  if (room.type !== "PUBLIC") throw new AppError("Only public rooms can start");
  if (!["OPEN", "COUNTDOWN"].includes(room.status)) {
    throw new ConflictError("Room is not waiting for players");
  }
  if (room.seats.length === 0) throw new AppError("Room has no players");

  await startRoom(room);
  return getRoom(room.id);
}

export async function requeuePublicRoom(roomCode: string) {
  const room = await prisma.room.findUnique({
    where: { code: normalizeRoomCode(roomCode) },
    include: { seats: true },
  });
  if (!room) throw new NotFoundError("Room not found");
  if (room.type !== "PUBLIC")
    throw new AppError("Only public rooms can requeue");
  if (!["OPEN", "COUNTDOWN"].includes(room.status)) {
    throw new ConflictError("Only waiting rooms can be requeued");
  }

  await dissolvePublicRoomToQueue(room.id);
  return { queued: room.seats.length };
}

export async function removeUserFromPublicQueue(userId: string) {
  const deleted = await prisma.publicQueueEntry.deleteMany({
    where: { userId },
  });
  await emitQueueStates();
  return { removed: deleted.count };
}

export async function setMatchmakingPaused(paused: boolean, actorId?: string) {
  await logAudit(prisma, {
    actorId,
    action: "MATCHMAKING_STATUS",
    target: "matchmaking:public",
    metadata: { paused },
  });
  await emitQueueStates();
  return { paused };
}

export async function isMatchmakingPaused(): Promise<boolean> {
  const latest = await prisma.auditLog.findFirst({
    where: { action: "MATCHMAKING_STATUS", target: "matchmaking:public" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  return metadataFlag(latest?.metadata, "paused");
}

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
      maxSeats: publicMaxSeats(),
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

async function getWaitingPublicRoomForUser(userId: string) {
  const room = await prisma.room.findFirst({
    where: {
      type: "PUBLIC",
      status: { in: ["OPEN", "COUNTDOWN"] },
      seats: { some: { userId } },
    },
    orderBy: { startsAt: "asc" },
    include: roomInclude,
  });
  return room ? toRoomDto(room, userId) : null;
}

async function assignUserToAvailablePublicRoom(
  userId: string,
): Promise<string | null> {
  return prisma.$transaction(
    async (tx) => {
      const room = await tx.room.findFirst({
        where: {
          type: "PUBLIC",
          status: { in: ["OPEN", "COUNTDOWN"] },
        },
        orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
        include: { seats: true },
      });
      if (!room || room.seats.length >= room.maxSeats) return null;

      const existingSeat = room.seats.find((seat) => seat.userId === userId);
      if (existingSeat) {
        await tx.publicQueueEntry.deleteMany({ where: { userId } });
        return room.id;
      }

      const seatNumber = firstAvailableSeat(room.maxSeats, room.seats);
      await reservePublicSeat(tx, {
        roomId: room.id,
        roomCode: room.code,
        entryFee: room.entryFee,
        userId,
        seatNumber,
      });
      await tx.publicQueueEntry.deleteMany({ where: { userId } });

      if (
        room.status === "OPEN" &&
        room.seats.length + 1 >= publicMinPlayers()
      ) {
        await tx.room.update({
          where: { id: room.id },
          data: {
            status: "COUNTDOWN",
            startsAt: new Date(Date.now() + env.PUBLIC_ROOM_SECONDS * 1000),
          },
        });
      }

      return room.id;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function createPublicRoomFromQueue(
  options: { force?: boolean } = {},
): Promise<{
  roomId: string;
  userIds: string[];
} | null> {
  const minPlayers = publicMinPlayers();
  const maxSeats = publicMaxSeats();

  return prisma.$transaction(
    async (tx) => {
      const queued = await tx.publicQueueEntry.findMany({
        orderBy: { createdAt: "asc" },
        take: maxSeats,
        include: { user: { include: { wallet: true } } },
      });

      const ineligible = queued.filter(
        (entry) => (entry.user.wallet?.balance ?? 0) < env.PUBLIC_ENTRY_FEE,
      );
      if (ineligible.length > 0) {
        await tx.publicQueueEntry.deleteMany({
          where: { userId: { in: ineligible.map((entry) => entry.userId) } },
        });
      }

      const players = queued
        .filter(
          (entry) => (entry.user.wallet?.balance ?? 0) >= env.PUBLIC_ENTRY_FEE,
        )
        .slice(0, maxSeats);

      if (players.length < (options.force ? 1 : minPlayers)) return null;

      const room = await tx.room.create({
        data: {
          code: makeCode(),
          type: "PUBLIC",
          status: "COUNTDOWN",
          entryFee: env.PUBLIC_ENTRY_FEE,
          maxSeats,
          startsAt: new Date(Date.now() + env.PUBLIC_ROOM_SECONDS * 1000),
        },
      });

      for (const [index, entry] of players.entries()) {
        await reservePublicSeat(tx, {
          roomId: room.id,
          roomCode: room.code,
          entryFee: room.entryFee,
          userId: entry.userId,
          seatNumber: index + 1,
        });
      }

      const userIds = players.map((entry) => entry.userId);
      await tx.publicQueueEntry.deleteMany({
        where: { userId: { in: userIds } },
      });

      await logAudit(tx, {
        action: "ROOM_CREATED",
        target: roomTarget(room.id),
        metadata: {
          code: room.code,
          type: room.type,
          entryFee: room.entryFee,
          maxSeats: room.maxSeats,
          startsAt: room.startsAt.toISOString(),
          queuedPlayers: userIds.length,
        },
      });

      return { roomId: room.id, userIds };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function dissolvePublicRoomToQueue(roomId: string): Promise<void> {
  const result = await prisma.$transaction(
    async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
        include: { seats: true },
      });
      if (
        !room ||
        room.type !== "PUBLIC" ||
        !["OPEN", "COUNTDOWN"].includes(room.status)
      ) {
        return null;
      }

      const userIds = room.seats.map((seat) => seat.userId);
      for (const seat of room.seats) {
        if (room.entryFee > 0) {
          await refundEntryFee(tx, {
            userId: seat.userId,
            amount: room.entryFee,
            roomId,
            description: `Queue refund for room ${room.code}`,
          });
        }
        await tx.publicQueueEntry.upsert({
          where: { userId: seat.userId },
          create: { userId: seat.userId },
          update: { updatedAt: new Date() },
        });
      }

      await tx.seat.deleteMany({ where: { roomId } });
      await tx.room.update({
        where: { id: roomId },
        data: { status: "CANCELLED" },
      });
      await logAudit(tx, {
        action: "ROOM_REQUEUED",
        target: roomTarget(roomId),
        metadata: {
          code: room.code,
          queuedPlayers: userIds.length,
          reason: "below_minimum_players",
        },
      });
      return { userIds };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  await broadcastRoom(roomId);
  if (result) {
    await processPublicQueue();
    await emitQueueStates();
  }
}

async function reservePublicSeat(
  tx: Prisma.TransactionClient,
  input: {
    roomId: string;
    roomCode: string;
    entryFee: number;
    userId: string;
    seatNumber: number;
  },
): Promise<void> {
  if (input.entryFee > 0) {
    await lockEntryFee(tx, {
      userId: input.userId,
      amount: input.entryFee,
      roomId: input.roomId,
      description: `Entry fee locked for room ${input.roomCode}`,
      metadata: { seatNumber: input.seatNumber },
    });
  }

  const card = createCard(secureRandomSource());
  await tx.seat.create({
    data: {
      roomId: input.roomId,
      userId: input.userId,
      seatNumber: input.seatNumber,
      card: card as unknown as Prisma.InputJsonValue,
    },
  });

  await logAudit(tx, {
    actorId: input.userId,
    action: "SEAT_JOINED",
    target: roomTarget(input.roomId),
    metadata: {
      seatNumber: input.seatNumber,
      entryFee: input.entryFee,
      cardHash: hashJson(card),
    },
  });
}

async function assertCanPayEntryFee(userId: string): Promise<void> {
  if (env.PUBLIC_ENTRY_FEE <= 0) return;
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new AppError("Wallet not found", 404);
  if (wallet.balance < env.PUBLIC_ENTRY_FEE) {
    throw new AppError("Insufficient balance for public room entry", 402);
  }
}

async function notifyRoomAssigned(
  roomId: string,
  userIds: string[],
): Promise<void> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: roomInclude,
  });
  if (!room) return;

  emitRoom(roomId, toRoomDto(room));
  for (const userId of userIds) {
    emitUser(userId, "room:state", toRoomDto(room, userId));
    emitUser(userId, "queue:state", await getPublicMatchmakingState(userId));
  }
  void announceRoomReady(roomId);
}

async function emitQueueStates(): Promise<void> {
  const queued = await prisma.publicQueueEntry.findMany({
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  for (const entry of queued) {
    emitUser(
      entry.userId,
      "queue:state",
      await getPublicMatchmakingState(entry.userId),
    );
  }
}

async function withQueueMeta(
  state: Omit<MatchmakingStateDto, "queuedCount" | "minPlayers" | "maxSeats">,
): Promise<MatchmakingStateDto> {
  const queuedCount = await prisma.publicQueueEntry.count();
  return {
    ...state,
    queuedCount,
    minPlayers: publicMinPlayers(),
    maxSeats: publicMaxSeats(),
  };
}

function publicMinPlayers(): number {
  return Math.max(1, Math.min(env.PUBLIC_ROOM_MIN_PLAYERS, publicMaxSeats()));
}

function publicMaxSeats(): number {
  return Math.max(1, env.PUBLIC_ROOM_MAX_SEATS);
}

function firstAvailableSeat(
  maxSeats: number,
  seats: Array<{ seatNumber: number }>,
): number {
  const occupied = new Set(seats.map((seat) => seat.seatNumber));
  for (let seatNumber = 1; seatNumber <= maxSeats; seatNumber += 1) {
    if (!occupied.has(seatNumber)) return seatNumber;
  }
  throw new AppError("Room is full");
}

function normalizeRoomCode(roomCode: string): string {
  return roomCode.trim().toUpperCase();
}

function metadataFlag(metadata: Prisma.JsonValue | undefined, key: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  return metadata[key] === true;
}

export async function joinSeat(
  roomId: string,
  userId: string,
  seatNumber: number,
) {
  if (!Number.isInteger(seatNumber) || seatNumber < 1) {
    throw new AppError("Seat must be a positive number");
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

      if (
        room.status === "OPEN" &&
        room.seats.length + 1 >= publicMinPlayers()
      ) {
        await tx.room.update({
          where: { id: roomId },
          data: {
            status: "COUNTDOWN",
            startsAt: new Date(Date.now() + env.PUBLIC_ROOM_SECONDS * 1000),
          },
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

  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { seats: true },
  });
  if (
    room?.type === "PUBLIC" &&
    ["OPEN", "COUNTDOWN"].includes(room.status) &&
    room.seats.length < publicMinPlayers()
  ) {
    await dissolvePublicRoomToQueue(roomId);
    return;
  }

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
  const matchmaking = await processPublicQueue();
  const started = await startDueRooms();
  const drawn = await drawDueMatches();
  return { ...matchmaking, started, drawn };
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
    if (room.type === "PUBLIC" && room.seats.length < publicMinPlayers()) {
      await dissolvePublicRoomToQueue(room.id);
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
  emitSpectatorMatch(matchId, toSpectatorMatchDto(match));
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
