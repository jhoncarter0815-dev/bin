import { Markup } from "telegraf";
import { env, miniAppUrl } from "../config.js";
import { bot } from "../bot.js";
import { prisma } from "../prisma.js";

export async function announceRoomReady(roomId: string): Promise<void> {
  if (!env.TELEGRAM_ANNOUNCE_CHAT_ID) return;

  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { seats: true },
  });
  if (!room || room.type !== "PUBLIC" || room.seats.length === 0) return;

  const pot = room.seats.length * room.entryFee;
  const seconds = Math.max(
    0,
    Math.ceil((room.startsAt.getTime() - Date.now()) / 1000),
  );
  await sendOnce({
    action: "ANNOUNCEMENT_ROOM_READY",
    target: `room:${room.id}`,
    text: `Next Bingo room ${room.code} is filling now. Pot: ${pot} credits. Players: ${room.seats.length}/${room.maxSeats}. Starts in ${seconds}s.`,
    metadata: { roomId: room.id, code: room.code, pot },
  });
}

export async function announceMatchStarted(matchId: string): Promise<void> {
  if (!env.TELEGRAM_ANNOUNCE_CHAT_ID) return;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { room: { include: { seats: true } } },
  });
  if (!match || match.room.type !== "PUBLIC") return;

  await sendOnce({
    action: "ANNOUNCEMENT_MATCH_STARTED",
    target: `match:${match.id}`,
    text: `Bingo room ${match.room.code} started with ${match.room.seats.length} players. Pot: ${match.prizePool} credits.`,
    metadata: {
      matchId: match.id,
      roomId: match.roomId,
      code: match.room.code,
      prizePool: match.prizePool,
    },
  });
}

export async function announceMatchFinished(matchId: string): Promise<void> {
  if (!env.TELEGRAM_ANNOUNCE_CHAT_ID) return;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      room: true,
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
    },
  });
  if (!match || match.room.type !== "PUBLIC" || match.status !== "FINISHED")
    return;

  const winners = match.results
    .filter((result) => result.status === "WINNER")
    .sort((a, b) => (a.seatNumber ?? 0) - (b.seatNumber ?? 0));
  const winnerText =
    winners.length > 0
      ? winners
          .map(
            (winner) =>
              `Seat ${winner.seatNumber ?? "?"} (${displayName(winner.user)}) won ${winner.pot} credits`,
          )
          .join("; ")
      : "No winner this round.";

  await sendOnce({
    action: "ANNOUNCEMENT_MATCH_FINISHED",
    target: `match:${match.id}`,
    text: `Bingo finished in room ${match.room.code}. ${winnerText}`,
    metadata: {
      matchId: match.id,
      roomId: match.roomId,
      code: match.room.code,
      winnerSeats: winners.map((winner) => winner.seatNumber),
    },
  });
}

async function sendOnce(input: {
  action: string;
  target: string;
  text: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const existing = await prisma.auditLog.findFirst({
    where: { action: input.action, target: input.target },
    select: { id: true },
  });
  if (existing) return;

  try {
    await bot.telegram.sendMessage(
      env.TELEGRAM_ANNOUNCE_CHAT_ID,
      input.text,
      Markup.inlineKeyboard([Markup.button.webApp("Open Bingo", miniAppUrl())]),
    );
    await prisma.auditLog.create({
      data: {
        action: input.action,
        target: input.target,
        metadata: { status: "SENT", ...input.metadata },
      },
    });
  } catch (error) {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        target: input.target,
        metadata: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "unknown",
          ...input.metadata,
        },
      },
    });
  }
}

function displayName(user: {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  return user.username
    ? `@${user.username}`
    : [user.firstName, user.lastName].filter(Boolean).join(" ") || "Player";
}
