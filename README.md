# Codex Telegram Notifier Backend

API-only backend for sending Codex plugin completion notifications to a user's Telegram chat.

The flow is:

1. A user writes to the Telegram bot and receives a `pairingCode`.
2. The user puts that code into the local Codex plugin config.
3. The plugin registers a locally generated `deviceId` and `deviceSecret`.
4. The server links that device to the Telegram chat that owns the code.
5. Future signed notifications from that device are delivered only to that Telegram chat.

## Environment

Copy `.env.example` to `.env` and fill real values:

```bash
cp .env.example .env
```

Required variables:

```env
TELEGRAM_BOT_TOKEN=telegram_bot_token
TELEGRAM_WEBHOOK_SECRET=secret_for_telegram_webhook_header
DATABASE_URL=postgresql_connection_string
CRON_SECRET=secret_for_cron_endpoint
APP_ENCRYPTION_KEY=base64_32_bytes_key
```

Generate a valid encryption key:

```bash
openssl rand -base64 32
```

## Telegram Bot Setup

1. Open Telegram and start a chat with `@BotFather`.
2. Run `/newbot`.
3. Follow BotFather's prompts and copy the bot token.
4. Put the token into `TELEGRAM_BOT_TOKEN`.

Set the webhook:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-domain.com/api/telegram/webhook",
    "secret_token": "your-telegram-webhook-secret"
  }'
```

The `secret_token` must match `TELEGRAM_WEBHOOK_SECRET`.

## Install And Run

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Useful scripts:

```bash
npm run build
npm run prisma:studio
```

`npm run prisma:migrate` runs `prisma migrate dev` and creates/applies the PostgreSQL migration from `prisma/schema.prisma`.

## VPS Docker Deploy

This repo includes a production `docker-compose.yml` with:

- `app` - Next.js API server.
- `db` - PostgreSQL 16.
- `caddy` - HTTPS reverse proxy with automatic TLS certificates.

Before starting, point a domain or subdomain A record to the VPS IP address. Telegram webhooks require a public HTTPS URL.

On a fresh Ubuntu VPS:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and log back in so the `docker` group applies.

Open firewall ports if `ufw` is enabled:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Copy or clone the project onto the VPS, then create production env:

```bash
cp .env.production.example .env.production
```

Fill `.env.production`:

```env
DOMAIN=notify.example.com
POSTGRES_PASSWORD=replace-with-long-random-postgres-password
TELEGRAM_BOT_TOKEN=1234567890:replace-with-telegram-bot-token
TELEGRAM_WEBHOOK_SECRET=replace-with-random-webhook-secret
CRON_SECRET=replace-with-random-cron-secret
APP_ENCRYPTION_KEY=base64-encoded-32-byte-key
```

Generate strong values:

```bash
openssl rand -base64 32 # APP_ENCRYPTION_KEY
openssl rand -hex 32    # TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 32    # CRON_SECRET
openssl rand -hex 32    # POSTGRES_PASSWORD
```

Start the stack:

```bash
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production logs -f app
```

The app container runs `prisma migrate deploy` before `next start`, so production migrations are applied automatically.

Check health:

```bash
source .env.production
curl "https://$DOMAIN/api/health"
```

Set the Telegram webhook:

```bash
source .env.production
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"https://$DOMAIN/api/telegram/webhook\",
    \"secret_token\": \"$TELEGRAM_WEBHOOK_SECRET\"
  }"
