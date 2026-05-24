# Түрүү AI — Backend

Node.js/Express backend for **Түрүү AI** — AI үйлчилгээний компани.
Facebook Messenger-тэй шууд холбогдсон AI chatbot (ManyChat ашиглахгүй).

## Live URLs

- Backend API: `https://api.turuuai.mn` (Render дээр байрлана)
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

| Var | Тайлбар |
|-----|---------|
| `DATABASE_URL` | Supabase PostgreSQL (port 5432 эсвэл pooler) |
| `OPENAI_API_KEY` | OpenAI API key |
| `FB_PAGE_ACCESS_TOKEN` | Facebook Page Access Token |
| `FB_VERIFY_TOKEN` | Webhook verify token (дурын нууц үг) |
| `TELEGRAM_BOT_TOKEN` | Lead мэдэгдлийн Telegram bot (заавал биш) |
| `TELEGRAM_CHAT_ID` | Telegram group/channel ID (заавал биш) |

## Deployment (Render)

1. GitHub-т push хийнэ
2. Render → "New Web Service" → GitHub repo холбоно
3. Build command: `npm install && npm run db:generate`
4. Start command: `npm start`
5. Environment variables нэмнэ

### Schema өөрчлөх үед (Render Shell):
```bash
DATABASE_URL="$(echo $DATABASE_URL | sed 's/:6543/:5432/g')" npx prisma db push
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

## Showcase (Kitty House)

Китти Хаус `https://kittyhouse.mn` нь Түрүү AI-ийн хийсэн жишээ бүтээл.
Potential клиентэд үзүүлэх portfolio болно.
