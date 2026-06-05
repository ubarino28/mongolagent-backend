# Түрүү AI — Backend

Node.js/Express backend for **Түрүү AI** — AI үйлчилгээний компани.
Facebook Messenger-тэй шууд холбогдсон AI chatbot (ManyChat ашиглахгүй).

## Live URLs

- Backend API: `https://api.mongolagent.mn` (Render дээр байрлана)
- Facebook Page: (тохируулах шаардлагатай)

## Tech Stack

| Layer | Tool |
|-------|------|
| Runtime | Node.js + Express |
| Database | PostgreSQL via Prisma (Supabase) |
| Hosting | Render.com |
| AI | OpenAI GPT-4o-mini |
| Messaging | Facebook Messenger Platform API (шууд) |
| Notifications | Telegram (lead мэдэгдэл) |

## Project Structure

```
src/
  index.js                  — Server entry point
  app.js                    — Express setup
  routes/
    webhook.routes.js       — Facebook webhook (GET verify + POST messages)
  services/
    ai.service.js           — OpenAI + tool call боловсруулалт
    facebook.service.js     — Facebook Send API (sendText, sendTypingOn)
    lead.service.js         — Lead/Consultation DB + Telegram мэдэгдэл
  lib/
    prompt.js               — AI system prompt (үйлчилгээ, үнэ, зааварчилгаа)
    history.js              — Яриа түүх (DB-д хадгалдаг)
    db.js                   — Prisma client singleton
prisma/
  schema.prisma             — TuruuChat, TuruuLead, TuruuConsultation
```

## Database Schema

### TuruuChat
Хэрэглэгч бүрийн яриа түүх (Facebook PSID-аар).
- Max 20 мессеж хадгална — хуучин мессеж автоматаар устана

### TuruuLead
AI-аас цуглуулсан potential customers.
- `status`: NEW → CONTACTED → CONSULTATION → CLOSED
- Шинэ lead ирэхэд Telegram мэдэгдэл явна

### TuruuConsultation
Consultation захиалгууд.

### PasswordResetToken
Нууц үг сэргээх token.
- `token`: crypto.randomBytes(32) — unique
- `expiresAt`: 30 минутын хугацаатай
- `used`: ашиглагдсан эсэх

## AI Chatbot

**Persona:** Аги — Түрүү AI компанийн мэргэжлийн, найрсаг туслах

**Зорилго:**
1. Үйлчилгээ танилцуулах
2. Хэрэглэгчийн хэрэгцээ ойлгох
3. Lead цуглуулах (нэр, утас/имэйл)
4. Consultation захиалах

**AI Tool Functions:**
| Function | Үүрэг |
|----------|-------|
| `save_lead` | Нэр, утас, имэйл, компани, сонирхол хадгална |
| `save_consultation` | Consultation цаг захиалга бүртгэнэ |

**Prompt засах:**
`src/lib/prompt.js` → `buildSystemPrompt()` функц дотор:
- Үйлчилгээний нэр, үнэ
- Яриа удирдах зарчим
- Жишээ яриа

## Facebook Messenger Тохиргоо

### 1. Meta Developer Portal
1. `developers.facebook.com` → "My Apps" → "Create App"
2. "Business" сонго → App нэр: "Түрүү AI"
3. Dashboard → "Add Product" → "Messenger"

### 2. Page Access Token авах
Messenger → Settings → "Generate token" (таны Facebook Page-ийг сонго)
→ `FB_PAGE_ACCESS_TOKEN` env-д нэмнэ

### 3. Webhook тохируулах
Messenger → Webhooks → "Add Callback URL":
- URL: `https://api.turuuai.mn/webhook`
- Verify Token: `.env`-ийн `FB_VERIFY_TOKEN` утга (жишээ: `turuuai_webhook_2024`)
- Subscribe: `messages`, `messaging_postbacks` сонго

### 4. Page Subscribe
Webhooks → "Add Subscriptions" → таны page сонго

## Environment Variables (Render)

