import type { FastifyInstance } from "fastify";
import { Markup, Telegraf, type Context } from "telegraf";
import { env, isConfiguredAdminTelegramId, miniAppUrl } from "./config.js";
import {
  forceCreatePublicRoomFromQueue,
  forceStartPublicRoom,
  isMatchmakingPaused,
  removeUserFromPublicQueue,
  requeuePublicRoom,
  setMatchmakingPaused,
  tickRooms,
} from "./game/roomManager.js";
import { prisma } from "./prisma.js";
import {
  clearNonDepositCredits,
  creditWallet,
  debitWallet,
} from "./services/wallet.js";
import {
  approveWalletRequest,
  createWalletRequest,
  listPendingWalletRequests,
  rejectWalletRequest,
} from "./services/walletRequests.js";
import {
  moneyEquals,
  normalizeTelebirrPhone,
  parseTelebirrMessage,
} from "./services/telebirr.js";
import { upsertTelegramUser } from "./services/users.js";

export const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

const MAIN_MENU_TEXT = bi(
  "Bingo Core menu\nChoose an action below to play, manage credits, get help, or invite friends.",
  "የBingo Core ሜኑ\nለመጫወት፣ ክሬዲት ለማስተዳደር፣ እገዛ ለማግኘት ወይም ጓደኞችን ለመጋበዝ ከታች ይምረጡ።",
);
const ADMIN_MENU_TEXT =
  "Admin tools\nUse these controls to inspect the live bot and run safe operational actions.";
const RECENT_PIN_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEPOSIT_SESSION_MS = 30 * 60 * 1000;
type PendingWalletRequest = Awaited<
  ReturnType<typeof listPendingWalletRequests>
>[number];

bot.start(async (ctx) => {
  const referralCode = referralFromStartPayload(ctx);
  await sendPinnedMainMenu(ctx, referralCode);
});

bot.command("menu", async (ctx) => {
  await sendPinnedMainMenu(ctx);
});

bot.command("play", async (ctx) => {
  await ctx.reply(
    bi(
      "Open the Mini App to join the current public room.",
      "የአሁኑን የሕዝብ ክፍል ለመቀላቀል Mini App ይክፈቱ።",
    ),
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

bot.command("deposit", async (ctx) => {
  await replyDeposit(ctx);
});

bot.command("cancel_deposit", async (ctx) => {
  await cancelDepositFlow(ctx);
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

bot.command("admin_help", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await replyAdminHelp(ctx);
});

bot.command("credit", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await adjustUserCredits(ctx, "credit");
});

bot.command("debit", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await adjustUserCredits(ctx, "debit");
});

bot.command("clear_free_credits", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await clearUserNonDepositCredits(ctx);
});

bot.command("clear_non_deposit", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await clearUserNonDepositCredits(ctx);
});

bot.command("approve_wallet", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await resolveWalletRequestCommand(ctx, "approve");
});

bot.command("reject_wallet", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await resolveWalletRequestCommand(ctx, "reject");
});

bot.command("ban", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await setUserBan(ctx, true);
});

bot.command("unban", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await setUserBan(ctx, false);
});

bot.command("kick_queue", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await kickQueuedUser(ctx);
});

bot.command("broadcast", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await broadcastToUsers(ctx);
});

bot.command("force_room", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await forceRoomFromQueue(ctx);
});

bot.command("force_start", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await forceStartRoomCommand(ctx);
});

bot.command("requeue_room", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await requeueRoomCommand(ctx);
});

bot.command("matchmaking", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await matchmakingCommand(ctx);
});

bot.command("settings", async (ctx) => {
  if (!(await requireAdminMessage(ctx))) return;
  await replyAdminSettings(ctx);
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

bot.on("contact", async (ctx) => {
  await handleDepositContact(ctx);
});

bot.on("text", async (ctx) => {
  await handleDepositText(ctx);
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
    pendingWalletRequests,
    txnCount,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.room.count({ where: { status: { in: ["OPEN", "COUNTDOWN"] } } }),
    prisma.match.count({ where: { status: "ACTIVE" } }),
    prisma.publicQueueEntry.count(),
    prisma.wallet.aggregate({ _sum: { balance: true, locked: true } }),
    prisma.walletRequest.count({ where: { status: "PENDING" } }),
    prisma.transaction.count(),
  ]);

  await ctx.reply(
    [
      "Admin stats",
      `Users: ${userCount}`,
      `Open/countdown rooms: ${openRooms}`,
      `Active matches: ${activeMatches}`,
      `Queued players: ${queuedPlayers}`,
      `Pending wallet requests: ${pendingWalletRequests}`,
      `Wallet balance total: ${walletTotals._sum.balance ?? 0} credits`,
      `Locked balance total: ${walletTotals._sum.locked ?? 0} credits`,
      `Transactions: ${txnCount}`,
    ].join("\n"),
    adminMenuKeyboard(),
  );
});

bot.action("admin:help", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();
  await replyAdminHelp(ctx);
});

bot.action("admin:queue", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();
  await replyQueueSnapshot(ctx);
});

bot.action("admin:settings", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();
  await replyAdminSettings(ctx);
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

bot.action("admin:wallet_requests", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();
  await replyPendingWalletRequests(ctx);
});

bot.action(/^admin:wallet_approve:(.+)$/, async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();
  await resolveWalletRequestCallback(ctx, "approve", ctx.match[1] ?? "");
});

