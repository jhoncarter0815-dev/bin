import { env } from "../config.js";
import { prisma } from "../prisma.js";
import type { TelegramUserPayload } from "../auth/telegram.js";

export async function upsertTelegramUser(payload: TelegramUserPayload) {
  const telegramId = BigInt(payload.id);

  return prisma.user.upsert({
    where: { telegramId },
    create: {
      telegramId,
      username: payload.username,
      firstName: payload.first_name,
      lastName: payload.last_name,
      photoUrl: payload.photo_url,
      wallet: {
        create: {
          balance: env.STARTING_CREDITS
        }
      }
    },
    update: {
      username: payload.username,
      firstName: payload.first_name,
      lastName: payload.last_name,
      photoUrl: payload.photo_url
    },
    include: {
      wallet: true
    }
  });
}

