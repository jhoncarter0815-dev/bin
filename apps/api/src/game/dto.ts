import type { Prisma } from "@prisma/client";
import type {
  BingoCard,
  MatchDto,
  MatchResultDto,
  PublicUser,
  RoomDto,
  SeatDto,
  TransactionDto,
  WalletDto,
  WinPattern
} from "@bingo/shared";

type SeatWithUser = {
  id: string;
  roomId: string;
  userId: string;
  seatNumber: number;
  card: Prisma.JsonValue;
  user: {
    username: string | null;
  };
};

type RoomWithSeats = {
  id: string;
  code: string;
  type: "PUBLIC" | "PRIVATE" | "PRACTICE";
  status: "OPEN" | "COUNTDOWN" | "ACTIVE" | "FINISHED" | "CANCELLED";
  entryFee: number;
  maxSeats: number;
  startsAt: Date;
  seats: SeatWithUser[];
};

type MatchWithRoom = {
  id: string;
  roomId: string;
  status: "ACTIVE" | "FINISHED" | "CANCELLED";
  seedHash: string;
  seedReveal: string | null;
  drawOrder: Prisma.JsonValue;
  calledNumbers: Prisma.JsonValue;
  currentIndex: number;
  prizePool: number;
  pattern: string;
  winnerSeat: number | null;
  winnerUserId: string | null;
  room: RoomWithSeats;
};

export function toPublicUser(user: {
  id: string;
  telegramId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
}): PublicUser {
  return {
    id: user.id,
    telegramId: user.telegramId.toString(),
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    photoUrl: user.photoUrl
  };
}

export function toWalletDto(wallet: { balance: number; locked: number }): WalletDto {
  return {
    balance: wallet.balance,
    locked: wallet.locked
  };
}

export function toRoomDto(room: RoomWithSeats, userId?: string): RoomDto {
  return {
    id: room.id,
    code: room.code,
    type: room.type,
    status: room.status,
    entryFee: room.entryFee,
    maxSeats: room.maxSeats,
    startsAt: room.startsAt.toISOString(),
    secondsRemaining: Math.max(0, Math.ceil((room.startsAt.getTime() - Date.now()) / 1000)),
    seats: room.seats
      .sort((a, b) => a.seatNumber - b.seatNumber)
      .map((seat): SeatDto => {
        const isMine = seat.userId === userId;
        return {
          id: seat.id,
          roomId: seat.roomId,
          userId: seat.userId,
          seatNumber: seat.seatNumber,
          username: seat.user.username,
          card: isMine ? parseCard(seat.card) : undefined,
          isMine
        };
      })
  };
}

export function toMatchDto(match: MatchWithRoom, userId?: string): MatchDto {
  const calledNumbers = parseNumberArray(match.calledNumbers);
  const drawOrder = parseNumberArray(match.drawOrder);
  const mySeat = match.room.seats.find((seat) => seat.userId === userId);
  return {
    id: match.id,
    roomId: match.roomId,
    roomCode: match.room.code,
    roomType: match.room.type,
    status: match.status,
    calledNumbers,
    currentNumber: calledNumbers.at(-1),
    currentIndex: match.currentIndex,
    totalNumbers: drawOrder.length,
    prizePool: match.prizePool,
    seedHash: match.seedHash,
    seedReveal: match.seedReveal,
    pattern: parsePattern(match.pattern)[0] ?? "ROW",
    mySeat: mySeat?.seatNumber,
    myCard: mySeat ? parseCard(mySeat.card) : undefined,
    winnerSeat: match.winnerSeat,
    winnerUserId: match.winnerUserId
  };
}

export function toResultDto(result: {
  id: string;
  matchId: string;
  status: "WINNER" | "LOST" | "FORFEIT" | "CANCELLED";
  seatNumber: number | null;
  pot: number;
  createdAt: Date;
  match: {
    room: { code: string };
    winnerSeat: number | null;
  };
}): MatchResultDto {
  return {
    id: result.id,
    matchId: result.matchId,
    roomCode: result.match.room.code,
    status: result.status,
    seatNumber: result.seatNumber,
    winnerSeat: result.match.winnerSeat,
    pot: result.pot,
    createdAt: result.createdAt.toISOString()
  };
}

export function toTransactionDto(txn: {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  createdAt: Date;
  description: string | null;
}): TransactionDto {
  return {
    id: txn.id,
    type: txn.type,
    amount: txn.amount,
    balanceAfter: txn.balanceAfter,
    createdAt: txn.createdAt.toISOString(),
    description: txn.description
  };
}

export function parseNumberArray(value: Prisma.JsonValue): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

export function parseCard(value: Prisma.JsonValue): BingoCard {
  return value as unknown as BingoCard;
}

export function parsePattern(pattern: string): WinPattern[] {
  const values = pattern.split(",").map((value) => value.trim()) as WinPattern[];
  return values.filter((value) =>
    ["ROW", "COLUMN", "DIAGONAL", "FOUR_CORNERS", "BLACKOUT"].includes(value)
  );
}