| Var | Утга / Тайлбар |
|-----|---------|
| `DATABASE_URL` | `postgresql://postgres.wiutpxluvtagqlnohzmj:N3c67ABY0MzWei0m@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true` |
| `OPENAI_API_KEY` | OpenAI API key |
| `QPAY_USERNAME` | `MONGOL_AGENT` |
| `QPAY_PASSWORD` | `f1xCfoMe` |
| `QPAY_TERMINAL_ID` | QPay-аас олгосон terminal ID (заавал биш) |
| `API_URL` | `https://api.mongolagent.mn` (QPay callback-д хэрэглэнэ) |
| `RESEND_API_KEY` | `re_BjsbWghU_GFGEa413HmVwZeS4mQYcmj5o` |
| `FROM_EMAIL` | `noreply@mongolagent.mn` |
| `APP_URL` | `https://app.mongolagent.mn` |
| `FB_PAGE_ACCESS_TOKEN` | Facebook Page Access Token |
| `FB_VERIFY_TOKEN` | `turuuai_webhook_2024` |
| `TELEGRAM_BOT_TOKEN` | Lead мэдэгдлийн Telegram bot (заавал биш) |
| `TELEGRAM_CHAT_ID` | Telegram group/channel ID (заавал биш) |

> ⚠️ **Чухал:** `DATABASE_URL`-д `?pgbouncer=true` заавал байх ёстой — эс тэгвэл Supabase Transaction Pooler дээр `prepared statement already exists` алдаа гарна.
> `gZ44VooW5sl4PxUw` нь **Kitty House**-ийн нууц үг. Turuuai-ийнх: `N3c67ABY0MzWei0m`

## Supabase Projects

| Проект | Project Ref | Нууц үг | Зориулалт |
|--------|-------------|---------|-----------|
| turuuai-backend | `wiutpxluvtagqlnohzmj` | `N3c67ABY0MzWei0m` | Энэ backend |
| kittyhouse | `kmydhgtqtptguwmxxrax` | `gZ44VooW5sl4PxUw` | Kitty House demo |

## Deployment (Render)

1. GitHub-т push хийнэ → Render автоматаар deploy хийнэ
2. Build command: `npm install && npm run db:generate` (**db:push байхгүй**)
3. Start command: `npm start`

> ⚠️ `db:push`-ийг build command-д **оруулахгүй** — runtime-д authentication алдаа гарна.

### Schema өөрчлөх үед (Render Shell-ээс гараар):
```bash
DATABASE_URL="$(echo $DATABASE_URL | sed 's/:6543/:5432/g')" npx prisma db push --accept-data-loss
```

## Үйлчилгээ & Үнэ (prompt.js-д байгаа, засах боломжтой)

| Үйлчилгээ | Үнэ |
|-----------|-----|
| AI Chatbot — Starter | 500,000₮ + 100,000₮/сар |
| AI Chatbot — Business | 1,000,000₮ + 150,000₮/сар |
| AI Chatbot — Premium | 2,000,000₮+ + 250,000₮/сар |
| Бизнес автоматжуулалт | 800,000₮–2,000,000₮ |
| AI Workshop (бүлэг) | 500,000–800,000₮ |
| AI Сургалт (хувь) | 250,000₮/хүн |
| Consultation | 150,000₮/цаг |
| Monthly retainer | 500,000₮/сар |

**Үнэ өөрчлөхөд:** `src/lib/prompt.js` → ҮЙЛЧИЛГЭЭ БА ҮНЭ хэсгийг засна.

## Нэмэгдсэн API Endpoints (сүүлийн үеийн өөрчлөлт)

| Method | Path | Тайлбар |
|--------|------|---------|
| POST | `/auth/forgot-password` | Нууц үг сэргээх имэйл явуулна (Resend) |
| POST | `/auth/reset-password` | Token шалгаад нууц үг шинэчилнэ |
| POST | `/client/chat` | Client-аас шууд AI-тай харилцах (auth шаардлагатай) |

## Frontend (turuuai-app) өөрчлөлтүүд

- `/forgot-password` — имэйл оруулж reset link авах хуудас
- `/reset-password?token=...` — шинэ нууц үг тохируулах хуудас
- `/chat` — ChatGPT маягийн AI чат (org-ийн system prompt ашиглана)
- Sidebar-д "AI Чат" холбоос нэмэгдсэн

## Showcase (Kitty House)

Китти Хаус `https://kittyhouse.mn` нь Түрүү AI-ийн хийсэн жишээ бүтээл.
Potential клиентэд үзүүлэх portfolio болно.