bot.action(/^admin:wallet_reject:(.+)$/, async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();
  await resolveWalletRequestCallback(ctx, "reject", ctx.match[1] ?? "");
});

bot.action("admin:force_room", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();
  await forceRoomFromQueue(ctx);
});

bot.action("admin:tick", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();

  const result = await tickRooms();
  await ctx.reply(
    `Room tick complete.\nCreated rooms: ${result.roomsCreated}\nQueued assigned: ${result.queuedAssigned}\nStarted rooms: ${result.started}\nDrawn matches: ${result.drawn}${result.paused ? "\nMatchmaking: paused" : ""}`,
    adminMenuKeyboard(),
  );
});

bot.action("admin:matchmaking", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();
  await replyMatchmakingStatus(ctx);
});

bot.action("admin:pause_matchmaking", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();
  await setMatchmakingPaused(true, await adminActorId(ctx));
  await ctx.reply("Matchmaking paused.", adminMenuKeyboard());
});

bot.action("admin:resume_matchmaking", async (ctx) => {
  if (!(await requireAdminCallback(ctx))) return;
  await ctx.answerCbQuery();
  await setMatchmakingPaused(false, await adminActorId(ctx));
  const result = await tickRooms();
  await ctx.reply(
    `Matchmaking resumed.\nCreated rooms: ${result.roomsCreated}\nQueued assigned: ${result.queuedAssigned}`,
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
    { command: "deposit", description: "Deposit with Telebirr" },
    { command: "cancel_deposit", description: "Cancel deposit flow" },
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
  if (!isPrivateChat(ctx)) {
    await ctx.reply(
      bi(
        "Open a private chat with the bot to deposit safely.",
        "በደህንነት ለማስገባት ከቦቱ ጋር የግል ቻት ይክፈቱ።",
      ),
    );
    return;
  }
  await startDepositFlow(ctx);
}

async function replyWithdraw(ctx: Context): Promise<void> {
  const fallback =
    "Open the Mini App Wallet tab, submit a withdrawal request, and add your payout details. An admin will verify your available balance before approving it.";
  await ctx.reply(
    [
      "Withdraw / ማውጣት",
      walletInstruction(env.WITHDRAW_INSTRUCTIONS, fallback),
      bi(
        "Use exact payout details so admins can process the request faster.",
        "አድሚኖች በፍጥነት እንዲያስኬዱት ትክክለኛ የመቀበያ መረጃ ያስገቡ።",
      ),
      supportContactText(),
    ].join("\n"),
    supportKeyboard(),
  );
}

async function startDepositFlow(ctx: Context): Promise<void> {
  if (!env.TELEBIRR_DEPOSIT_PHONE.trim()) {
    await ctx.reply(
      bi(
        "Telebirr deposit phone is not configured yet. Please contact support.",
        "የTelebirr መግቢያ ቁጥር ገና አልተዘጋጀም። እባክዎ ድጋፍን ያግኙ።",
      ),
      supportKeyboard(),
    );
    return;
  }

  const user = await ensureBotUser(ctx);
  if (!user) {
    await ctx.reply("I could not connect your Telegram account.");
    return;
  }

  if (!user.phoneNumber) {
    await prisma.botDepositSession.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        step: "CONTACT",
        expiresAt: depositSessionExpiry(),
      },
      update: {
        step: "CONTACT",
        amountCredits: null,
        requestedEtb: null,
        expiresAt: depositSessionExpiry(),
      },
    });
    await askForContact(ctx);
    return;
  }

  await prisma.botDepositSession.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      step: "AMOUNT",
      expiresAt: depositSessionExpiry(),
    },
    update: {
      step: "AMOUNT",
      amountCredits: null,
      requestedEtb: null,
      expiresAt: depositSessionExpiry(),
    },
  });
  await askForDepositAmount(ctx);
}

async function handleDepositContact(ctx: Context): Promise<void> {
  if (!isPrivateChat(ctx)) return;
  const contact = (
    ctx.message as
      | {
          contact?: {
            phone_number?: string;
            user_id?: number;
            first_name?: string;
            last_name?: string;
          };
        }
      | undefined
  )?.contact;
  if (!contact?.phone_number || !ctx.from?.id) return;

  if (contact.user_id !== ctx.from.id) {
    await ctx.reply(
      bi(
        "Please share your own Telegram contact using the button. Deposits must come from your saved phone number.",
        "እባክዎ በአዝራሩ የራስዎን Telegram ኮንታክት ያጋሩ። ክፍያው ከተቀመጠው የስልክ ቁጥርዎ መመጣት አለበት።",
      ),
    );
    return;
  }

  const user = await ensureBotUser(ctx);
  if (!user) {
    await ctx.reply("I could not connect your Telegram account.");
    return;
  }

  const phoneNumber = normalizeTelebirrPhone(contact.phone_number);
  if (!phoneNumber) {
    await ctx.reply("That phone number could not be read. Please try again.");
    return;
  }

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        phoneNumber,
        phoneTelegramUserId: BigInt(ctx.from.id),
        phoneVerifiedAt: new Date(),
      },
    });
  } catch (error) {
    await ctx.reply(
      error instanceof Error && error.message.includes("Unique constraint")
        ? "That phone number is already linked to another account."
        : "Could not save that phone number. Please contact support.",
      supportKeyboard(),
    );
    return;
  }

  await prisma.botDepositSession.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      step: "AMOUNT",
      expiresAt: depositSessionExpiry(),
    },
    update: {
      step: "AMOUNT",
      amountCredits: null,
      requestedEtb: null,
      expiresAt: depositSessionExpiry(),
    },
  });

  await ctx.reply(
    bi(
      `Saved phone ending ${phoneNumber.slice(-4)}. Deposits must be sent from this Telebirr number.`,
      `በ${phoneNumber.slice(-4)} የሚያልቀው ስልክ ተቀመጠ። ክፍያዎች ከዚህ የTelebirr ቁጥር መላክ አለባቸው።`,
    ),
    Markup.removeKeyboard(),
  );
  await askForDepositAmount(ctx);
}

