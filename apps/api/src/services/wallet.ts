import type { Prisma, PrismaClient, TransactionType } from "@prisma/client";
import { AppError } from "../errors.js";
import { logAudit, roomTarget, userTarget } from "./audit.js";

type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

const NON_DEPOSIT_CREDIT_CLEAR_DESCRIPTION =
  "Admin cleared non-deposit credits";

type WalletTransactionForClearance = {
  amount: number;
  type: TransactionType | string;
  description: string | null;
  metadata: Prisma.JsonValue | null;
};

export type NonDepositCreditClearance = {
  totalDepositCredits: number;
  totalDebits: number;
  depositBackedAvailable: number;
  removable: number;
};

export function calculateNonDepositCreditClearance(
  balance: number,
  transactions: WalletTransactionForClearance[],
): NonDepositCreditClearance {
  const totalDepositCredits = transactions
    .filter((transaction) => transaction.type === "DEPOSIT")
    .filter((transaction) => transaction.amount > 0)
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const totalDebits = transactions
    .filter((transaction) => transaction.amount < 0)
    .filter((transaction) => !isNonDepositCreditClearance(transaction))
    .reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0);
  const depositBackedAvailable = Math.min(
    balance,
    Math.max(0, totalDepositCredits - totalDebits),
  );

  return {
    totalDepositCredits,
    totalDebits,
    depositBackedAvailable,
    removable: Math.max(0, balance - depositBackedAvailable),
  };
}

export async function clearNonDepositCredits(
  tx: TxClient,
  input: {
    userId: string;
    actorId?: string | null;
    reason?: string | null;
    metadata?: Prisma.InputJsonObject;
  },
) {
  const wallet = await tx.wallet.findUnique({
    where: { userId: input.userId },
  });
  if (!wallet) throw new AppError("Wallet not found", 404);

  const transactions = await tx.transaction.findMany({
    where: { userId: input.userId },
    select: {
      amount: true,
      type: true,
      description: true,
      metadata: true,
    },
  });
  const clearance = calculateNonDepositCreditClearance(
    wallet.balance,
    transactions,
  );

  if (clearance.removable <= 0) {
    return { ...clearance, removed: 0, wallet };
  }

  const updated = await tx.wallet.update({
    where: { userId: input.userId },
    data: { balance: { decrement: clearance.removable } },
  });
  const metadata = {
    reason: input.reason ?? null,
    totalDepositCredits: clearance.totalDepositCredits,
    totalDebits: clearance.totalDebits,
    depositBackedAvailable: clearance.depositBackedAvailable,
    clearedNonDepositCredits: clearance.removable,
    ...(input.metadata ?? {}),
  } as Prisma.InputJsonObject;

  await tx.transaction.create({
    data: {
      userId: input.userId,
      amount: -clearance.removable,
      type: "ADMIN_ADJUSTMENT",
      balanceAfter: updated.balance,
      description: input.reason ?? NON_DEPOSIT_CREDIT_CLEAR_DESCRIPTION,
      metadata,
    },
  });

  await logAudit(tx, {
    actorId: input.actorId ?? undefined,
    action: "NON_DEPOSIT_CREDITS_CLEARED",
    target: userTarget(input.userId),
    metadata: {
      ...metadata,
      balanceAfter: updated.balance,
      lockedAfter: updated.locked,
    },
  });

  return { ...clearance, removed: clearance.removable, wallet: updated };
}

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

function isNonDepositCreditClearance(
  transaction: WalletTransactionForClearance,
): boolean {
  if (transaction.type !== "ADMIN_ADJUSTMENT" || transaction.amount >= 0)
    return false;
  if (transaction.description === NON_DEPOSIT_CREDIT_CLEAR_DESCRIPTION)
    return true;
  return Boolean(
    transaction.metadata &&
    typeof transaction.metadata === "object" &&
    !Array.isArray(transaction.metadata) &&
    "clearedNonDepositCredits" in transaction.metadata,
  );
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
