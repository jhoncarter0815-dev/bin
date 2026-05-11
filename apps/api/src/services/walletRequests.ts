import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  WalletRequestStatus,
  WalletRequestType,
} from "@prisma/client";
import { env } from "../config.js";
import { AppError, ConflictError, NotFoundError } from "../errors.js";
import { prisma } from "../prisma.js";
import { logAudit } from "./audit.js";
import {
  maskedPhoneMatches,
  moneyEquals,
  normalizeTelebirrReceiptUrl,
  normalizeTelebirrPhone,
  normalizeTelebirrTransactionCode,
  parseTelebirrMessage,
  type TelebirrParsedMessage,
  validateTelebirrDeposit,
} from "./telebirr.js";
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
  transactionCode?: string | null;
  transactionTime?: string | null;
  receiptUrl?: string | null;
  telebirrMessage?: string | null;
  senderPhoneNumber?: string | null;
}) {
  assertWalletAmount(input.amount);

  if (input.type === "WITHDRAW") {
    await assertWithdrawCapacity(input.userId, input.amount);
  }

  if (input.type === "DEPOSIT") {
    return createTelebirrDepositRequest(input);
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

async function createTelebirrDepositRequest(input: {
  userId: string;
  amount: number;
  details?: string | null;
  transactionCode?: string | null;
  transactionTime?: string | null;
  receiptUrl?: string | null;
  telebirrMessage?: string | null;
  senderPhoneNumber?: string | null;
}) {
  const parsedMessage = input.telebirrMessage
    ? parseTelebirrMessage(input.telebirrMessage)
    : null;
  const transactionCode = normalizeTelebirrTransactionCode(
    requiredText(
      input.transactionCode ?? parsedMessage?.transactionCode,
      "Telebirr transaction code is required",
    ),
  );
  const transactionTime = requiredText(
    input.transactionTime ?? parsedMessage?.transactionTime,
    "Telebirr transaction time is required",
  ).slice(0, 120);
  const receiptUrl = normalizeTelebirrReceiptUrl(
    requiredText(
      input.receiptUrl ?? parsedMessage?.receiptUrl,
      "Telebirr receipt URL is required",
    ),
  ).toString();
  const expectedEtb = input.amount / env.TELEBIRR_CREDIT_PER_ETB;

  if (parsedMessage) {
    assertParsedMessageMatchesDeposit({
      parsedMessage,
      transactionCode,
      receiptUrl,
      expectedEtb,
    });
  }

  const duplicate = await prisma.walletRequest.findFirst({
    where: {
      OR: [{ transactionCode }, { receiptUrl }],
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new ConflictError(
      "This Telebirr transaction code or receipt URL was already submitted",
    );
  }

  const validation = await validateTelebirrDeposit({
    amount: input.amount,
    transactionCode,
    transactionTime,
    receiptUrl,
    senderPhoneNumber: input.senderPhoneNumber,
    parsedMessage,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      const request = await tx.walletRequest.create({
        data: {
          userId: input.userId,
          type: "DEPOSIT",
          status: validation.autoApprove ? "APPROVED" : "PENDING",
          amount: input.amount,
          details: cleanText(
            input.details ?? (parsedMessage ? "Telebirr SMS submitted" : null),
          ),
          provider: "TELEBIRR",
          transactionCode,
          transactionTime,
          receiptUrl,
          validationStatus: validation.status,
          validationReason: validation.reason,
          validationPayload: validation.payload as Prisma.InputJsonValue,
          resolvedAt: validation.autoApprove ? new Date() : null,
        },
      });

      if (validation.autoApprove) {
        await creditWallet(tx, {
          userId: input.userId,
          amount: input.amount,
          type: "DEPOSIT",
          description: "Telebirr deposit auto-approved",
          metadata: {
            walletRequestId: request.id,
            provider: "TELEBIRR",
            transactionCode,
            receiptUrl,
            senderPhoneLast4: normalizeTelebirrPhone(
              input.senderPhoneNumber ?? "",
            ).slice(-4),
          },
        });
      }

      await logAudit(tx, {
        actorId: input.userId,
        action: validation.autoApprove
          ? "TELEBIRR_DEPOSIT_AUTO_APPROVED"
          : "TELEBIRR_DEPOSIT_NEEDS_REVIEW",
        target: walletRequestTarget(request.id),
        metadata: {
          amount: input.amount,
          transactionCode,
          senderPhoneLast4: normalizeTelebirrPhone(
            input.senderPhoneNumber ?? "",
          ).slice(-4),
          validationStatus: validation.status,
          validationReason: validation.reason,
        },
      });

      return request;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictError(
        "This Telebirr transaction code or receipt URL was already submitted",
      );
    }
    throw error;
  }
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
          phoneNumber: true,
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

function requiredText(
  value: string | null | undefined,
  message: string,
): string {
  const text = value?.trim();
  if (!text) throw new AppError(message);
  return text;
}

function assertParsedMessageMatchesDeposit(input: {
  parsedMessage: TelebirrParsedMessage;
  transactionCode: string;
  receiptUrl: string;
  expectedEtb: number;
}): void {
  const { parsedMessage, transactionCode, receiptUrl, expectedEtb } = input;
  if (parsedMessage.transactionCode !== transactionCode) {
    throw new AppError("Telebirr message transaction code does not match");
  }

  const urlCode = receiptUrlCode(receiptUrl);
  if (urlCode && urlCode !== transactionCode) {
    throw new AppError("Telebirr receipt URL does not match transaction code");
  }

  if (!moneyEquals(parsedMessage.amountEtb, expectedEtb)) {
    throw new AppError("Telebirr message amount does not match deposit amount");
  }

  const receiver = env.TELEBIRR_DEPOSIT_RECEIVER.trim();
  if (receiver) {
    const expectedReceiver = compactText(receiver);
    const actualReceiver = compactText(parsedMessage.receiverName);
    if (
      !actualReceiver.includes(expectedReceiver) &&
      !expectedReceiver.includes(actualReceiver)
    ) {
      throw new AppError("Telebirr message receiver does not match this bot");
    }
  }

  const receiverPhone = normalizeTelebirrPhone(env.TELEBIRR_DEPOSIT_PHONE);
  if (
    receiverPhone &&
    !maskedPhoneMatches(parsedMessage.receiverPhone, receiverPhone)
  ) {
    throw new AppError("Telebirr message receiver phone does not match");
  }
}

function receiptUrlCode(receiptUrl: string): string | null {
  try {
    const code = new URL(receiptUrl).pathname.split("/").filter(Boolean).at(-1);
    return code ? normalizeTelebirrTransactionCode(code) : null;
  } catch {
    return null;
  }
}

function compactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function walletRequestTarget(requestId: string): string {
  return `wallet-request:${requestId}`;
}
