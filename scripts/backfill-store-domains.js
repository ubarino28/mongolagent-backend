"use strict";
// Нэг удаагийн backfill — одоо нийтлэгдсэн бүх дэлгүүрийн subdomain-г Vercel-д бүртгэнэ.
// Ажиллуулахаас өмнө VERCEL_TOKEN / VERCEL_STORE_PROJECT_ID / VERCEL_TEAM_ID env тохируулсан байх ёстой.
// Жишээ: node scripts/backfill-store-domains.js
require("dotenv").config();
const { getPrisma } = require("../src/lib/db");
const vercel = require("../src/services/vercel.service");

(async () => {
  if (!vercel.enabled()) {
    console.error("❌ VERCEL_TOKEN / VERCEL_STORE_PROJECT_ID env тохируулаагүй байна.");
    process.exit(1);
  }
  const prisma = getPrisma();
  try {
    const stores = await prisma.store.findMany({ where: { status: "published" }, select: { slug: true, name: true } });
    console.log(`Нийтлэгдсэн дэлгүүр: ${stores.length}`);
    for (const s of stores) {
      const r = await vercel.addStoreDomain(s.slug);
      console.log(`  ${vercel.domainFor(s.slug)} → ${r.ok ? (r.already ? "аль хэдийн бий" : "нэмэгдлээ ✓") : "АЛДАА: " + r.error}`);
    }
    console.log("✓ Backfill дууслаа. SSL гэрчилгээ хэдэн минутын дотор үүснэ.");
  } catch (e) {
    console.error("❌", e.message); process.exitCode = 1;
  } finally { await prisma.$disconnect(); }
})();
