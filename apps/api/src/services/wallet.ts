import type { Prisma, PrismaClient, TransactionType } from "@prisma/client";
import { AppError } from "../errors.js";
import { logAudit, roomTarget, userTarget } from "./audit.js";

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
  },
) {
  if (input.amount < 0) throw new AppError("Amount must be positive");
  const wallet = await tx.wallet.findUnique({
    where: { userId: input.userId },
  });
  if (!wallet) throw new AppError("Wallet not found", 404);
  if (wallet.balance < input.amount)
    throw new AppError("Insufficient credits", 402, "INSUFFICIENT_CREDITS");

  const updated = await tx.wallet.update({
    where: { userId: input.userId },
    data: { balance: { decrement: input.amount } },
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
      metadata: input.metadata,
    },
  });

  await logAudit(tx, {
    actorId: input.userId,
    action: "WALLET_DEBIT",
    target: userTarget(input.userId),
    metadata: {
      amount: input.amount,
      type: input.type,
      balanceAfter: updated.balance,
      lockedAfter: updated.locked,
      roomId: input.roomId,
      matchId: input.matchId,
    },
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
  },
) {
  if (input.amount < 0) throw new AppError("Amount must be positive");
  const updated = await tx.wallet.update({
    where: { userId: input.userId },
    data: { balance: { increment: input.amount } },
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
      metadata: input.metadata,
    },
  });

  await logAudit(tx, {
    actorId: input.userId,
    action: "WALLET_CREDIT",
    target: userTarget(input.userId),
    metadata: {
      amount: input.amount,
      type: input.type,
      balanceAfter: updated.balance,
      lockedAfter: updated.locked,
      roomId: input.roomId,
      matchId: input.matchId,
    },
  });

  return updated;
}

export async function lockEntryFee(
  tx: TxClient,
  input: {
    userId: string;
    amount: number;
    roomId: string;
    description?: string;
    metadata?: Prisma.InputJsonValue;
  },
) {
  if (input.amount < 0) throw new AppError("Amount must be positive");
  if (input.amount === 0)
    return tx.wallet.findUniqueOrThrow({ where: { userId: input.userId } });

  const wallet = await tx.wallet.findUnique({
    where: { userId: input.userId },
  });
  if (!wallet) throw new AppError("Wallet not found", 404);
  if (wallet.balance < input.amount)
    throw new AppError("Insufficient credits", 402, "INSUFFICIENT_CREDITS");

  const updated = await tx.wallet.update({
    where: { userId: input.userId },
    data: {
      balance: { decrement: input.amount },
      locked: { increment: input.amount },
    },
  });

  await tx.transaction.create({
    data: {
      userId: input.userId,
      amount: -input.amount,
      type: "ENTRY_FEE",
      balanceAfter: updated.balance,
      roomId: input.roomId,
      description: input.description,
      metadata:
        input.metadata === undefined
          ? { status: "LOCKED" }
          : { status: "LOCKED", detail: input.metadata },
    },
  });

  await logAudit(tx, {
    actorId: input.userId,
    action: "ENTRY_FEE_LOCKED",
    target: roomTarget(input.roomId),
    metadata: {
      amount: input.amount,
      balanceAfter: updated.balance,
      lockedAfter: updated.locked,
    },
  });

  return updated;
}

export async function refundEntryFee(
  tx: TxClient,
  input: {
    userId: string;
    amount: number;
    roomId: string;
    description?: string;
  },
) {
  if (input.amount < 0) throw new AppError("Amount must be positive");
  if (input.amount === 0)
    return tx.wallet.findUniqueOrThrow({ where: { userId: input.userId } });

  const wallet = await tx.wallet.findUnique({
    where: { userId: input.userId },
  });
  if (!wallet) throw new AppError("Wallet not found", 404);

  const lockedRefund = Math.min(wallet.locked, input.amount);
  const updated =
    lockedRefund > 0
      ? await tx.wallet.update({
          where: { userId: input.userId },
          data: {
            balance: { increment: lockedRefund },
            locked: { decrement: lockedRefund },
          },
        })
      : wallet;

  if (lockedRefund < input.amount) {
    return creditWallet(tx, {
      userId: input.userId,
      amount: input.amount - lockedRefund,
      type: "REFUND",
      roomId: input.roomId,
      description: input.description,
      metadata: { status: "LEGACY_DIRECT_REFUND" },
    });
  }

  await tx.transaction.create({
    data: {
      userId: input.userId,
      amount: input.amount,
      type: "REFUND",
      balanceAfter: updated.balance,
      roomId: input.roomId,
      description: input.description,
      metadata: { status: "LOCK_RELEASED" },
    },
  });

  await logAudit(tx, {
    actorId: input.userId,
    action: "ENTRY_FEE_REFUNDED",
    target: roomTarget(input.roomId),
    metadata: {
      amount: input.amount,
      balanceAfter: updated.balance,
      lockedAfter: updated.locked,
    },
  });

  return updated;
}

export async function captureEntryFee(
  tx: TxClient,
  input: {
    userId: string;
    amount: number;
    roomId: string;
  },
) {
  if (input.amount < 0) throw new AppError("Amount must be positive");
  if (input.amount === 0)
    return tx.wallet.findUniqueOrThrow({ where: { userId: input.userId } });

  const wallet = await tx.wallet.findUnique({
    where: { userId: input.userId },
  });
  if (!wallet) throw new AppError("Wallet not found", 404);

  const lockedCapture = Math.min(wallet.locked, input.amount);
  let updated = wallet;
  if (lockedCapture > 0) {
    updated = await tx.wallet.update({
      where: { userId: input.userId },
      data: { locked: { decrement: lockedCapture } },
    });
  }

  const priorEntry = await tx.transaction.findFirst({
    where: {
      userId: input.userId,
      roomId: input.roomId,
      type: "ENTRY_FEE",
    },
  });

  if (!priorEntry && lockedCapture < input.amount) {
    updated = await debitWallet(tx, {
      userId: input.userId,
      amount: input.amount - lockedCapture,
      type: "ENTRY_FEE",
      roomId: input.roomId,
      description: "Entry fee captured at match start",
      metadata: { status: "CAPTURED_WITHOUT_LOCK" },
    });
  }

  await logAudit(tx, {
    actorId: input.userId,
    action: "ENTRY_FEE_CAPTURED",
    target: roomTarget(input.roomId),
    metadata: {
      amount: input.amount,
      lockedCaptured: lockedCapture,
      balanceAfter: updated.balance,
      lockedAfter: updated.locked,
    },
  });

  return updated;
}
