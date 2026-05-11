CREATE TYPE "BotDepositStep" AS ENUM ('CONTACT', 'AMOUNT', 'RECEIPT');

ALTER TABLE "User" ADD COLUMN "phoneNumber" TEXT;
ALTER TABLE "User" ADD COLUMN "phoneTelegramUserId" BIGINT;
ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");
CREATE INDEX "User_phoneNumber_idx" ON "User"("phoneNumber");

CREATE TABLE "BotDepositSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "step" "BotDepositStep" NOT NULL DEFAULT 'CONTACT',
  "amountCredits" INTEGER,
  "requestedEtb" DECIMAL(12,2),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotDepositSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BotDepositSession_userId_key" ON "BotDepositSession"("userId");
CREATE INDEX "BotDepositSession_step_expiresAt_idx" ON "BotDepositSession"("step", "expiresAt");
CREATE INDEX "BotDepositSession_expiresAt_idx" ON "BotDepositSession"("expiresAt");

ALTER TABLE "BotDepositSession" ADD CONSTRAINT "BotDepositSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
