import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(24),
  ADMIN_SECRET: z.string().min(16),
  TELEGRAM_BOT_TOKEN: z.string().min(8),
  TELEGRAM_BOT_USERNAME: z.string().optional().default(""),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional().or(z.literal("")).default(""),
  PUBLIC_APP_URL: z.string().url().optional().or(z.literal("")).default(""),
  MINI_APP_DEV_URL: z.string().url().optional().or(z.literal("")).default("http://localhost:5173"),
  API_URL: z.string().url().optional().or(z.literal("")).default("http://localhost:8080"),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  ALLOW_DEV_LOGIN: z
    .string()
    .transform((value) => value === "true")
    .default("false"),
  PUBLIC_ROOM_SECONDS: z.coerce.number().int().positive().default(30),
  DRAW_INTERVAL_MS: z.coerce.number().int().positive().default(2500),
  MIN_PLAYERS_TO_START: z.coerce.number().int().positive().default(2),
  PUBLIC_ENTRY_FEE: z.coerce.number().int().nonnegative().default(50),
  STARTING_CREDITS: z.coerce.number().int().nonnegative().default(1000)
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
  CORS_ORIGINS: parsed.data.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
};

export function miniAppUrl(): string {
  return env.PUBLIC_APP_URL || env.MINI_APP_DEV_URL;
}
