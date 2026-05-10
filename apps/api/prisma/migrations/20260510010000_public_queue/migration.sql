CREATE TABLE "PublicQueueEntry" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublicQueueEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PublicQueueEntry_userId_key" ON "PublicQueueEntry"("userId");
CREATE INDEX "PublicQueueEntry_createdAt_idx" ON "PublicQueueEntry"("createdAt");

ALTER TABLE "PublicQueueEntry"
  ADD CONSTRAINT "PublicQueueEntry_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
