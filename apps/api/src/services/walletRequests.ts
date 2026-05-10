import type {
  Prisma,
  PrismaClient,
  WalletRequestStatus,
  WalletRequestType,
} from "@prisma/client";
import { AppError, ConflictError, NotFoundError } from "../errors.js";
import { prisma } from "../prisma.js";
import { logAudit } from "./audit.js";
import { creditWallet, debitWallet } from "./wallet.js";

type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export const WALLET_REQUEST_PAGE_SIZE = 25;

export async function createWalletRequest(input: {
  userId: string;
  type: WalletRequestType;
  amount: number;
  details?: string | null;
}) {
  assertWalletAmount(input.amount);

  if (input.type === "WITHDRAW") {
    await assertWithdrawCapacity(input.userId, input.amount);
  }

  return prisma.$transaction(async (tx) => {
    const request = await tx.walletRequest.create({
      data: {
        userId: input.userId,
        type: input.type,
        amount: input.amount,
        details: cleanText(input.details),
      },
    });

    await logAudit(tx, {
      actorId: input.userId,
      action: "WALLET_REQUEST_CREATED",
      target: walletRequestTarget(request.id),
      metadata: {
        type: request.type,
        amount: request.amount,
      },
    });

    return request;
  });
}

export function listWalletRequests(userId: string) {
  return prisma.walletRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: WALLET_REQUEST_PAGE_SIZE,
  });
}

export function listPendingWalletRequests() {
  return prisma.walletRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: WALLET_REQUEST_PAGE_SIZE,
    include: {
      user: {
        select: {
          id: true,
          telegramId: true,
          username: true,
          firstName: true,
          lastName: true,
          wallet: true,
        },
      },
    },
  });
}

export async function cancelWalletRequest(input: {
  requestId: string;
  userId: string;
}) {
  const request = await prisma.walletRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request || request.userId !== input.userId)
    throw new NotFoundError("Wallet request not found");
  if (request.status !== "PENDING")
    throw new ConflictError("Only pending requests can be cancelled");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.walletRequest.update({
      where: { id: request.id },
      data: {
        status: "CANCELLED",
        resolvedAt: new Date(),
      },
    });

    await logAudit(tx, {
      actorId: input.userId,
      action: "WALLET_REQUEST_CANCELLED",
      target: walletRequestTarget(request.id),
      metadata: {
        type: request.type,
        amount: request.amount,
      },
    });

    return updated;
  });
}

export async function approveWalletRequest(input: {
  requestId: string;
  adminId?: string | null;
  adminNote?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.walletRequest.findUnique({
      where: { id: input.requestId },
    });
    if (!request) throw new NotFoundError("Wallet request not found");
    if (request.status !== "PENDING")
      throw new ConflictError("Wallet request is already resolved");

    await claimPendingRequest(tx, request.id, "APPROVED", input);

    const common = {
      userId: request.userId,
      amount: request.amount,
      description: `${request.type === "DEPOSIT" ? "Deposit" : "Withdrawal"} approved`,
      metadata: {
        walletRequestId: request.id,
        adminId: input.adminId ?? null,
        adminNote: cleanText(input.adminNote),
      } as Prisma.InputJsonValue,
    };

    const wallet =
      request.type === "DEPOSIT"
        ? await creditWallet(tx, {
            ...common,
            type: "DEPOSIT",
          })
        : await debitWallet(tx, {
            ...common,
            type: "WITHDRAWAL",
          });

    const updated = await tx.walletRequest.findUniqueOrThrow({
      where: { id: request.id },
    });

    await logAudit(tx, {
      actorId: input.adminId ?? undefined,
      action: "WALLET_REQUEST_APPROVED",
      target: walletRequestTarget(request.id),
      metadata: {
        userId: request.userId,
        type: request.type,
        amount: request.amount,
        balanceAfter: wallet.balance,
      },
    });

    return { request: updated, wallet };
  });
}

export async function rejectWalletRequest(input: {
  requestId: string;
  adminId?: string | null;
  adminNote?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.walletRequest.findUnique({
      where: { id: input.requestId },
    });
    if (!request) throw new NotFoundError("Wallet request not found");
    if (request.status !== "PENDING")
      throw new ConflictError("Wallet request is already resolved");

    const updated = await claimPendingRequest(
      tx,
      request.id,
      "REJECTED",
      input,
    );

    await logAudit(tx, {
      actorId: input.adminId ?? undefined,
      action: "WALLET_REQUEST_REJECTED",
      target: walletRequestTarget(request.id),
      metadata: {
        userId: request.userId,
        type: request.type,
        amount: request.amount,
        adminNote: updated.adminNote,
      },
    });

    return updated;
  });
}

async function assertWithdrawCapacity(userId: string, amount: number) {
  const [wallet, pendingWithdrawals] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId } }),
    prisma.walletRequest.aggregate({
      where: {
        userId,
        type: "WITHDRAW",
        status: "PENDING",
      },
      _sum: { amount: true },
    }),
  ]);

  if (!wallet) throw new NotFoundError("Wallet not found");
  const pending = pendingWithdrawals._sum.amount ?? 0;
  if (wallet.balance - pending < amount) {
    throw new AppError(
      "Insufficient available credits for this withdrawal",
      402,
      "INSUFFICIENT_CREDITS",
    );
  }
}

async function claimPendingRequest(
  tx: TxClient,
  requestId: string,
  status: Extract<WalletRequestStatus, "APPROVED" | "REJECTED">,
  input: { adminId?: string | null; adminNote?: string | null },
) {
  const claimed = await tx.walletRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: {
      status,
      adminId: input.adminId ?? null,
      adminNote: cleanText(input.adminNote),
      resolvedAt: new Date(),
    },
  });

  if (claimed.count !== 1)
    throw new ConflictError("Wallet request is already resolved");

  return tx.walletRequest.findUniqueOrThrow({ where: { id: requestId } });
}

function assertWalletAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0)
    throw new AppError("Amount must be a positive whole number");
}

function cleanText(value?: string | null): string | null {
  const text = value?.trim();
  if (!text) return null;
  return text.slice(0, 500);
}

function walletRequestTarget(requestId: string): string {
  return `wallet-request:${requestId}`;
}