async function handleDepositText(ctx: Context): Promise<void> {
  if (!isPrivateChat(ctx)) return;
  const text = messageText(ctx);
  if (!text || text.startsWith("/")) return;

  const telegramId = ctx.from?.id ? BigInt(ctx.from.id) : undefined;
  if (!telegramId) return;

  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { botDepositSession: true, wallet: true },
  });
  const session = user?.botDepositSession;
  if (!user || !session) return;

  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.botDepositSession.delete({ where: { userId: user.id } });
    await ctx.reply("Deposit session expired. Tap Deposit to start again.");
    return;
  }

  if (session.step === "CONTACT") {
    await askForContact(ctx);
    return;
  }

  if (session.step === "AMOUNT") {
    const amountEtb = parseDepositEtb(text);
    if (!amountEtb) {
      await ctx.reply(
        bi(
          "Send the deposit amount as a number, for example: 1000",
          "የማስገቢያ መጠንን በቁጥር ይላኩ፣ ለምሳሌ፦ 1000",
        ),
      );
      return;
    }

    const credits = Math.round(amountEtb * env.TELEBIRR_CREDIT_PER_ETB);
    if (credits <= 0) {
      await ctx.reply("Deposit amount is too small.");
      return;
    }

    await prisma.botDepositSession.update({
      where: { userId: user.id },
      data: {
        step: "RECEIPT",
        amountCredits: credits,
        requestedEtb: amountEtb.toFixed(2),
        expiresAt: depositSessionExpiry(),
      },
    });

    await ctx.reply(
      [
        `Send ETB ${formatEtb(amountEtb)} to:`,
        `${env.TELEBIRR_DEPOSIT_RECEIVER || "Bingo Core"} ${env.TELEBIRR_DEPOSIT_PHONE}`,
        "",
        bi(
          "After payment, paste the full Telebirr message exactly as you received it.",
          "ከከፈሉ በኋላ የTelebirr መልዕክቱን እንደተቀበሉት ሙሉ በሙሉ ይለጥፉ።",
        ),
      ].join("\n"),
      Markup.removeKeyboard(),
    );
    return;
  }

  if (session.step === "RECEIPT") {
    await finishDepositFromTelebirrMessage(ctx, user, text);
  }
}

