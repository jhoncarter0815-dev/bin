# Production Checklist

- Use real HTTPS URLs for `PUBLIC_APP_URL`, `API_URL`, and `TELEGRAM_WEBHOOK_URL`.
- Set long random values for `JWT_SECRET` and `ADMIN_SECRET`.
- Keep `ALLOW_DEV_LOGIN=false` in production.
- Use managed PostgreSQL with backups enabled, and make sure `DATABASE_URL` stays pointed at the same database across deploys.
- Keep `JWT_SECRET`, `ADMIN_SECRET`, and `TELEGRAM_BOT_TOKEN` stable across restarts.
- Run `npm run prisma:migrate` before serving traffic.
- Never run `prisma migrate reset`, `prisma:dev`, `prisma db push --force-reset`, or destructive SQL against production data.
- Confirm `/health` returns `storage: "ready"` after deploy.
- Configure Telegram webhook after deploy.
- Put the API behind a proxy with TLS and request body limits.
- Monitor process logs, 5xx rate, room start failures, and scheduler errors.
- Review `PUBLIC_ENTRY_FEE`, `MIN_PLAYERS_TO_START`, and `DRAW_INTERVAL_MS`.
- Keep this app as virtual credits only unless you add jurisdiction-specific compliance.
