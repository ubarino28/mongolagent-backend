"use strict";
require("dotenv").config();

// Sentry-г аль болох эрт эхлүүлнэ (DSN байхгүй бол no-op)
const { initSentry, captureException } = require("./lib/sentry");
initSentry();

// Аюулгүй байдал: JWT_SECRET заавал тохируулсан байх ёстой (hardcode fallback байхгүй)
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error("[FATAL] JWT_SECRET env тохируулаагүй эсвэл хэт богино (>=16 тэмдэгт). Сервер аюулгүй ажиллах боломжгүй.");
  process.exit(1);
}

const express = require("express");
const cors = require("cors");
// Бүх axios дуудлагад глобал timeout (QPay/Facebook/Telegram/Vercel) — гадны API удааширвал
// хүсэлт хязгааргүй гацахаас сэргийлнэ (axios-ийн анхдагч = timeout байхгүй).
require("axios").defaults.timeout = 20000;
const webhookRouter = require("./routes/webhook.routes");
const adminRouter = require("./routes/admin.routes");
const authRouter = require("./routes/auth.routes");
const clientRouter = require("./routes/client.routes");
const storeRouter = require("./routes/store.routes");
const storefrontRouter = require("./routes/storefront.routes");

const app = express();

// Express version-ийг ил гаргахгүй (fingerprint багасгана)
app.disable("x-powered-by");

// Аюулгүй байдлын HTTP толгойнууд (helmet хамаарал нэмэхгүйгээр гар аргаар).
// API хариунд clickjacking/MIME-sniff/HTTPS downgrade-аас сэргийлнэ.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
});

// Auto-migrate: ensure new columns exist without dropping data
const { getPrisma } = require("./lib/db");
(async () => {
  try {
    const prisma = getPrisma();
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "TuruuKnowledge" ADD COLUMN IF NOT EXISTS "variants" JSONB`
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "TuruuStaff" ADD COLUMN IF NOT EXISTS "bufferMinutes" INTEGER DEFAULT 0`
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "Organization" SET "subscriptionEndsAt" = "createdAt" + INTERVAL '30 days' WHERE "subscriptionEndsAt" IS NULL`
    );
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "TuruuMenuItem" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        "orgId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "category" TEXT,
        "description" TEXT,
        "price" DOUBLE PRECISION DEFAULT 0,
        "portions" JSONB DEFAULT '[]',
        "imageUrl" TEXT,
        "isActive" BOOLEAN DEFAULT true,
        "sortOrder" INTEGER DEFAULT 0,
        "createdAt" TIMESTAMPTZ DEFAULT now(),
        "updatedAt" TIMESTAMPTZ DEFAULT now()
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "TuruuTable" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        "orgId" TEXT NOT NULL,
        "tableNumber" INTEGER NOT NULL,
        "capacity" INTEGER DEFAULT 4,
        "isActive" BOOLEAN DEFAULT true,
        "createdAt" TIMESTAMPTZ DEFAULT now(),
        "updatedAt" TIMESTAMPTZ DEFAULT now()
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "TuruuReservation" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        "orgId" TEXT NOT NULL,
        "tableId" TEXT NOT NULL REFERENCES "TuruuTable"("id") ON DELETE CASCADE,
        "date" TEXT NOT NULL,
        "timeSlot" TEXT NOT NULL,
        "guestCount" INTEGER NOT NULL,
        "customerName" TEXT,
        "customerPhone" TEXT,
        "psid" TEXT,
        "status" TEXT DEFAULT 'PENDING',
        "notes" TEXT,
        "createdAt" TIMESTAMPTZ DEFAULT now(),
        "updatedAt" TIMESTAMPTZ DEFAULT now()
      )
    `);
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "TuruuChat" ADD COLUMN IF NOT EXISTS "aiPaused" BOOLEAN DEFAULT false`
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "TuruuChat" ADD COLUMN IF NOT EXISTS "platform" TEXT DEFAULT 'facebook'`
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "TuruuOrder" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT`
    );
    // Мэдлэгийн сан ↔ вэбсайтын бараа sync-ийн холбоос багана
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "knowledgeId" TEXT`
    );
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "Product_knowledgeId_key" ON "Product"("knowledgeId")`
    );
    // Барааны үзүүлэлт (category загвараар) — чадал/хүчдэл/материал г.м
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "TuruuKnowledge" ADD COLUMN IF NOT EXISTS "attributes" JSONB`
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "attributes" JSONB`
    );
    // Банкны тайлангийн БАТАЛГААЖУУЛАЛТ — өөрчлөшгүй snapshot. Тайлан төлбөр төлөгдөх үед
    // серверийн жинхэнэ тоог түгжиж, код/URL-ээр гуравдагч тал (банк) шалгах боломжтой болгоно.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ReportSnapshot" (
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "code" TEXT UNIQUE NOT NULL,
        "months" INTEGER NOT NULL,
        "periodLabel" TEXT,
        "bizName" TEXT,
        "verifiedRevenue" DOUBLE PRECISION DEFAULT 0,
        "selfReportedRevenue" DOUBLE PRECISION DEFAULT 0,
        "totalRevenue" DOUBLE PRECISION DEFAULT 0,
        "verifiedOrders" INTEGER DEFAULT 0,
        "totalOrders" INTEGER DEFAULT 0,
        "figures" JSONB,
        "createdAt" TIMESTAMP DEFAULT now()
      )
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReportSnapshot_orgId_idx" ON "ReportSnapshot"("orgId")`);
    // Композит index — захиалгын жагсаалт/тайлангийн гол хайлт (orgId+status+createdAt).
    // Хүснэгт одоо жижиг тул энгийн CREATE INDEX шууд ажиллана (түгжээ мэдэгдэхгүй).
    // (CONCURRENTLY нь Prisma-гийн raw query дотор ажиллахгүй; аль хэдийн асар том
    //  хүснэгтэд index нэмэх бол psql-ээр CONCURRENTLY ашиглана.)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TuruuOrder_orgId_status_createdAt_idx" ON "TuruuOrder"("orgId","status","createdAt")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StoreOrder_orgId_status_createdAt_idx" ON "StoreOrder"("orgId","status","createdAt")`);
  } catch (e) {
    console.warn("[migration]", e.message);
  }
})();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3004",
  "http://localhost:3005",
  "https://mongolagent.mn",
  "https://www.mongolagent.mn",
  "https://app.mongolagent.mn",
  "https://admin.mongolagent.mn",
  "https://website.mongolagent.mn",
  "https://mongolagent-admin.vercel.app",
  "https://mongolagent-app.vercel.app",
  "https://mongolagent-website.vercel.app",
];

