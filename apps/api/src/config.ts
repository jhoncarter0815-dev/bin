import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(24),
  ADMIN_SECRET: z.string().min(16),
  ADMIN_TELEGRAM_IDS: z.string().optional().default(""),
  TELEGRAM_BOT_TOKEN: z.string().min(8),
  TELEGRAM_BOT_USERNAME: z.string().optional().default(""),
  TELEGRAM_ANNOUNCE_CHAT_ID: z
    .string()
    .optional()
    .or(z.literal(""))
    .default(""),
  SUPPORT_CONTACT: z.string().optional().or(z.literal("")).default(""),
  DEPOSIT_INSTRUCTIONS: z.string().optional().or(z.literal("")).default(""),
  WITHDRAW_INSTRUCTIONS: z.string().optional().or(z.literal("")).default(""),
  TELEBIRR_AUTO_DEPOSIT_ENABLED: z
    .string()
    .transform((value) => value !== "false")
    .default("true"),
  TELEBIRR_DEPOSIT_RECEIVER: z
    .string()
    .optional()
    .or(z.literal(""))
    .default(""),
  TELEBIRR_DEPOSIT_PHONE: z.string().optional().or(z.literal("")).default(""),
  TELEBIRR_RECEIPT_ALLOWED_HOSTS: z
    .string()
    .default("transactioninfo.ethiotelecom.et"),
  TELEBIRR_RECEIPT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(45000),
  TELEBIRR_RECEIPT_PROXY_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal(""))
    .default(""),
  TELEBIRR_RECEIPT_PROXY_SECRET: z
    .string()
    .optional()
    .or(z.literal(""))
    .default(""),
  TELEBIRR_MAX_RECEIPT_AGE_HOURS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(72),
  TELEBIRR_CREDIT_PER_ETB: z.coerce.number().positive().default(1),
  TELEGRAM_WEBHOOK_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal(""))
    .default(""),
  PUBLIC_APP_URL: z.string().url().optional().or(z.literal("")).default(""),
  MINI_APP_DEV_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal(""))
    .default("http://localhost:5173"),
  API_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal(""))
    .default("http://localhost:8080"),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  ALLOW_DEV_LOGIN: z
    .string()
    .transform((value) => value === "true")
    .default("false"),
  PUBLIC_ROOM_SECONDS: z.coerce.number().int().positive().default(30),
  PUBLIC_ROOM_MIN_PLAYERS: z.coerce.number().int().positive().default(2),
  PUBLIC_ROOM_MAX_SEATS: z.coerce.number().int().positive().default(200),
  DRAW_INTERVAL_MS: z.coerce.number().int().positive().default(2500),
  PUBLIC_ENTRY_FEE: z.coerce.number().int().nonnegative().default(50),
  STARTING_CREDITS: z.coerce.number().int().nonnegative().default(1000),
  REFERRAL_REWARD_CREDITS: z.coerce.number().int().nonnegative().default(100),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment: ${details}`);
}

export const env = {
  ...parsed.data,
  ADMIN_TELEGRAM_IDS: parsed.data.ADMIN_TELEGRAM_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  CORS_ORIGINS: parsed.data.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  TELEBIRR_RECEIPT_ALLOWED_HOSTS:
    parsed.data.TELEBIRR_RECEIPT_ALLOWED_HOSTS.split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
};

export function miniAppUrl(): string {
  return env.PUBLIC_APP_URL || env.MINI_APP_DEV_URL;
}

export function isConfiguredAdminTelegramId(
  telegramId: bigint | number | string,
): boolean {
  return env.ADMIN_TELEGRAM_IDS.includes(String(telegramId));
}
