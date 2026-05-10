ALTER TABLE "WalletRequest" ADD COLUMN "provider" TEXT;
ALTER TABLE "WalletRequest" ADD COLUMN "transactionCode" TEXT;
ALTER TABLE "WalletRequest" ADD COLUMN "transactionTime" TEXT;
ALTER TABLE "WalletRequest" ADD COLUMN "receiptUrl" TEXT;
ALTER TABLE "WalletRequest" ADD COLUMN "validationStatus" TEXT;
ALTER TABLE "WalletRequest" ADD COLUMN "validationReason" TEXT;
ALTER TABLE "WalletRequest" ADD COLUMN "validationPayload" JSONB;

CREATE UNIQUE INDEX "WalletRequest_transactionCode_key" ON "WalletRequest"("transactionCode");
CREATE UNIQUE INDEX "WalletRequest_receiptUrl_key" ON "WalletRequest"("receiptUrl");
CREATE INDEX "WalletRequest_provider_createdAt_idx" ON "WalletRequest"("provider", "createdAt");