// mongolagent.mn-ийн дурын subdomain (дэлгүүрүүд: slug.mongolagent.mn) зөвшөөрнө
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    if (host === "mongolagent.mn" || host.endsWith(".mongolagent.mn")) return true;
  } catch { /* буруу origin */ }
  return false;
}

app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

// Body хэмжээг хязгаарлана — асар том JSON-оор санах ой дүүргэх DoS-оос сэргийлнэ.
// rawBody-г хадгална — Facebook webhook-ийн HMAC (X-Hub-Signature-256) шалгахад хэрэгтэй.
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.get("/health", async (req, res) => {
  // DB-г бодитоор шалгана — DB унасан ч "ok" буцаах хуурамч эрүүл байдлаас сэргийлнэ.
  // 3с-ийн дотор хариу ирэхгүй бол 503 (DB гацсан гэж үзнэ).
  try {
    const prisma = getPrisma();
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error("db timeout")), 3000)),
    ]);
    res.json({ ok: true, service: "mongolagent-backend", version: "2026-06-23-v6-restaurant-always" });
  } catch {
    res.status(503).json({ ok: false, error: "db unavailable" });
  }
});

app.use("/webhook", webhookRouter);
app.use("/admin", adminRouter);
app.use("/auth", authRouter);
app.use("/client", clientRouter);
app.use("/store", storeRouter);
// Storefront нь нийтийн — custom домэйн дээрх дэлгүүрүүд ч хандах тул бүх origin зөвшөөрнө
app.use("/storefront", cors({ origin: true }), storefrontRouter);
// Тайлан баталгаажуулалт — НИЙТИЙН (auth-гүй). Банк код/URL-ээр орж жинхэнэ тоог шалгана.
app.use("/verify", cors({ origin: true }), require("./routes/verify.routes"));

// Сүүлчийн алдаа баригч — Sentry-д илгээж, цэвэр 500 буцаана
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  captureException(err, { path: req.originalUrl, method: req.method });
  console.error("[error]", req.method, req.originalUrl, "-", err.message);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: "Серверийн алдаа гарлаа" });
});

module.exports = app;
