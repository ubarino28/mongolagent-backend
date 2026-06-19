"use strict";
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const webhookRouter = require("./routes/webhook.routes");
const adminRouter = require("./routes/admin.routes");
const authRouter = require("./routes/auth.routes");
const clientRouter = require("./routes/client.routes");

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
  } catch (e) {
    console.warn("[migration] variants column:", e.message);
  }
})();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "https://mongolagent.mn",
  "https://www.mongolagent.mn",
  "https://app.mongolagent.mn",
  "https://admin.mongolagent.mn",
  "https://mongolagent-admin.vercel.app",
  "https://mongolagent-app.vercel.app",
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, service: "mongolagent-backend", version: "2026-06-18-v3-schedule-compat" }));

app.use("/webhook", webhookRouter);
app.use("/admin", adminRouter);
app.use("/auth", authRouter);
app.use("/client", clientRouter);

module.exports = app;
