# Telegram Bingo Platform

A production-oriented multiplayer Bingo system for Telegram:

- Telegram bot with `/start`, `/play`, `/wallet`, webhook or polling mode.
- Telegram Mini App built with React and Vite.
- Fastify API with JWT auth from Telegram WebApp `initData`.
- Socket.IO realtime room and match updates.
- Public multiplayer rooms, practice tables, seat locking, entry fees, refunds, payouts.
- Server-side bingo validation and post-match fair-play proof.
- Prisma/PostgreSQL persistence, migrations, Docker Compose, admin endpoints.

## Stack

- `apps/api`: Fastify, Telegraf, Socket.IO, Prisma, PostgreSQL.
- `apps/mini-app`: React, Vite, Socket.IO client.
- `packages/shared`: shared cards, draw deck, win validation, DTO types.

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and fill secrets:

```bash
cp .env.example .env
```

3. Start Postgres:

```bash
docker compose up -d postgres
```

4. Apply migrations and generate Prisma:

```bash
npm run prisma:generate
npm run prisma:dev
```

5. Run the app:

```bash
npm run dev
```

The API runs on `http://localhost:8080` and the Mini App runs on `http://localhost:5173`.
When Telegram `initData` is not present, local dev uses a generated dev user if `ALLOW_DEV_LOGIN=true`.

## Telegram Setup

1. Create a bot in BotFather and set `TELEGRAM_BOT_TOKEN`.
2. Set the Mini App URL in BotFather to your HTTPS frontend URL.
3. In production set:

```env
PUBLIC_APP_URL=https://your-mini-app-domain.example
API_URL=https://your-api-domain.example
TELEGRAM_WEBHOOK_URL=https://your-api-domain.example
```

If `TELEGRAM_WEBHOOK_URL` is empty, the bot uses polling mode.

## Deploy

The included Dockerfile builds shared code, the API, and the Mini App. `docker-compose.yml` runs Postgres plus the API container. For Railway/Fly/Render:

1. Provision PostgreSQL and set `DATABASE_URL`.
2. Set all `.env.example` variables.
3. Run `npm run prisma:migrate` on release/startup.
4. Expose port `8080`.
5. Point BotFather Mini App URL to `PUBLIC_APP_URL`.

## Admin

Admin endpoints require the `x-admin-secret` header matching `ADMIN_SECRET`.
The Mini App includes an Admin tab for quick user inspection.

## Fair Play

Each match stores a private server seed and public SHA-256 seed hash. The draw order is generated from that seed. After the match finishes, the API reveals `seedReveal` through `/api/match/:id/fair`, allowing clients to recompute and verify the draw.

## Data Persistence

Users, wallet balances, transactions, seats, rooms, matches, and results are stored in PostgreSQL through Prisma. Restarting the bot/API process does not reset those records as long as `DATABASE_URL` points to the same persistent database.

- In production, use managed PostgreSQL or a database volume with backups enabled.
- Keep `JWT_SECRET`, `ADMIN_SECRET`, and `TELEGRAM_BOT_TOKEN` stable between restarts.
- Do not run `prisma migrate reset`, `prisma:dev`, or destructive database commands against production data.
- `STARTING_CREDITS` only applies when a new user is first created. Existing balances are not recalculated on login or restart.
- The `/health` endpoint checks database connectivity, and startup logs include persistent record counts.

## Commands

```bash
npm run build
npm run typecheck
npm run test
npm run lint
npm run seed
```
