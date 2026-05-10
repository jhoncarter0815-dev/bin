import type { FastifyInstance } from "fastify";
import { Markup, Telegraf, type Context } from "telegraf";
import { env, miniAppUrl } from "./config.js";
import { tickRooms } from "./game/roomManager.js";
import { prisma } from "./prisma.js";

export const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

const MAIN_MENU_TEXT =
  "Bingo Core menu\nChoose an action below to play, manage credits, get help, or invite friends.";
const ADMIN_MENU_TEXT =
  "Admin tools\nUse these controls to inspect the live bot and run safe operational actions.";
const RECENT_PIN_WINDOW_MS = 6 * 60 * 60 * 1000;

bot.start(async (ctx) => {
  const referralCode = referralFromStartPayload(ctx);
  await sendPinnedMainMenu(ctx, referralCode);
});

bot.command("menu", async (ctx) => {
  await sendPinnedMainMenu(ctx);
});

bot.command("play", async (ctx) => {
  await ctx.reply(
    "Open the Mini App to join the current public room.",
    Markup.inlineKeyboard([Markup.button.webApp("Play Bingo", miniAppUrl())]),
  );
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
  return ctx.reply(
    `Wallet: ${user.wallet.balance} credits\nLocked: ${user.wallet.locked} credits`,
  );
});

bot.command("invite", async (ctx) => {
  await replyInvite(ctx);
});

bot.command("admin", async (ctx) => {
  if (!(await isAdminContext(ctx))) return ctx.reply("Admin only.");
  if (!isPrivateChat(ctx)) {
    return ctx.reply(
      "Admin tools are available in a private chat with the bot.",
    );
  }
  return sendAdminMenu(ctx);
});

bot.help(async (ctx) => {
  await replyHelp(ctx);
});

bot.action("menu:deposit", async (ctx) => {
  await ctx.answerCbQuery();
  await replyDeposit(ctx);
});

bot.action("menu:withdraw", async (ctx) => {
  await ctx.answerCbQuery();
  await replyWithdraw(ctx);
});

bot.action("menu:help", async (ctx) => {
  await ctx.answerCbQuery();
  await replyHelp(ctx);
});

bot.action("menu:invite", async (ctx) => {
  await ctx.answerCbQuery();
  await replyInvite(ctx);
});

bot.action("admin:menu", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();
  await sendAdminMenu(ctx);
});

bot.action("admin:stats", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();

  const [
    userCount,
    openRooms,
    activeMatches,
    queuedPlayers,
    walletTotals,
    txnCount,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.room.count({ where: { status: { in: ["OPEN", "COUNTDOWN"] } } }),
    prisma.match.count({ where: { status: "ACTIVE" } }),
    prisma.publicQueueEntry.count(),
    prisma.wallet.aggregate({ _sum: { balance: true, locked: true } }),
    prisma.transaction.count(),
  ]);

  await ctx.reply(
    [
      "Admin stats",
      `Users: ${userCount}`,
      `Open/countdown rooms: ${openRooms}`,
      `Active matches: ${activeMatches}`,
      `Queued players: ${queuedPlayers}`,
      `Wallet balance total: ${walletTotals._sum.balance ?? 0} credits`,
      `Locked balance total: ${walletTotals._sum.locked ?? 0} credits`,
      `Transactions: ${txnCount}`,
    ].join("\n"),
    adminMenuKeyboard(),
  );
});

bot.action("admin:rooms", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();

  const rooms = await prisma.room.findMany({
    orderBy: { createdAt: "desc" },
    take: 8,
    include: {
      _count: { select: { seats: true } },
      match: { select: { status: true, winnerSeat: true, prizePool: true } },
    },
  });

  await ctx.reply(
    rooms.length
      ? ["Recent rooms", ...rooms.map(formatRoomLine)].join("\n")
      : "No rooms yet.",
    adminMenuKeyboard(),
  );
});

bot.action("admin:users", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: 8,
    include: { wallet: true },
  });

  await ctx.reply(
    users.length
      ? ["Recent users", ...users.map(formatUserLine)].join("\n")
      : "No users yet.",
    adminMenuKeyboard(),
  );
});

bot.action("admin:transactions", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();

  const transactions = await prisma.transaction.findMany({
    orderBy: { createdAt: "desc" },
    take: 8,
    include: {
      user: {
        select: {
          username: true,
          firstName: true,
          lastName: true,
          telegramId: true,
        },
      },
    },
  });

  await ctx.reply(
    transactions.length
      ? [
          "Recent transactions",
          ...transactions.map(formatTransactionLine),
        ].join("\n")
      : "No transactions yet.",
    adminMenuKeyboard(),
  );
});