```

Add hourly cron for pairing-code expiration:

```bash
source .env.production
CRON_LINE="0 * * * * curl -fsS -X POST https://$DOMAIN/api/cron/expire-pairing-codes -H 'Authorization: Bearer $CRON_SECRET' >/dev/null"
(crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
```

Useful operations:

```bash
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs -f
docker compose --env-file .env.production pull
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production down
```

## CI/CD Deploy

GitHub Actions deploys automatically after changes are merged into `main`. The workflow runs:

```bash
npm ci
npm run prisma:generate
npm run build
```

If checks pass, it connects to the VPS over SSH and runs `docker-compose.app.yml`. This keeps the external Caddy setup untouched and only rebuilds the `codex-notifier` app/db stack.

Required GitHub repository secrets:

```text
DEPLOY_HOST=147.90.9.53
DEPLOY_PORT=22
DEPLOY_USER=deploy
DEPLOY_SSH_KEY=<private SSH key for deploy user>
DEPLOY_PATH=/opt/codex-notifier
```

Prepare the VPS deploy user:

```bash
adduser deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh
nano /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /opt/codex-notifier
```

Verify commands as `deploy`:

```bash
cd /opt/codex-notifier
git fetch origin main
docker compose -p codex-notifier --env-file .env.production -f docker-compose.app.yml ps
```

If the repository remote on the VPS uses `git@github.com:...`, add an SSH key for the `deploy` user to GitHub as a repository deploy key before enabling the workflow.

The deploy job runs:

```bash
cd /opt/codex-notifier
git fetch origin main
git checkout main
git reset --hard origin/main
docker compose -p codex-notifier --env-file .env.production -f docker-compose.app.yml up -d --build --remove-orphans
curl -fsS http://127.0.0.1:${APP_HOST_PORT:-3010}/api/health
```

You can also run the workflow manually from GitHub Actions with `workflow_dispatch` after selecting the `main` branch. `.env.production` stays only on the server.

## Pairing Codes

- A `pairingCode` is created by the Telegram bot.
- It is valid for 1 month.
- It is one-time use: after device registration it becomes `USED`.
- A user can revoke only their own active codes.
- Expired active codes are changed to `EXPIRED` by the cron endpoint.
- When a code expires, the server sends a Telegram message. If delivery fails, the next cron run retries because `expirationNotifiedAt` remains empty.

Bot commands:

```text
/start - create or update Telegram user and issue a new pairingCode
/newcode - create a new pairingCode
/codes - show the last 20 pairingCodes
/revoke CODE - revoke an active pairingCode
/help - show help
```

## Register Device

Endpoint:

```http
POST /api/codex/register-device
Content-Type: application/json
```

Body:

```json
{
  "pairingCode": "ABCD-1234-EFGH",
  "deviceId": "uuid-generated-locally",
  "deviceName": "MacBook Maks",
  "deviceSecret": "random-local-secret"
}
```

The server validates the code, encrypts `deviceSecret`, links the device to the code owner, marks the code as `USED`, and sends a Telegram confirmation.

Response:

```json
{
  "ok": true,
  "deviceId": "uuid-generated-locally",
  "deviceName": "MacBook Maks"
}
```

## Send Notification

Endpoint:

```http
POST /api/codex/notify
x-codex-device-id: <deviceId>
x-codex-signature: sha256=<hmac>
x-codex-timestamp: <unix timestamp ms>
Content-Type: application/json
```

Body:

```json
{
  "deviceId": "uuid-generated-locally",
  "deviceName": "MacBook Maks",
  "projectName": "parrots-landing",
  "gitBranch": "feature/refactor",
  "codexSessionId": "session-id",
  "codexTurnId": "turn-id",
  "model": "gpt-5.5-thinking",
  "finishedAt": "2026-05-25T18:00:00.000Z",
  "message": "Codex завершил работу..."
}
```

Signature input:

```text
<timestamp>.<raw JSON body>
```

Node.js example:

```js
import crypto from "node:crypto";

const timestamp = String(Date.now());
const rawBody = JSON.stringify(body);
const signature =
  "sha256=" +
  crypto.createHmac("sha256", deviceSecret).update(`${timestamp}.${rawBody}`).digest("hex");
```

The endpoint rejects stale timestamps older than 5 minutes, revoked devices, mismatched device IDs, and invalid HMAC signatures.

Duplicate protection is based on:

```text
deviceId + codexSessionId + codexTurnId
```

When the same tuple is received again, the server returns:

```json
{
  "ok": true,
  "duplicate": true
}
```

## Expire Pairing Codes Cron

Endpoint:

```http
POST /api/cron/expire-pairing-codes
Authorization: Bearer <CRON_SECRET>
```

Run it hourly or daily from your scheduler.

Example:

```bash
curl -X POST "https://your-domain.com/api/cron/expire-pairing-codes" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Response:

```json
{
  "ok": true,
  "expiredCount": 1,
  "notifiedCount": 1,
  "failedNotificationCount": 0
}
```