async function finishDepositFromTelebirrMessage(
  ctx: Context,
  user: {
    id: string;
    telegramId: bigint;
    phoneNumber: string | null;
    botDepositSession: {
      amountCredits: number | null;
      requestedEtb: unknown;
    } | null;
    wallet: { balance: number; locked: number } | null;
  },
  message: string,
): Promise<void> {
  const session = user.botDepositSession;
  if (!session?.amountCredits) {
    await ctx.reply("Deposit amount is missing. Tap Deposit to start again.");
    return;
  }
  if (!user.phoneNumber) {
    await askForContact(ctx);
    return;
  }

  try {
    const parsed = parseTelebirrMessage(message);
    const requestedEtb = Number(session.requestedEtb);
    if (
      Number.isFinite(requestedEtb) &&
      !moneyEquals(parsed.amountEtb, requestedEtb)
    ) {
      await ctx.reply(
        bi(
          `The Telebirr message says ETB ${formatEtb(parsed.amountEtb)}, but you entered ETB ${formatEtb(requestedEtb)}. Start again with /deposit if the amount changed.`,
          `የTelebirr መልዕክቱ ETB ${formatEtb(parsed.amountEtb)} ይላል፣ እርስዎ ግን ETB ${formatEtb(requestedEtb)} አስገብተዋል። መጠኑ ከተቀየረ /deposit ብለው እንደገና ይጀምሩ።`,
        ),
      );
      return;
    }

    const request = await createWalletRequest({
      userId: user.id,
      type: "DEPOSIT",
      amount: session.amountCredits,
      details: "Telegram bot Telebirr deposit",
      telebirrMessage: message,
      senderPhoneNumber: user.phoneNumber,
    });

    await prisma.botDepositSession.delete({ where: { userId: user.id } });
    const wallet = await prisma.wallet.findUnique({
      where: { userId: user.id },
    });

    if (request.status === "APPROVED") {
      await ctx.reply(
        [
          bi(
            `Deposit verified: +${request.amount} credits`,
            `ማስገቢያው ተረጋግጧል፦ +${request.amount} ክሬዲት`,
          ),
          bi(
            `Wallet balance: ${wallet?.balance ?? user.wallet?.balance ?? 0} credits`,
            `የWallet ቀሪ ሂሳብ፦ ${wallet?.balance ?? user.wallet?.balance ?? 0} ክሬዲት`,
          ),
        ].join("\n"),
      );
      return;
    }

    await ctx.reply(
      [
        bi("Deposit received for manual review.", "ማስገቢያው ለእጅ ማረጋገጫ ተቀብሏል።"),
        request.validationReason ?? "An admin will review it shortly.",
      ].join("\n"),
      supportKeyboard(),
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Could not read that Telebirr message.";
    const retryInstruction = message.toLowerCase().includes("receiver phone")
      ? bi(
          `Please send the payment to the exact Telebirr number shown by the bot: ${env.TELEBIRR_DEPOSIT_PHONE}.`,
          `እባክዎ ክፍያውን ቦቱ ለሚያሳየው ትክክለኛ የTelebirr ቁጥር ይላኩ፦ ${env.TELEBIRR_DEPOSIT_PHONE}`,
        )
      : bi(
          "Please paste the full Telebirr message again, including the receipt link.",
          "እባክዎ የመቀበያ ሊንኩን ጨምሮ የTelebirr መልዕክቱን ሙሉ በሙሉ እንደገና ይለጥፉ።",
        );
    await ctx.reply([message, retryInstruction].join("\n"));
  }
}

async function cancelDepositFlow(ctx: Context): Promise<void> {
  const user = await botUserByContext(ctx);
  if (!user) {
    await ctx.reply("No deposit session found.");
    return;
  }
  await prisma.botDepositSession
    .delete({ where: { userId: user.id } })
    .catch(() => undefined);
  await ctx.reply("Deposit flow cancelled.", Markup.removeKeyboard());
}

async function replyHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "Help / እገዛ",
      bi(
        "Use Play to join a room, Deposit to add Telebirr credits, Wallet to check credits, and Invite to share your referral link.",
        "Play ክፍል ለመቀላቀል፣ Deposit የTelebirr ክሬዲት ለማስገባት፣ Wallet ቀሪ ሂሳብ ለማየት፣ Invite የግብዣ ሊንክ ለማጋራት ይጠቀሙ።",
      ),
      bi(
        "Bingo claims are validated by the server and every finished match exposes a fair-play proof.",
        "የBingo ጥያቄዎች በሰርቨር ይረጋገጣሉ፣ የተጠናቀቀ ጨዋታም የፍትሃዊ ጨዋታ ማስረጃ ያሳያል።",
      ),
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

async function replyAdminHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "Admin command help",
      "/admin - open admin menu",
      "/admin_help - show this help",
      "/settings - show current Railway-driven settings",
      "/matchmaking status|pause|resume",
      "/force_room - create a room from queued players",
      "/force_start ROOMCODE - start a waiting room now",
      "/requeue_room ROOMCODE - cancel a waiting room and requeue players",
      "/kick_queue USER - remove a user from queue",
      "/credit USER AMOUNT reason - add credits",
      "/debit USER AMOUNT reason - remove credits",
      "/clear_free_credits USER reason - remove available credits not backed by deposits",
      "/approve_wallet REQUEST_ID note - approve deposit/withdraw request",
      "/reject_wallet REQUEST_ID note - reject deposit/withdraw request",
      "/ban USER reason - ban user",
      "/unban USER - unban user",
      "/broadcast message - send message to all unbanned users",
      "",
      "USER can be a Telegram numeric ID, @username, or app user ID.",
    ].join("\n"),
    adminMenuKeyboard(),
  );
}

async function replyQueueSnapshot(ctx: Context): Promise<void> {
  const queued = await prisma.publicQueueEntry.findMany({
    orderBy: { createdAt: "asc" },
    take: 15,
    include: {
      user: {
        include: { wallet: true },
      },
    },
  });

  const paused = await isMatchmakingPaused();
  await ctx.reply(
    queued.length
      ? [
          `Public queue (${paused ? "paused" : "running"})`,
          ...queued.map((entry, index) => {
            const waitSeconds = Math.max(
              0,
              Math.floor((Date.now() - entry.createdAt.getTime()) / 1000),
            );
            return `${index + 1}. ${displayUser(entry.user)} balance=${entry.user.wallet?.balance ?? 0} wait=${waitSeconds}s`;
          }),
        ].join("\n")
      : `Public queue is empty. Matchmaking is ${paused ? "paused" : "running"}.`,
    adminMenuKeyboard(),
  );
}

async function replyAdminSettings(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "Admin settings",
      `Admins from Railway: ${env.ADMIN_TELEGRAM_IDS.length}`,
      `PUBLIC_ROOM_MIN_PLAYERS=${env.PUBLIC_ROOM_MIN_PLAYERS}`,
      `PUBLIC_ROOM_MAX_SEATS=${env.PUBLIC_ROOM_MAX_SEATS}`,
      `PUBLIC_ROOM_SECONDS=${env.PUBLIC_ROOM_SECONDS}`,
      `PUBLIC_ENTRY_FEE=${env.PUBLIC_ENTRY_FEE}`,
      `DRAW_INTERVAL_MS=${env.DRAW_INTERVAL_MS}`,
      `TELEBIRR_AUTO_DEPOSIT_ENABLED=${env.TELEBIRR_AUTO_DEPOSIT_ENABLED}`,
      `TELEBIRR_RECEIPT_ALLOWED_HOSTS=${env.TELEBIRR_RECEIPT_ALLOWED_HOSTS.join(",")}`,
      `TELEBIRR_DEPOSIT_RECEIVER=${env.TELEBIRR_DEPOSIT_RECEIVER ? "configured" : "missing"}`,
      `TELEBIRR_DEPOSIT_PHONE=${env.TELEBIRR_DEPOSIT_PHONE ? "configured" : "missing"}`,
      "",
      "Change these in Railway variables, then redeploy/restart.",
      "Use ADMIN_TELEGRAM_IDS as a comma-separated list of numeric Telegram IDs.",
    ].join("\n"),
    adminMenuKeyboard(),
  );
}

