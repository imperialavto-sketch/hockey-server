# hockey-server deploy

Deploy на VPS / Render / Railway / Fly.io. OpenAI API работает из поддерживаемых регионов.

## Required env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | production | `production` для CORS и strict mode |
| `PORT` | no | Порт (default 3000) |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `ALLOWED_ORIGINS` | production | CORS origins через запятую |
| `OPENAI_API_KEY` | for AI | OpenAI API key (Coach Mark) |
| `SMS_PROVIDER` | for SMS | `smsru` или `mock` |
| `SMS_API_KEY` | for SMS | sms.ru api_id |
| `SMS_SENDER` | no | Отправитель (опционально) |

## Install

```bash
npm ci
npx prisma generate
```

## Migrations (перед стартом)

```bash
npx prisma migrate deploy
```

## Start

```bash
npm start
```

## Healthcheck

- **Liveness:** `GET /api/health` → `{ "ok": true }`
- **DB check:** `GET /api/db/health` → `{ "ok": true, "record": {...} }`

## Verify POST /api/chat/ai/message

После deploy:

```bash
curl -X POST https://YOUR-DOMAIN/api/chat/ai/message \
  -H "Content-Type: application/json" \
  -H "x-parent-id: parent-79990001122" \
  -d '{"text":"Как улучшить бросок?"}'
```

Ожидаем: `{ "text": "...", "isAI": true }` с реальным ответом Coach Mark.

Требуется auth: Bearer token или `x-parent-id` с существующим parent.

## CORS

В production обязательно задать `ALLOWED_ORIGINS` с origin parent-app (Expo/web).
