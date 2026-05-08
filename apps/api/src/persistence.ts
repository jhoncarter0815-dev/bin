import type { FastifyBaseLogger } from "fastify";
import { env } from "./config.js";
import { prisma } from "./prisma.js";

export async function verifyPersistentStorage(
  log: FastifyBaseLogger,
): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;

  const [users, wallets, rooms, activeMatches, transactions] =
    await Promise.all([
      prisma.user.count(),
      prisma.wallet.count(),
      prisma.room.count(),
      prisma.match.count({ where: { status: "ACTIVE" } }),
      prisma.transaction.count(),
    ]);

  log.info(
    {
      database: describeDatabase(env.DATABASE_URL),
      users,
      wallets,
      rooms,
      activeMatches,
      transactions,
    },
    "persistent storage ready",
  );

  if (env.NODE_ENV === "production" && pointsAtLocalhost(env.DATABASE_URL)) {
    log.warn(
      {
        database: describeDatabase(env.DATABASE_URL),
      },
      "production DATABASE_URL points at localhost; use managed PostgreSQL or a persistent volume so balances survive restarts",
    );
  }
}

function describeDatabase(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    return "unparseable DATABASE_URL";
  }
}

function pointsAtLocalhost(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "::1"].includes(host);
  } catch {
    return false;
  }
}