async function replyMatchmakingStatus(ctx: Context): Promise<void> {
  const paused = await isMatchmakingPaused();
  const queued = await prisma.publicQueueEntry.count();
  const waitingRooms = await prisma.room.count({
    where: { type: "PUBLIC", status: { in: ["OPEN", "COUNTDOWN"] } },
  });
  const activeMatches = await prisma.match.count({
    where: { status: "ACTIVE", room: { type: "PUBLIC" } },
  });

  await ctx.reply(
    [
      "Matchmaking",
      `Status: ${paused ? "paused" : "running"}`,
      `Queued players: ${queued}`,
      `Waiting rooms: ${waitingRooms}`,
      `Active public matches: ${activeMatches}`,
    ].join("\n"),
    matchmakingKeyboard(paused),
  );
}

async function replyPendingWalletRequests(ctx: Context): Promise<void> {
  const requests = await listPendingWalletRequests();
  await ctx.reply(
    requests.length
      ? [
          "Pending wallet requests",
          ...requests.map(formatWalletRequestLine),
          "",
          "Use /approve_wallet REQUEST_ID note or /reject_wallet REQUEST_ID note.",
        ].join("\n")
      : "No pending wallet requests.",
    walletRequestsKeyboard(requests),
  );
}

async function resolveWalletRequestCommand(
  ctx: Context,
  decision: "approve" | "reject",
): Promise<void> {
  const [target, ...noteParts] = commandArgs(ctx);
  if (!target) {
    await ctx.reply(
      `Usage: /${decision}_wallet REQUEST_ID note`,
      adminMenuKeyboard(),
    );
    return;
  }

  try {
    const requestId = await resolveWalletRequestId(target);
    await resolveWalletRequest(ctx, decision, requestId, noteParts.join(" "));
  } catch (error) {
    await ctx.reply(adminError(error), adminMenuKeyboard());
  }
}

async function resolveWalletRequestCallback(
  ctx: Context,
  decision: "approve" | "reject",
  requestId: string,
): Promise<void> {
  try {
    await resolveWalletRequest(
      ctx,
      decision,
      requestId,
      "Resolved from admin menu",
    );
  } catch (error) {
    await ctx.reply(adminError(error), adminMenuKeyboard());
  }
}

async function resolveWalletRequest(
  ctx: Context,
  decision: "approve" | "reject",
  requestId: string,
  note: string,
): Promise<void> {
  const adminId = await adminActorId(ctx);
  const adminNote = note.trim() || undefined;
  if (decision === "approve") {
    const result = await approveWalletRequest({
      requestId,
      adminId,
      adminNote,
    });
    const request = await prisma.walletRequest.findUniqueOrThrow({
      where: { id: result.request.id },
      include: { user: { include: { wallet: true } } },
    });
    await notifyWalletRequestUser(request.id);
    await ctx.reply(
      `Approved ${request.type.toLowerCase()} request ${shortRequestId(request.id)} for ${displayUser(request.user)}.\nAmount: ${request.amount} credits\nBalance: ${result.wallet.balance}`,
      adminMenuKeyboard(),
    );
    return;
  }

  const request = await rejectWalletRequest({
    requestId,
    adminId,
    adminNote,
  });
  const fullRequest = await prisma.walletRequest.findUniqueOrThrow({
    where: { id: request.id },
    include: { user: { include: { wallet: true } } },
  });
  await notifyWalletRequestUser(fullRequest.id);
  await ctx.reply(
    `Rejected ${fullRequest.type.toLowerCase()} request ${shortRequestId(fullRequest.id)} for ${displayUser(fullRequest.user)}.`,
    adminMenuKeyboard(),
  );
}

async function forceRoomFromQueue(ctx: Context): Promise<void> {
  try {
    const result = await forceCreatePublicRoomFromQueue();
    await ctx.reply(
      result.roomsCreated
        ? `Created ${result.roomsCreated} room from ${result.queuedAssigned} queued player(s).`
        : "No queued players available to create a room.",
      adminMenuKeyboard(),
    );
  } catch (error) {
    await ctx.reply(adminError(error), adminMenuKeyboard());
  }
}

async function forceStartRoomCommand(ctx: Context): Promise<void> {
  const [roomCode] = commandArgs(ctx);
  if (!roomCode) {
    await ctx.reply("Usage: /force_start ROOMCODE", adminMenuKeyboard());
    return;
  }

  try {
    const room = await forceStartPublicRoom(roomCode);
    await ctx.reply(`Started room ${room.code}.`, adminMenuKeyboard());
  } catch (error) {
    await ctx.reply(adminError(error), adminMenuKeyboard());
  }
}

