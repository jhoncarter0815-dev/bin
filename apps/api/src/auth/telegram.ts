import crypto from "node:crypto";
import { z } from "zod";
import { env } from "../config.js";
import { AppError } from "../errors.js";

const telegramUserSchema = z.object({
  id: z.number(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional()
});

export type TelegramUserPayload = z.infer<typeof telegramUserSchema>;

export function verifyTelegramInitData(initData: string): TelegramUserPayload {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new AppError("Telegram hash is missing", 401, "INVALID_TELEGRAM_HASH");

  const authDate = Number(params.get("auth_date") ?? 0);
  const maxAgeSeconds = env.NODE_ENV === "production" ? 60 * 60 * 24 : 60 * 60 * 24 * 7;
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) {
    throw new AppError("Telegram login expired", 401, "TELEGRAM_AUTH_EXPIRED");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(env.TELEGRAM_BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const valid =
    calculatedHash.length === receivedHash.length &&
    crypto.timingSafeEqual(Buffer.from(calculatedHash), Buffer.from(receivedHash));
  if (!valid) throw new AppError("Invalid Telegram signature", 401, "INVALID_TELEGRAM_SIGNATURE");

  const userRaw = params.get("user");
  if (!userRaw) throw new AppError("Telegram user is missing", 401, "INVALID_TELEGRAM_USER");

  return telegramUserSchema.parse(JSON.parse(userRaw));
}

export function devTelegramUser(seed?: number): TelegramUserPayload {
  if (!env.ALLOW_DEV_LOGIN) throw new AppError("Dev login is disabled", 401, "DEV_LOGIN_DISABLED");
  const id = seed ?? Math.floor(100_000_000 + Math.random() * 899_999_999);
  return {
    id,
    first_name: "Dev",
    last_name: "Player",
    username: `dev_${id}`
  };
}

