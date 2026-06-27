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
const webhookRouter = require("./routes/webhook.routes");
const adminRouter = require("./routes/admin.routes");
const authRouter = require("./routes/auth.routes");
const clientRouter = require("./routes/client.routes");
const storeRouter = require("./routes/store.routes");
const storefrontRouter = require("./routes/storefront.routes");

const app = express();

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

app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, service: "mongolagent-backend", version: "2026-06-23-v6-restaurant-always" }));

app.use("/webhook", webhookRouter);
app.use("/admin", adminRouter);
app.use("/auth", authRouter);
app.use("/client", clientRouter);
app.use("/store", storeRouter);
// Storefront нь нийтийн — custom домэйн дээрх дэлгүүрүүд ч хандах тул бүх origin зөвшөөрнө
app.use("/storefront", cors({ origin: true }), storefrontRouter);

// Сүүлчийн алдаа баригч — Sentry-д илгээж, цэвэр 500 буцаана
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  captureException(err, { path: req.originalUrl, method: req.method });
  console.error("[error]", req.method, req.originalUrl, "-", err.message);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: "Серверийн алдаа гарлаа" });
});

module.exports = app;
