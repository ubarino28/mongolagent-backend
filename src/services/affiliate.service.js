"use strict";
// AFFILIATE (санал болгох) хөтөлбөрийн гол логик.
//
// Мерчант өөрийн урих кодоо клиентэд промо код шиг өгнө. Клиент тэр кодоор
// бүртгүүлж subscription төлбөл, санал болгогч мерчант тухайн клиентийн
// ЭХНИЙ 12 САРЫН төлбөрөөс 10% комисс авна.
//
// КОМИСС САРААР АЖИМ БОЛОВСОРНО (accrual). Нэг дор биш — клиент жилээр төлөөд
// буцаалт авах магадлалтай тул. Сарын job дуусах бүр идэвхтэй сарын комиссыг
// бодно; идэвхгүй/буцаалт болсон сард юу ч бодохгүй.
//
// Идемпотент: AffiliateCommission (clientId, monthIndex) unique — job хэдэн ч
// удаа ажиллавал нэг сард нэг л комисс.
const { getPrisma } = require("../lib/db");
const crypto = require("crypto");

const COMMISSION_RATE = 0.10;      // 10%
const COMMISSION_MONTHS = 12;      // эхний 12 сар
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_WITHDRAW = 50000;        // татах доод хязгаар

// Урих код үүсгэх — 6 тэмдэгтийн уншихад ойлгомжтой код (I/O/0/1 хассан).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genCode() {
  const bytes = crypto.randomBytes(6);
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

// Мерчантын урих кодыг буцаана — байхгүй бол үүсгэнэ (lazy). /affiliate-д орход дуудна.
async function ensureReferralCode(prisma, orgId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { referralCode: true } });
  if (org?.referralCode) return org.referralCode;
  // Давхардвал дахин оролдоно (@unique зөрчилд)
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = genCode();
    try {
      await prisma.organization.update({ where: { id: orgId }, data: { referralCode: code } });
      return code;
    } catch {
      const again = await prisma.organization.findUnique({ where: { id: orgId }, select: { referralCode: true } });
      if (again?.referralCode) return again.referralCode; // зэрэг хүсэлт үүсгэчихсэн бол
    }
  }
  throw new Error("Урих код үүсгэж чадсангүй");
}

// Тухайн мерчантын одоогийн боломжит баланс = нийт комисс − (төлсөн + хүлээгдэж буй payout).
// Тусдаа mutable багана хадгалахгүй — тухай бүр тооцно (race-гүй, үргэлж зөв).
async function getBalance(prisma, affiliateId) {
  const [earned, locked] = await Promise.all([
    prisma.affiliateCommission.aggregate({ where: { affiliateId }, _sum: { amount: true } }),
    prisma.affiliatePayout.aggregate({ where: { affiliateId, status: { in: ["paid", "pending"] } }, _sum: { amount: true } }),
  ]);
  const total = earned._sum.amount || 0;
  const withdrawn = locked._sum.amount || 0;
  return { total, withdrawn, available: Math.max(0, total - withdrawn) };
}

// Клиент нэг тодорхой сарын эцэст subscription идэвхтэй байсан эсэх.
// subscriptionEndsAt нь тухайн сарын төгсгөлийг хамарсан бол "төлөгдсөн" гэж үзнэ.
function wasActiveThroughMonth(referredAt, subscriptionEndsAt, monthIndex) {
  if (!subscriptionEndsAt) return false;
  const monthEnd = new Date(referredAt).getTime() + monthIndex * MONTH_MS;
  return new Date(subscriptionEndsAt).getTime() >= monthEnd;
}

// Нэг клиентийн боловсорсон бүх сарыг шалгаж, дутуу комиссыг үүсгэнэ.
// Буцаах: шинээр үүсгэсэн комиссын тоо.
async function accrueForClient(prisma, client, now = new Date()) {
  const { id: clientId, referredBy, referredAt, subscriptionEndsAt, subPerMonth } = client;
  if (!referredBy || !referredAt || !subPerMonth || subPerMonth <= 0) return 0;
  if (referredBy === clientId) return 0; // self-referral хамгаалалт

  // Санал болгогч устсан бол алгасна (бүртгэл хаасан г.м)
  const affiliate = await prisma.organization.findUnique({ where: { id: referredBy }, select: { id: true } });
  if (!affiliate) return 0;

  const elapsedMonths = Math.floor((now.getTime() - new Date(referredAt).getTime()) / MONTH_MS);
  const upto = Math.min(elapsedMonths, COMMISSION_MONTHS); // хамгийн ихдээ 12 сар
  if (upto < 1) return 0;

  const amount = Math.round(subPerMonth * COMMISSION_RATE);
  let created = 0;
  for (let monthIndex = 1; monthIndex <= upto; monthIndex++) {
    if (!wasActiveThroughMonth(referredAt, subscriptionEndsAt, monthIndex)) continue; // идэвхгүй сар — комиссгүй
    try {
      await prisma.affiliateCommission.create({
        data: { id: crypto.randomUUID(), affiliateId: referredBy, clientId, monthIndex, amount, basisAmount: subPerMonth },
      });
      created++;
    } catch {
      // (clientId, monthIndex) unique зөрчил = аль хэдийн бодсон → алгасна (идемпотент)
    }
  }
  return created;
}

// Бүх санал болгогдсон клиентийн боловсорсон комиссыг бодно (өдрийн job).
async function runAccrual(now = new Date()) {
  const prisma = getPrisma();
  const clients = await prisma.organization.findMany({
    where: { referredBy: { not: null }, referredAt: { not: null } },
    select: { id: true, referredBy: true, referredAt: true, subscriptionEndsAt: true, subPerMonth: true },
  });
  let total = 0;
  for (const c of clients) {
    try { total += await accrueForClient(prisma, c, now); }
    catch (e) { console.error(`[affiliate] accrue ${c.id}`, e.message); }
  }
  if (total) console.log(`[affiliate] ${total} шинэ комисс боловсров`);
  return total;
}

function startAffiliateAccrual(intervalMs = 24 * 60 * 60 * 1000) {
  if (process.env.AFFILIATE_DISABLED === "1") { console.log("[affiliate] disabled by env"); return null; }
  const tick = () => runAccrual().catch((e) => console.error("[affiliate]", e.message));
  const t = setInterval(tick, intervalMs);
  if (t.unref) t.unref();
  setTimeout(tick, 3 * 60 * 1000); // сервер босоод 3 минутын дараа эхэлнэ
  return t;
}

module.exports = {
  COMMISSION_RATE, COMMISSION_MONTHS, MIN_WITHDRAW,
  genCode, ensureReferralCode, getBalance,
  wasActiveThroughMonth, accrueForClient, runAccrual, startAffiliateAccrual,
};