async function requeueRoomCommand(ctx: Context): Promise<void> {
  const [roomCode] = commandArgs(ctx);
  if (!roomCode) {
    await ctx.reply("Usage: /requeue_room ROOMCODE", adminMenuKeyboard());
    return;
  }

  try {
    const result = await requeuePublicRoom(roomCode);
    await ctx.reply(
      `Requeued room ${roomCode.toUpperCase()}. Players moved back to queue: ${result.queued}`,
      adminMenuKeyboard(),
    );
  } catch (error) {
    await ctx.reply(adminError(error), adminMenuKeyboard());
  }
}

async function matchmakingCommand(ctx: Context): Promise<void> {
  const [action] = commandArgs(ctx);
  const actorId = await adminActorId(ctx);

  if (action === "pause") {
    await setMatchmakingPaused(true, actorId);
    await ctx.reply("Matchmaking paused.", adminMenuKeyboard());
    return;
  }
  if (action === "resume") {
    await setMatchmakingPaused(false, actorId);
    const result = await tickRooms();
    await ctx.reply(
      `Matchmaking resumed.\nCreated rooms: ${result.roomsCreated}\nQueued assigned: ${result.queuedAssigned}`,
      adminMenuKeyboard(),
    );
    return;
  }

  await replyMatchmakingStatus(ctx);
}

async function adjustUserCredits(
  ctx: Context,
  direction: "credit" | "debit",
): Promise<void> {
  const [target, amountRaw, ...reasonParts] = commandArgs(ctx);
  const amount = Number(amountRaw);
  if (!target || !Number.isInteger(amount) || amount <= 0) {
    await ctx.reply(
      `Usage: /${direction} USER AMOUNT reason`,
      adminMenuKeyboard(),
    );
    return;
  }

  const reason =
    reasonParts.join(" ").trim() || `Admin ${direction} via Telegram bot`;
  try {
    const user = await findUserByAdminTarget(target);
    if (!user) throw new Error("User not found");
    const wallet = await prisma.$transaction((tx) =>
      direction === "credit"
        ? creditWallet(tx, {
            userId: user.id,
            amount,
            type: "ADMIN_ADJUSTMENT",
            description: reason,
            metadata: adminMetadata(ctx),
          })
        : debitWallet(tx, {
            userId: user.id,
            amount,
            type: "ADMIN_ADJUSTMENT",
            description: reason,
            metadata: adminMetadata(ctx),
          }),
    );

    await ctx.reply(
      `${direction === "credit" ? "Credited" : "Debited"} ${amount} credits for ${displayUser(user)}.\nBalance: ${wallet.balance}`,
      adminMenuKeyboard(),
    );
  } catch (error) {
    await ctx.reply(adminError(error), adminMenuKeyboard());
  }
}

async function clearUserNonDepositCredits(ctx: Context): Promise<void> {
  const [target, ...reasonParts] = commandArgs(ctx);
  if (!target) {
    await ctx.reply(
      "Usage: /clear_free_credits USER reason",
      adminMenuKeyboard(),
    );
    return;
  }

  const reason =
    reasonParts.join(" ").trim() ||
    "Admin cleared credits not backed by deposits";
  try {
    const user = await findUserByAdminTarget(target);
    if (!user) throw new Error("User not found");
    const actorId = await adminActorId(ctx);
    const result = await prisma.$transaction((tx) =>
      clearNonDepositCredits(tx, {
        userId: user.id,
        actorId,
        reason,
        metadata: adminMetadata(ctx),
      }),
    );

    await ctx.reply(
      [
        result.removed > 0
          ? `Cleared ${result.removed} non-deposit credits for ${displayUser(user)}.`
          : `No non-deposit credits to clear for ${displayUser(user)}.`,
        `Balance: ${result.wallet.balance}`,
        `Deposit-backed available: ${result.depositBackedAvailable}`,
        `Total deposits: ${result.totalDepositCredits}`,
        `Total debits counted: ${result.totalDebits}`,
      ].join("\n"),
      adminMenuKeyboard(),
    );
  } catch (error) {
    await ctx.reply(adminError(error), adminMenuKeyboard());
  }
}

async function setUserBan(ctx: Context, banned: boolean): Promise<void> {
  const [target, ...reasonParts] = commandArgs(ctx);
  if (!target) {
    await ctx.reply(
      `Usage: /${banned ? "ban" : "unban"} USER reason`,
      adminMenuKeyboard(),
    );
    return;
  }

  try {
    const user = await findUserByAdminTarget(target);
    if (!user) throw new Error("User not found");
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { isBanned: banned },
      include: { wallet: true },
    });
    if (banned) await removeUserFromPublicQueue(user.id);
    await prisma.auditLog.create({
      data: {
        actorId: await adminActorId(ctx),
        action: banned ? "USER_BANNED" : "USER_UNBANNED",
        target: `user:${user.id}`,
        metadata: {
          reason: reasonParts.join(" ").trim() || null,
          adminTelegramId: ctx.from?.id ?? null,
        },
      },
    });
    await ctx.reply(
      `${displayUser(updated)} is now ${banned ? "banned" : "unbanned"}.`,
      adminMenuKeyboard(),
    );
  } catch (error) {
    await ctx.reply(adminError(error), adminMenuKeyboard());
  }
}

