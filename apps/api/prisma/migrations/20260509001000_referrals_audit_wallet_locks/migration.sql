ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'REFERRAL_BONUS';

ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;

UPDATE "User"
SET "referralCode" = 'TG' || replace("telegramId"::text, '-', 'B')
WHERE "referralCode" IS NULL;

CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

CREATE TABLE "Referral" (
  "id" TEXT NOT NULL,
  "referrerId" TEXT NOT NULL,
  "referredId" TEXT NOT NULL,
  "reward" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Referral_referredId_key" ON "Referral"("referredId");
CREATE INDEX "Referral_referrerId_createdAt_idx" ON "Referral"("referrerId", "createdAt");

ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
