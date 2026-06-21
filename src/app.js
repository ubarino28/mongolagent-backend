"use strict";
require("dotenv").config();
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
  } catch (e) {
    console.warn("[migration] variants column:", e.message);
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

app.get("/health", (req, res) => res.json({ ok: true, service: "mongolagent-backend", version: "2026-06-18-v3-schedule-compat" }));

app.use("/webhook", webhookRouter);
app.use("/admin", adminRouter);
app.use("/auth", authRouter);
app.use("/client", clientRouter);
app.use("/store", storeRouter);
// Storefront нь нийтийн — custom домэйн дээрх дэлгүүрүүд ч хандах тул бүх origin зөвшөөрнө
app.use("/storefront", cors({ origin: true }), storefrontRouter);

module.exports = app;