bot.action("admin:tick", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();

  const result = await tickRooms();
  await ctx.reply(
    `Room tick complete.\nStarted rooms: ${result.started}\nDrawn matches: ${result.drawn}`,
    adminMenuKeyboard(),
  );
});

bot.action("admin:pin_menu", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();

  const chatId = env.TELEGRAM_ANNOUNCE_CHAT_ID || ctx.chat?.id;
  if (!chatId) return ctx.reply("No announcement chat is configured.");

  try {
    const result = await sendPinnedMenuToChat(chatId, { force: true });
    await ctx.reply(
      result.pinned
        ? "Public menu sent and pinned."
        : "Public menu sent. Pinning needs bot pin permission in that chat.",
      adminMenuKeyboard(),
    );
  } catch (error) {
    await ctx.reply(
      `Could not send the public menu: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      adminMenuKeyboard(),
    );
  }
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
    { command: "menu", description: "Show the pinned menu" },
    { command: "play", description: "Play Bingo" },
    { command: "wallet", description: "Check credits" },
    { command: "invite", description: "Invite players" },
    { command: "help", description: "How to play" },
  ]);

  await pinAnnouncementMenuOnStartup(fastify);

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

async function sendPinnedMainMenu(
  ctx: Context,
  referralCode?: string,
): Promise<void> {
  const includeAdmin = isPrivateChat(ctx) && (await isAdminContext(ctx));
  const message = await ctx.reply(
    MAIN_MENU_TEXT,
    mainMenuKeyboard({ includeAdmin, referralCode }),
  );
  await pinMessage(ctx, message.message_id);
}

async function sendAdminMenu(ctx: Context): Promise<void> {
  await ctx.reply(ADMIN_MENU_TEXT, adminMenuKeyboard());
}

async function replyDeposit(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "Deposit",
      "Send support the amount you want to add and your Telegram username. An admin will confirm the payment and credit your wallet.",
      supportContactText(),
    ].join("\n"),
    supportKeyboard(),
  );
}

async function replyWithdraw(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "Withdraw",
      "Send support your username, amount, and payout details. An admin will verify the available balance before approving it.",
      supportContactText(),
    ].join("\n"),
    supportKeyboard(),
  );
}

async function replyHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "Help",
      "Use Play to join a room, Wallet to check credits, and Invite to share your referral link.",
      "Bingo claims are validated by the server and every finished match exposes a fair-play proof.",
      supportContactText(),
    ].join("\n"),
    supportKeyboard(),
  );
}

async function replyInvite(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id ? BigInt(ctx.from.id) : undefined;
  if (!telegramId) {
    await ctx.reply("Open the Mini App first so I can connect your account.");
    return;
  }

  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user?.referralCode) {
    await ctx.reply(
      "Open the Mini App first so I can create your invite code.",
    );
    return;
  }

  await ctx.reply(
    `Your invite link:\n${referralLink(user.referralCode)}\n\nYou earn ${env.REFERRAL_REWARD_CREDITS} credits when a new player joins with it.`,
  );
}

function mainMenuKeyboard(
  options: {
    includeAdmin?: boolean;
    referralCode?: string;
  } = {},
) {
  const rows = [
    [
      Markup.button.webApp(
        "Play",
        miniAppUrlWithReferral(options.referralCode),
      ),
    ],
    [
      Markup.button.callback("Deposit", "menu:deposit"),
      Markup.button.callback("Withdraw", "menu:withdraw"),
    ],
    [
      Markup.button.callback("Help / Support", "menu:help"),
      Markup.button.callback("Invite", "menu:invite"),
    ],
  ];

  if (options.includeAdmin) {
    rows.push([Markup.button.callback("Admin Tools", "admin:menu")]);
  }

  return Markup.inlineKeyboard(rows);
}

function adminMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Stats", "admin:stats"),
      Markup.button.callback("Rooms", "admin:rooms"),
    ],
    [
      Markup.button.callback("Users", "admin:users"),
      Markup.button.callback("Transactions", "admin:transactions"),
    ],
    [
      Markup.button.callback("Run Room Tick", "admin:tick"),
      Markup.button.callback("Pin Public Menu", "admin:pin_menu"),
    ],
    [Markup.button.webApp("Open Game", miniAppUrl())],
  ]);
}

function supportKeyboard() {
  const url = supportContactUrl();
  if (!url) return undefined;
  return Markup.inlineKeyboard([Markup.button.url("Contact Support", url)]);
}

function supportContactText(): string {
  const contact = env.SUPPORT_CONTACT.trim();
  if (!contact) return "Support contact is not configured yet.";
  return `Support: ${contact}`;
}

function supportContactUrl(): string | undefined {
  const contact = env.SUPPORT_CONTACT.trim();
  if (!contact) return undefined;
  if (/^https?:\/\//i.test(contact)) return contact;
  if (contact.startsWith("@")) return `https://t.me/${contact.slice(1)}`;
  if (/^[a-zA-Z0-9_]{5,32}$/.test(contact)) return `https://t.me/${contact}`;
  return undefined;
}

async function isAdminContext(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return false;
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { isAdmin: true },
  });
  return user?.isAdmin === true;
}