async function kickQueuedUser(ctx: Context): Promise<void> {
  const [target] = commandArgs(ctx);
  if (!target) {
    await ctx.reply("Usage: /kick_queue USER", adminMenuKeyboard());
    return;
  }

  try {
    const user = await findUserByAdminTarget(target);
    if (!user) throw new Error("User not found");
    const result = await removeUserFromPublicQueue(user.id);
    await ctx.reply(
      result.removed
        ? `Removed ${displayUser(user)} from queue.`
        : `${displayUser(user)} was not in queue.`,
      adminMenuKeyboard(),
    );
  } catch (error) {
    await ctx.reply(adminError(error), adminMenuKeyboard());
  }
}

async function broadcastToUsers(ctx: Context): Promise<void> {
  const text = commandRemainder(ctx);
  if (!text) {
    await ctx.reply("Usage: /broadcast message", adminMenuKeyboard());
    return;
  }

  const users = await prisma.user.findMany({
    where: { isBanned: false },
    select: { telegramId: true },
  });
  let sent = 0;
  let failed = 0;

  for (const user of users) {
    try {
      await bot.telegram.sendMessage(user.telegramId.toString(), text);
      sent += 1;
    } catch {
      failed += 1;
    }
  }

  await prisma.auditLog.create({
    data: {
      actorId: await adminActorId(ctx),
      action: "ADMIN_BROADCAST",
      target: "telegram:users",
      metadata: {
        adminTelegramId: ctx.from?.id ?? null,
        sent,
        failed,
      },
    },
  });

  await ctx.reply(`Broadcast complete. Sent: ${sent}. Failed: ${failed}.`);
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
      Markup.button.callback("Queue", "admin:queue"),
    ],
    [
      Markup.button.callback("Rooms", "admin:rooms"),
      Markup.button.callback("Users", "admin:users"),
    ],
    [
      Markup.button.callback("Transactions", "admin:transactions"),
      Markup.button.callback("Wallet Requests", "admin:wallet_requests"),
    ],
    [
      Markup.button.callback("Settings", "admin:settings"),
      Markup.button.callback("Force Queue Room", "admin:force_room"),
    ],
    [Markup.button.callback("Run Room Tick", "admin:tick")],
    [
      Markup.button.callback("Matchmaking", "admin:matchmaking"),
      Markup.button.callback("Pin Public Menu", "admin:pin_menu"),
    ],
    [Markup.button.callback("Command Help", "admin:help")],
    [Markup.button.webApp("Open Game", miniAppUrl())],
  ]);
}

function walletRequestsKeyboard(requests: PendingWalletRequest[]) {
  const rows = requests
    .slice(0, 8)
    .map((request) => [
      Markup.button.callback(
        `Approve ${shortRequestId(request.id)}`,
        `admin:wallet_approve:${request.id}`,
      ),
      Markup.button.callback(
        `Reject ${shortRequestId(request.id)}`,
        `admin:wallet_reject:${request.id}`,
      ),
    ]);
  rows.push([Markup.button.callback("Back", "admin:menu")]);
  return Markup.inlineKeyboard(rows);
}

