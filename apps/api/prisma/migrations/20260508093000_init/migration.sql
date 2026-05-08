CREATE TYPE "RoomType" AS ENUM ('PUBLIC', 'PRIVATE', 'PRACTICE');
CREATE TYPE "RoomStatus" AS ENUM ('OPEN', 'COUNTDOWN', 'ACTIVE', 'FINISHED', 'CANCELLED');
CREATE TYPE "MatchStatus" AS ENUM ('ACTIVE', 'FINISHED', 'CANCELLED');
CREATE TYPE "SeatStatus" AS ENUM ('RESERVED', 'ACTIVE', 'FORFEIT');
CREATE TYPE "TransactionType" AS ENUM ('CREDIT', 'DEBIT', 'ENTRY_FEE', 'REFUND', 'WIN_PAYOUT', 'ADMIN_ADJUSTMENT');
CREATE TYPE "PlayerResultStatus" AS ENUM ('WINNER', 'LOST', 'FORFEIT', 'CANCELLED');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "telegramId" BIGINT NOT NULL,
  "username" TEXT,
  "firstName" TEXT,
  "lastName" TEXT,
  "photoUrl" TEXT,
  "isAdmin" BOOLEAN NOT NULL DEFAULT false,
  "isBanned" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Wallet" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "balance" INTEGER NOT NULL DEFAULT 0,
  "locked" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Room" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "type" "RoomType" NOT NULL,
  "status" "RoomStatus" NOT NULL DEFAULT 'OPEN',
  "entryFee" INTEGER NOT NULL,
  "maxSeats" INTEGER NOT NULL DEFAULT 200,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Seat" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "seatNumber" INTEGER NOT NULL,
  "card" JSONB NOT NULL,
  "status" "SeatStatus" NOT NULL DEFAULT 'RESERVED',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Match" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "status" "MatchStatus" NOT NULL DEFAULT 'ACTIVE',
  "serverSeed" TEXT NOT NULL,
  "seedHash" TEXT NOT NULL,
  "seedReveal" TEXT,
  "drawOrder" JSONB NOT NULL,
  "calledNumbers" JSONB NOT NULL,
  "currentIndex" INTEGER NOT NULL DEFAULT 0,
  "prizePool" INTEGER NOT NULL DEFAULT 0,
  "pattern" TEXT NOT NULL DEFAULT 'ROW,COLUMN,DIAGONAL',
  "winnerSeat" INTEGER,
  "winnerUserId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDrawAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlayerResult" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "seatNumber" INTEGER,
  "status" "PlayerResultStatus" NOT NULL,
  "pot" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayerResult_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Transaction" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "TransactionType" NOT NULL,
  "amount" INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "roomId" TEXT,
  "matchId" TEXT,
  "description" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "target" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");
CREATE UNIQUE INDEX "Room_code_key" ON "Room"("code");
CREATE INDEX "Room_status_type_startsAt_idx" ON "Room"("status", "type", "startsAt");
CREATE UNIQUE INDEX "Seat_roomId_seatNumber_key" ON "Seat"("roomId", "seatNumber");
CREATE UNIQUE INDEX "Seat_roomId_userId_key" ON "Seat"("roomId", "userId");
CREATE INDEX "Seat_userId_status_idx" ON "Seat"("userId", "status");
CREATE UNIQUE INDEX "Match_roomId_key" ON "Match"("roomId");
CREATE INDEX "Match_status_startedAt_idx" ON "Match"("status", "startedAt");
CREATE INDEX "Match_winnerUserId_idx" ON "Match"("winnerUserId");
CREATE UNIQUE INDEX "PlayerResult_matchId_userId_key" ON "PlayerResult"("matchId", "userId");
CREATE INDEX "PlayerResult_userId_createdAt_idx" ON "PlayerResult"("userId", "createdAt");
CREATE INDEX "Transaction_userId_createdAt_idx" ON "Transaction"("userId", "createdAt");
CREATE INDEX "Transaction_roomId_idx" ON "Transaction"("roomId");
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_winnerUserId_fkey" FOREIGN KEY ("winnerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlayerResult" ADD CONSTRAINT "PlayerResult_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerResult" ADD CONSTRAINT "PlayerResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

