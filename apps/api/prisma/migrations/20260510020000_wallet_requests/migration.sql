ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'DEPOSIT';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL';

CREATE TYPE "WalletRequestType" AS ENUM ('DEPOSIT', 'WITHDRAW');
CREATE TYPE "WalletRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "WalletRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "WalletRequestType" NOT NULL,
  "status" "WalletRequestStatus" NOT NULL DEFAULT 'PENDING',
  "amount" INTEGER NOT NULL,
  "details" TEXT,
  "adminNote" TEXT,
  "adminId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "WalletRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WalletRequest_userId_createdAt_idx" ON "WalletRequest"("userId", "createdAt");
CREATE INDEX "WalletRequest_status_createdAt_idx" ON "WalletRequest"("status", "createdAt");
CREATE INDEX "WalletRequest_type_status_idx" ON "WalletRequest"("type", "status");

ALTER TABLE "WalletRequest" ADD CONSTRAINT "WalletRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalletRequest" ADD CONSTRAINT "WalletRequest_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