function matchmakingKeyboard(paused: boolean) {
  return Markup.inlineKeyboard([
    [
      paused
        ? Markup.button.callback(
            "Resume Matchmaking",
            "admin:resume_matchmaking",
          )
        : Markup.button.callback(
            "Pause Matchmaking",
            "admin:pause_matchmaking",
          ),
    ],
    [
      Markup.button.callback("Queue", "admin:queue"),
      Markup.button.callback("Force Queue Room", "admin:force_room"),
    ],
    [Markup.button.callback("Back", "admin:menu")],
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

function walletInstruction(configured: string, fallback: string): string {
  return configured.trim() || fallback;
}

function supportContactUrl(): string | undefined {
  const contact = env.SUPPORT_CONTACT.trim();
  if (!contact) return undefined;
  if (/^https?:\/\//i.test(contact)) return contact;
  if (contact.startsWith("@")) return `https://t.me/${contact.slice(1)}`;
  if (/^[a-zA-Z0-9_]{5,32}$/.test(contact)) return `https://t.me/${contact}`;
  return undefined;
}

function bi(english: string, amharic: string): string {
  return `${english}\n${amharic}`;
}

async function askForContact(ctx: Context): Promise<void> {
  await ctx.reply(
    bi(
      "Share your Telegram contact first. Deposits must be sent from this same Telebirr phone number.",
      "መጀመሪያ የTelegram ኮንታክትዎን ያጋሩ። ክፍያዎች ከዚህ የTelebirr ስልክ ቁጥር መላክ አለባቸው።",
    ),
    Markup.keyboard([
      [Markup.button.contactRequest("Share phone / ስልክ አጋራ")],
    ]).resize(),
  );
}

async function askForDepositAmount(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      bi(
        "Send the Telebirr deposit amount in ETB.",
        "የTelebirr ማስገቢያ መጠንን በETB ይላኩ።",
      ),
      bi(
        `Credit rate: 1 ETB = ${env.TELEBIRR_CREDIT_PER_ETB} credit(s).`,
        `የክሬዲት ሬት፦ 1 ETB = ${env.TELEBIRR_CREDIT_PER_ETB} ክሬዲት።`,
      ),
    ].join("\n"),
    Markup.removeKeyboard(),
  );
}

async function ensureBotUser(ctx: Context) {
  if (!ctx.from?.id) return null;
  return upsertTelegramUser({
    id: ctx.from.id,
    username: ctx.from.username,
    first_name: ctx.from.first_name,
    last_name: ctx.from.last_name,
  });
}

async function botUserByContext(ctx: Context) {
  const telegramId = ctx.from?.id ? BigInt(ctx.from.id) : undefined;
  if (!telegramId) return null;
  return prisma.user.findUnique({ where: { telegramId } });
}

function depositSessionExpiry(): Date {
  return new Date(Date.now() + DEPOSIT_SESSION_MS);
}

function parseDepositEtb(value: string): number | null {
  const match = value.replace(/,/g, "").match(/([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!match?.[1]) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function formatEtb(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function isAdminContext(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return false;
  if (isConfiguredAdminTelegramId(telegramId)) {
    await prisma.user
      .update({
        where: { telegramId: BigInt(telegramId) },
        data: { isAdmin: true },
      })
      .catch(() => undefined);
    return true;
  }
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

async function requireAdminMessage(ctx: Context): Promise<boolean> {
  if (!isPrivateChat(ctx)) {
    await ctx.reply(
      "Admin tools are available in a private chat with the bot.",
    );
    return false;
  }
  if (await isAdminContext(ctx)) return true;
  await ctx.reply("Admin only.");
  return false;
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

async function adminActorId(ctx: Context): Promise<string | undefined> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return undefined;
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true },
  });
  return user?.id;
}

function commandArgs(ctx: Context): string[] {
  const text = messageText(ctx).trim();
  if (!text) return [];
  return text.split(/\s+/).slice(1);
}

function commandRemainder(ctx: Context): string {
  return messageText(ctx)
    .replace(/^\/[^\s]+(?:\s+)?/, "")
    .trim();
}

function messageText(ctx: Context): string {
  return (ctx.message as { text?: string } | undefined)?.text ?? "";
}

function adminMetadata(ctx: Context) {
  return {
    source: "telegram_admin_bot",
    adminTelegramId: ctx.from?.id ?? null,
  };
}

async function findUserByAdminTarget(target: string) {
  const value = target.trim();
  if (!value) return null;

  if (value.startsWith("@")) {
    return prisma.user.findFirst({
      where: { username: value.slice(1) },
      include: { wallet: true },
    });
  }

  if (/^-?\d+$/.test(value)) {
    return prisma.user.findUnique({
      where: { telegramId: BigInt(value) },
      include: { wallet: true },
    });
  }

  return prisma.user.findUnique({
    where: { id: value },
    include: { wallet: true },
  });
}

async function resolveWalletRequestId(target: string): Promise<string> {
  const value = target.trim().replace(/^#/, "");
  if (!value) throw new Error("Wallet request ID is required");

  const exact = await prisma.walletRequest.findUnique({
    where: { id: value },
    select: { id: true },
  });
  if (exact) return exact.id;

  const matches = await prisma.walletRequest.findMany({
    where: { id: { startsWith: value } },
    select: { id: true },
    take: 2,
  });
  if (matches.length === 1 && matches[0]) return matches[0].id;
  if (matches.length > 1) throw new Error("Wallet request ID is ambiguous");
  throw new Error("Wallet request not found");
}

async function notifyWalletRequestUser(requestId: string): Promise<void> {
  const request = await prisma.walletRequest.findUnique({
    where: { id: requestId },
    include: {
      user: { select: { telegramId: true } },
    },
  });
  if (!request) return;

  const action = request.type === "DEPOSIT" ? "Deposit" : "Withdrawal";
  const lines = [
    `${action} request ${request.status.toLowerCase()}`,
    `Amount: ${request.amount} credits`,
  ];
  if (request.adminNote) lines.push(`Note: ${request.adminNote}`);

  await bot.telegram
    .sendMessage(request.user.telegramId.toString(), lines.join("\n"))
    .catch(() => undefined);
}

function adminError(error: unknown): string {
  return error instanceof Error ? error.message : "Admin action failed";
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
  phoneNumber?: string | null;
  isAdmin: boolean;
  isBanned: boolean;
  wallet: { balance: number; locked: number } | null;
}): string {
  const flags = [
    user.isAdmin ? "admin" : "",
    user.isBanned ? "banned" : "",
  ].filter(Boolean);
  const phone = user.phoneNumber ? ` phone=*${user.phoneNumber.slice(-4)}` : "";
  return `${displayUser(user)} wallet=${user.wallet?.balance ?? 0} locked=${user.wallet?.locked ?? 0}${phone}${flags.length ? ` (${flags.join(", ")})` : ""}`;
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

function formatWalletRequestLine(request: PendingWalletRequest): string {
  const balance = request.user.wallet?.balance ?? 0;
  const detail = request.details
    ? ` note=${truncateText(request.details, 42)}`
    : "";
  const provider = request.provider ? ` ${request.provider}` : "";
  const code = request.transactionCode
    ? ` code=${request.transactionCode}`
    : "";
  const validation = request.validationReason
    ? ` review=${truncateText(request.validationReason, 48)}`
    : "";
  const phone = request.user.phoneNumber
    ? ` phone=*${request.user.phoneNumber.slice(-4)}`
    : "";
  return `${shortRequestId(request.id)}${provider} ${request.type.toLowerCase()} ${request.amount} credits ${displayUser(request.user)} balance=${balance}${phone}${code}${validation}${detail}`;
}

function shortRequestId(requestId: string): string {
  return `#${requestId.slice(0, 8)}`;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 1)}...`
    : value;
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