async function requireAdminCallback(ctx: Context): Promise<boolean> {
  if (!isPrivateChat(ctx)) {
    await ctx
      .answerCbQuery("Open a private chat with the bot for admin tools.", {
        show_alert: true,
      })
      .catch(() => undefined);
    return false;
  }
  if (await isAdminContext(ctx)) return true;
  await ctx
    .answerCbQuery("Admin only", { show_alert: true })
    .catch(() => undefined);
  return false;
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

async function pinMessage(ctx: Context, messageId: number): Promise<void> {
  if (!ctx.chat) return;
  try {
    await ctx.telegram.pinChatMessage(ctx.chat.id, messageId, {
      disable_notification: true,
    });
  } catch {
    // Pinning requires Telegram permissions in groups and can fail in some chats.
  }
}

async function pinAnnouncementMenuOnStartup(
  fastify: FastifyInstance,
): Promise<void> {
  if (!env.TELEGRAM_ANNOUNCE_CHAT_ID) return;

  try {
    await sendPinnedMenuToChat(env.TELEGRAM_ANNOUNCE_CHAT_ID);
  } catch (error) {
    fastify.log.warn(
      {
        error: error instanceof Error ? error.message : "unknown",
      },
      "telegram pinned menu was not sent",
    );
  }
}

async function sendPinnedMenuToChat(
  chatId: string | number,
  options: { force?: boolean } = {},
): Promise<{ pinned: boolean; skipped: boolean }> {
  const target = `chat:${chatId}`;
  if (!options.force) {
    const recent = await prisma.auditLog.findFirst({
      where: {
        action: "PINNED_MAIN_MENU",
        target,
        createdAt: { gte: new Date(Date.now() - RECENT_PIN_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (recent) return { pinned: false, skipped: true };
  }

  const message = await bot.telegram.sendMessage(
    chatId,
    MAIN_MENU_TEXT,
    mainMenuKeyboard(),
  );
  let pinned = false;
  try {
    await bot.telegram.pinChatMessage(chatId, message.message_id, {
      disable_notification: true,
    });
    pinned = true;
  } catch {
    pinned = false;
  }

  await prisma.auditLog.create({
    data: {
      action: "PINNED_MAIN_MENU",
      target,
      metadata: {
        messageId: message.message_id,
        pinned,
      },
    },
  });

  return { pinned, skipped: false };
}

function formatRoomLine(room: {
  code: string;
  status: string;
  entryFee: number;
  maxSeats: number;
  startsAt: Date;
  _count: { seats: number };
  match: {
    status: string;
    winnerSeat: number | null;
    prizePool: number;
  } | null;
}): string {
  const match = room.match
    ? ` match=${room.match.status} pot=${room.match.prizePool} winner=${room.match.winnerSeat ?? "-"}`
    : "";
  return `${room.code}: ${room.status} seats=${room._count.seats}/${room.maxSeats} fee=${room.entryFee} starts=${formatDate(room.startsAt)}${match}`;
}

function formatUserLine(user: {
  telegramId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
  isBanned: boolean;
  wallet: { balance: number; locked: number } | null;
}): string {
  const flags = [
    user.isAdmin ? "admin" : "",
    user.isBanned ? "banned" : "",
  ].filter(Boolean);
  return `${displayUser(user)} wallet=${user.wallet?.balance ?? 0} locked=${user.wallet?.locked ?? 0}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

function formatTransactionLine(transaction: {
  type: string;
  amount: number;
  balanceAfter: number;
  createdAt: Date;
  user: {
    telegramId: bigint;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  };
}): string {
  return `${formatDate(transaction.createdAt)} ${displayUser(transaction.user)} ${transaction.type} ${transaction.amount} balance=${transaction.balanceAfter}`;
}

function displayUser(user: {
  telegramId?: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  if (user.username) return `@${user.username}`;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return name || user.telegramId?.toString() || "Player";
}

function formatDate(value: Date): string {
  return `${value.toISOString().replace("T", " ").slice(0, 16)} UTC`;
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
