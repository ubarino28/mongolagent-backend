"use strict";
const { getPrisma } = require("./db");
const { PLAN_QUOTA } = require("./quotas");

// Тоолох загвар: 1 үйлдэл = 1 мессеж (токен-суурьтай биш).
const FREE_TEST_CHAT_PER_MONTH = 100; // тест чатын сарын үнэгүй эрх
const PDF_IMPORT_COST = 5;            // PDF → KB импорт нэг удаад
const EXCEL_IMPORT_COST = 5;          // Excel → KB импорт нэг удаад
const TOPUP_KEY = "topup_remaining";  // TuruuSettings key — үлдсэн нэмэлт message credit (persistent)

// Байгууллагын эрх дууссан эсэх — subscription/trial хугацаа өнгөрсөн эсвэл status идэвхгүй бол true.
// Ийм үед токен зарцуулах бүх үйлдлийг (AI хариу, тест чат, import) блоклоно.
function isOrgExpired(org) {
  if (!org) return false;
  if (org.status && org.status !== "active") return true;
  if (org.subscriptionEndsAt && new Date(org.subscriptionEndsAt) < new Date()) return true;
  return false;
}

// Үлдсэн нэмэлт message (top-up) credit — TuruuSettings-д persistent хадгална (schema өөрчлөхгүй).
// Сар солигдоход reset ХИЙГДЭХГҮЙ — зөвхөн base quota-аас хэтэрсэн зарцуулалтаар багасна.
async function getTopupRemaining(orgId) {
  if (!orgId) return 0;
  const prisma = getPrisma();
  try {
    const row = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key: TOPUP_KEY } } });
    if (row && row.value) { const n = parseInt(row.value, 10); if (Number.isFinite(n) && n > 0) return n; }
  } catch { /* байхгүй бол 0 */ }
  return 0;
}

async function setTopupRemaining(orgId, n) {
  const prisma = getPrisma();
  const val = String(Math.max(0, Math.floor(n || 0)));
  await prisma.turuuSettings.upsert({
    where: { orgId_key: { orgId, key: TOPUP_KEY } },
    create: { orgId, key: TOPUP_KEY, value: val },
    update: { value: val },
  });
}

// Худалдан авсан credit нэмэх (persistent pool)
async function addTopupCredits(orgId, units) {
  if (!orgId || !units || units < 1) return 0;
  const cur = await getTopupRemaining(orgId);
  const next = cur + units;
  await setTopupRemaining(orgId, next);
  return next;
}

// Квотын мэдэгдлийг сард НЭГ Л УДАА (level тус бүр) илгээхийн тулд throttle хийнэ.
// TuruuSettings-д { month, levels: [...] } хадгална. Тухайн level энэ сард илгээгээгүй бол
// true буцааж, тэмдэглэнэ (дараагийн дуудлагад false). Сар солигдвол автоматаар reset.
async function markQuotaNotice(orgId, level) {
  if (!orgId || !level) return false;
  const prisma = getPrisma();
  const key = "quota_notice";
  const now = new Date();
  const month = `${now.getFullYear()}-${now.getMonth() + 1}`;
  try {
    const row = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key } } });
    let state = { month, levels: [] };
    if (row && row.value) { try { const p = JSON.parse(row.value); if (p && p.month === month && Array.isArray(p.levels)) state = p; } catch { /* reset */ } }
    if (state.levels.includes(level)) return false; // энэ сард аль хэдийн илгээсэн
    state.levels.push(level);
    await prisma.turuuSettings.upsert({
      where: { orgId_key: { orgId, key } },
      create: { orgId, key, value: JSON.stringify(state) },
      update: { value: JSON.stringify(state) },
    });
    return true;
  } catch { return false; }
}

// Байгууллагын одоогийн квотын төлөв — base + topup, хатуу хориг (100%) эсэх.
// effectiveQuota = PLAN_QUOTA[plan] + topupRemaining. exhausted=true бол шинэ message-ийг блоклоно.
async function getQuotaStatus(orgId) {
  if (!orgId) return null;
  const prisma = getPrisma();
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { plan: true, messageUsed: true, subscriptionEndsAt: true, status: true },
  });
  if (!org) return null;
  const base = PLAN_QUOTA[org.plan] || 10000;
  const topup = await getTopupRemaining(orgId);
  const used = org.messageUsed || 0;
  const effectiveQuota = base + topup;
  return {
    plan: org.plan, base, topup, used, effectiveQuota,
    remaining: Math.max(0, effectiveQuota - used),
    exhausted: used >= effectiveQuota,
    expired: isOrgExpired(org),
  };
}

