import { env } from "../config.js";
import { prisma } from "../prisma.js";
import type { TelegramUserPayload } from "../auth/telegram.js";
import { creditWallet } from "./wallet.js";
import { logAudit, userTarget } from "./audit.js";

export async function upsertTelegramUser(
  payload: TelegramUserPayload,
  referralCode?: string,
) {
  const telegramId = BigInt(payload.id);
  const userReferralCode = referralCodeForTelegramId(telegramId);

  const user = await prisma.user.upsert({
    where: { telegramId },
    create: {
      telegramId,
      username: payload.username,
      firstName: payload.first_name,
      lastName: payload.last_name,
      photoUrl: payload.photo_url,
      referralCode: userReferralCode,
      wallet: {
        create: {
          balance: env.STARTING_CREDITS,
        },
      },
    },
    update: {
      username: payload.username,
      firstName: payload.first_name,
      lastName: payload.last_name,
      photoUrl: payload.photo_url,
      referralCode: userReferralCode,
    },
    include: {
      wallet: true,
    },
  });

  await applyReferral(user.id, referralCode ?? payload.start_param);
  return user;
}

export function normalizeReferralCode(
  value?: string | null,
): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .trim()
    .replace(/^ref[_-]/i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  return normalized || undefined;
}

function referralCodeForTelegramId(telegramId: bigint): string {
  return `TG${telegramId.toString().replace("-", "B")}`;
}

async function applyReferral(
  referredId: string,
  rawReferralCode?: string,
): Promise<void> {
  const referralCode = normalizeReferralCode(rawReferralCode);
  if (!referralCode || env.REFERRAL_REWARD_CREDITS <= 0) return;

  await prisma.$transaction(async (tx) => {
    const referrer = await tx.user.findFirst({
      where: {
        referralCode,
        id: { not: referredId },
      },
      select: { id: true },
    });
    if (!referrer) return;

    const existing = await tx.referral.findUnique({
      where: { referredId },
    });
    if (existing) return;

    await tx.referral.create({
      data: {
        referrerId: referrer.id,
        referredId,
        reward: env.REFERRAL_REWARD_CREDITS,
      },
    });

    await creditWallet(tx, {
      userId: referrer.id,
      amount: env.REFERRAL_REWARD_CREDITS,
      type: "REFERRAL_BONUS",
      description: "Referral bonus",
      metadata: { referredId },
    });

    await logAudit(tx, {
      actorId: referredId,
      action: "REFERRAL_RECORDED",
      target: userTarget(referrer.id),
      metadata: {
        referrerId: referrer.id,
        referredId,
        reward: env.REFERRAL_REWARD_CREDITS,
      },
    });
  });
}
