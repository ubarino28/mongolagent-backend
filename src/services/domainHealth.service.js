"use strict";
const { getPrisma } = require("../lib/db");
const vercel = require("./vercel.service");

/**
 * Домэйн эрүүл мэндийн фон шалгалт.
 *
 * Нийтлэгдсэн дэлгүүр бүрийн {slug}.mongolagent.mn-ийн SSL ажиллаж буй эсэхийг
 * тогтмол шалгаж, гацсан (гэрчилгээ гараагүй) бол автоматаар дахин үүсгэнэ.
 * Ингэснээр хэрэглэгч юу ч хийхгүйгээр домэйн өөрөө засагдана.
 */

const CHECK_INTERVAL_MS = 5 * 60 * 1000;  // 5 минут тутам
const REFIX_COOLDOWN_MS = 12 * 60 * 1000; // нэг slug-г 12 мин дотор дахин засахгүй (гэрчилгээ гарахыг хүлээнэ)
const lastFix = new Map();
let running = false;

async function runOnce() {
  if (running || !vercel.enabled()) return;
  running = true;
  try {
    const prisma = getPrisma();
    const stores = await prisma.store.findMany({ where: { status: "published" }, select: { slug: true } });
    for (const s of stores) {
      try {
        const ok = await vercel.checkSSL(s.slug);
        if (ok) { lastFix.delete(s.slug); continue; }
        const last = lastFix.get(s.slug) || 0;
        if (Date.now() - last < REFIX_COOLDOWN_MS) continue; // саяхан зассан — хүлээнэ
        console.log(`[domain-health] SSL ажиллахгүй: ${s.slug} — автоматаар дахин үүсгэж байна`);
        await vercel.reprovisionStoreDomain(s.slug).catch(() => {});
        lastFix.set(s.slug, Date.now());
      } catch (e) { /* нэг дэлгүүрийн алдаа бусдыг зогсоохгүй */ }
    }
  } catch (e) {
    console.error("[domain-health] алдаа:", e.message);
  } finally {
    running = false;
  }
}

function startDomainHealthLoop() {
  if (!vercel.enabled()) {
    console.log("[domain-health] VERCEL env алга — фон шалгалт идэвхгүй");
    return;
  }
  setTimeout(runOnce, 60 * 1000); // эхний шалгалт 60с дараа
  setInterval(runOnce, CHECK_INTERVAL_MS);
  console.log("[domain-health] фон SSL шалгалт идэвхжлээ (5 мин тутам)");
}

module.exports = { startDomainHealthLoop, runOnce };
