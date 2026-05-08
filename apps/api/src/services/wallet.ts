import type { Prisma, PrismaClient, TransactionType } from "@prisma/client";
import { AppError } from "../errors.js";

type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export async function debitWallet(
  tx: TxClient,
  input: {
    userId: string;
    amount: number;
    type: TransactionType;
    roomId?: string;
    matchId?: string;
    description?: string;
    metadata?: Prisma.InputJsonValue;
  }
) {
  if (input.amount < 0) throw new AppError("Amount must be positive");
  const wallet = await tx.wallet.findUnique({ where: { userId: input.userId } });
  if (!wallet) throw new AppError("Wallet not found", 404);
  if (wallet.balance < input.amount) throw new AppError("Insufficient credits", 402, "INSUFFICIENT_CREDITS");

  const updated = await tx.wallet.update({
    where: { userId: input.userId },
    data: { balance: { decrement: input.amount } }
  });

  await tx.transaction.create({
    data: {
      userId: input.userId,
      amount: -input.amount,
      type: input.type,
      balanceAfter: updated.balance,
      roomId: input.roomId,
      matchId: input.matchId,
      description: input.description,
      metadata: input.metadata
    }
  });

  return updated;
}

export async function creditWallet(
  tx: TxClient,
  input: {
    userId: string;
    amount: number;
    type: TransactionType;
    roomId?: string;
    matchId?: string;
    description?: string;
    metadata?: Prisma.InputJsonValue;
  }
) {
  if (input.amount < 0) throw new AppError("Amount must be positive");
  const updated = await tx.wallet.update({
    where: { userId: input.userId },
    data: { balance: { increment: input.amount } }
  });

  await tx.transaction.create({
    data: {
      userId: input.userId,
      amount: input.amount,
      type: input.type,
      balanceAfter: updated.balance,
      roomId: input.roomId,
      matchId: input.matchId,
      description: input.description,
      metadata: input.metadata
    }
  });

  return updated;
}