// messageUsed-д units нэмэх — atomic, сар бүр reset (ai.service.incrementMessageUsed-тэй ижил логик).
// Сарын reset дээр өнгөрсөн мөчлөгт base-ээс хэтэрч ЗАРЦУУЛСАН topup credit-ийг persistent pool-оос хасна
// → нэг удаа авсан topup дараа сар дахин "бэлэглэгдэхгүй", гэхдээ ашиглаагүй үлдэгдэл хадгалагдана.
async function incrementMessageUsedBy(orgId, units) {
  if (!orgId || !units || units < 1) return;
  const prisma = getPrisma();
  try {
    const now = new Date();
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // reset хугацаа болсон эсэхийг мэдэхийн тулд одоогийн төлөвийг уншина (topup reconcile-д хэрэгтэй)
    const org = await prisma.organization.findUnique({
      where: { id: orgId }, select: { plan: true, messageUsed: true, quotaResetAt: true },
    });
    const due = !org || !org.quotaResetAt || new Date(org.quotaResetAt) <= now;

    if (due) {
      const base = PLAN_QUOTA[org && org.plan] || 10000;
      const consumedTopup = Math.max(0, (org ? org.messageUsed || 0 : 0) - base); // өнгөрсөн мөчлөгт topup-аас идсэн
      // ATOMIC: зөвхөн НЭГ зэрэгцээ хүсэлт reset хийнэ (count=1); бусад нь энгийн increment уруу унана.
      const reset = await prisma.organization.updateMany({
        where: { id: orgId, OR: [{ quotaResetAt: null }, { quotaResetAt: { lte: now } }] },
        data: { messageUsed: units, quotaResetAt: nextReset },
      });
      if (reset.count === 1) {
        if (consumedTopup > 0) {
          const rem = await getTopupRemaining(orgId);
          await setTopupRemaining(orgId, Math.max(0, rem - consumedTopup)); // ашиглагдсан topup-ыг хасна
        }
        return;
      }
      // reset-ийг өөр хүсэлт хийчихсэн — энгийн increment
    }
    await prisma.organization.update({ where: { id: orgId }, data: { messageUsed: { increment: units } } });
  } catch (e) { console.error("[quota] incrementMessageUsedBy:", e.message); }
}

// Тест чатын сарын хэрэглээг 1-ээр нэмэгдүүлж, үнэгүй эрхэнд багтаж буй эсэхийг буцаана.
// TuruuSettings-д хадгална (schema өөрчлөхгүй). Сар солигдвол автоматаар reset.
async function bumpTestChatUsage(orgId) {
  const prisma = getPrisma();
  const key = "test_chat_usage";
  const now = new Date();
  const month = `${now.getFullYear()}-${now.getMonth() + 1}`;
  let usage = { month, count: 0 };
  try {
    const row = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key } } });
    if (row) { try { const p = JSON.parse(row.value); if (p && p.month) usage = p; } catch { /* буруу бол reset */ } }
    if (usage.month !== month) usage = { month, count: 0 };
    usage.count += 1;
    await prisma.turuuSettings.upsert({
      where: { orgId_key: { orgId, key } },
      create: { orgId, key, value: JSON.stringify(usage) },
      update: { value: JSON.stringify(usage) },
    });
  } catch (e) { console.error("[quota] bumpTestChatUsage:", e.message); }
  return { count: usage.count, free: usage.count <= FREE_TEST_CHAT_PER_MONTH };
}

module.exports = {
  FREE_TEST_CHAT_PER_MONTH, PDF_IMPORT_COST, EXCEL_IMPORT_COST, TOPUP_KEY,
  incrementMessageUsedBy, bumpTestChatUsage, isOrgExpired,
  getTopupRemaining, setTopupRemaining, addTopupCredits, getQuotaStatus, markQuotaNotice,
};
