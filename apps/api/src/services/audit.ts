import type { Prisma, PrismaClient } from "@prisma/client";

type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export async function logAudit(
  tx: TxClient,
  input: {
    actorId?: string | null;
    action: string;
    target?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
) {
  return tx.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      action: input.action,
      target: input.target ?? null,
      metadata: input.metadata,
    },
  });
}

export function matchTarget(matchId: string): string {
  return `match:${matchId}`;
}

export function roomTarget(roomId: string): string {
  return `room:${roomId}`;
}

export function userTarget(userId: string): string {
  return `user:${userId}`;
}
