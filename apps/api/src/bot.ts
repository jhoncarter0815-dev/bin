import type { FastifyInstance } from "fastify";
import { Markup, Telegraf } from "telegraf";
import { env, miniAppUrl } from "./config.js";
import { prisma } from "./prisma.js";

export const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

bot.start(async (ctx) => {
  const referralCode = referralFromStartPayload(ctx);
  await ctx.reply(
    "Welcome to Bingo Core. Join live multiplayer rooms, lock a seat, and play from the Mini App.",
    Markup.inlineKeyboard([
      Markup.button.webApp(
        "Open Bingo Core",
        miniAppUrlWithReferral(referralCode),
      ),
    ]),
  );
});

bot.command("play", async (ctx) => {
  await ctx.reply("Open the Mini App to join the current public room.", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Play Bingo", web_app: { url: miniAppUrl() } }],
      ],
    },
  });
});

bot.command("wallet", async (ctx) => {
  const telegramId = ctx.from?.id ? BigInt(ctx.from.id) : undefined;
  if (!telegramId)
    return ctx.reply("Open the Mini App first so I can connect your account.");
  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { wallet: true },
  });
  if (!user?.wallet)
    return ctx.reply("Open the Mini App first so I can create your wallet.");
  return ctx.reply(`Wallet: ${user.wallet.balance} credits`);
});

bot.command("invite", async (ctx) => {
  const telegramId = ctx.from?.id ? BigInt(ctx.from.id) : undefined;
  if (!telegramId)
    return ctx.reply("Open the Mini App first so I can connect your account.");
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user?.referralCode)
    return ctx.reply(
      "Open the Mini App first so I can create your invite code.",
    );
  return ctx.reply(
    `Your invite link:\n${referralLink(user.referralCode)}\n\nYou earn ${env.REFERRAL_REWARD_CREDITS} credits when a new player joins with it.`,
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    "Commands:\n/start - open the Mini App\n/play - join bingo\n/wallet - show credits\n/invite - get your referral link\n\nBingo claims are validated by the server and every finished match exposes a fair-play proof.",
  );
});

export async function registerBot(fastify: FastifyInstance): Promise<void> {
  if (
    env.NODE_ENV !== "production" &&
    env.TELEGRAM_BOT_TOKEN.startsWith("123456:")
  ) {
    fastify.log.warn(
      "telegram bot skipped because TELEGRAM_BOT_TOKEN is still the example value",
    );
    return;
  }

  await bot.telegram.setMyCommands([
    { command: "start", description: "Open Bingo Core" },
    { command: "play", description: "Play Bingo" },
    { command: "wallet", description: "Check credits" },
    { command: "invite", description: "Invite players" },
    { command: "help", description: "How to play" },
  ]);

  fastify.post("/telegram/webhook", async (request, reply) => {
    await bot.handleUpdate(request.body as never);
    reply.send({ ok: true });
  });

  if (env.TELEGRAM_WEBHOOK_URL) {
    await bot.telegram.setWebhook(
      `${env.TELEGRAM_WEBHOOK_URL.replace(/\/$/, "")}/telegram/webhook`,
    );
    fastify.log.info("telegram webhook configured");
  } else if (env.NODE_ENV !== "test") {
    await bot.launch();
    fastify.log.info("telegram bot launched in polling mode");
  }
}

function referralFromStartPayload(ctx: unknown): string | undefined {
  const payload =
    typeof ctx === "object" && ctx && "startPayload" in ctx
      ? String((ctx as { startPayload?: string }).startPayload ?? "")
      : "";
  return normalizeReferralPayload(payload);
}

function normalizeReferralPayload(payload: string): string | undefined {
  const value = payload
    .trim()
    .replace(/^ref[_-]/i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  return value || undefined;
}

function miniAppUrlWithReferral(referralCode?: string): string {
  if (!referralCode) return miniAppUrl();
  try {
    const url = new URL(miniAppUrl());
    url.searchParams.set("ref", referralCode);
    return url.toString();
  } catch {
    const separator = miniAppUrl().includes("?") ? "&" : "?";
    return `${miniAppUrl()}${separator}ref=${encodeURIComponent(referralCode)}`;
  }
}

function referralLink(referralCode: string): string {
  if (env.TELEGRAM_BOT_USERNAME) {
    return `https://t.me/${env.TELEGRAM_BOT_USERNAME.replace(/^@/, "")}?start=ref_${referralCode}`;
  }
  return miniAppUrlWithReferral(referralCode);
}
