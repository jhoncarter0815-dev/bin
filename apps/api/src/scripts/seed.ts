import { env } from "../config.js";
import { prisma } from "../prisma.js";

const adminTelegramId = BigInt(process.env.SEED_ADMIN_TELEGRAM_ID ?? "100000001");

const admin = await prisma.user.upsert({
  where: { telegramId: adminTelegramId },
  create: {
    telegramId: adminTelegramId,
    username: "admin",
    firstName: "Admin",
    isAdmin: true,
    wallet: { create: { balance: env.STARTING_CREDITS } }
  },
  update: { isAdmin: true },
  include: { wallet: true }
});

console.log(`Seeded admin ${admin.id} with ${admin.wallet?.balance ?? 0} credits`);
await prisma.$disconnect();

