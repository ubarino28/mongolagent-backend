"use strict";
const { getPrisma } = require("./db");

// Тоолох загвар: 1 үйлдэл = 1 мессеж (токен-суурьтай биш).
const FREE_TEST_CHAT_PER_MONTH = 100; // тест чатын сарын үнэгүй эрх
const PDF_IMPORT_COST = 5;            // PDF → KB импорт нэг удаад
const EXCEL_IMPORT_COST = 5;          // Excel → KB импорт нэг удаад

// Байгууллагын эрх дууссан эсэх — subscription/trial хугацаа өнгөрсөн эсвэл status идэвхгүй бол true.
// Ийм үед токен зарцуулах бүх үйлдлийг (AI хариу, тест чат, import) блоклоно.
function isOrgExpired(org) {
  if (!org) return false;
  if (org.status && org.status !== "active") return true;
  if (org.subscriptionEndsAt && new Date(org.subscriptionEndsAt) < new Date()) return true;
  return false;
}

// messageUsed-д units нэмэх — atomic, сар бүр reset (ai.service.incrementMessageUsed-тэй ижил логик)
async function incrementMessageUsedBy(orgId, units) {
  if (!orgId || !units || units < 1) return;
  const prisma = getPrisma();
  try {
    const now = new Date();
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    // Хугацаа дууссан бол ЗӨВХӨН нэг зэрэгцээ хүсэлт reset хийнэ (messageUsed = units)
    const reset = await prisma.organization.updateMany({
      where: { id: orgId, OR: [{ quotaResetAt: null }, { quotaResetAt: { lte: now } }] },
      data: { messageUsed: units, quotaResetAt: nextReset },
    });
    if (reset.count === 0) {
      await prisma.organization.update({ where: { id: orgId }, data: { messageUsed: { increment: units } } });
    }
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
  FREE_TEST_CHAT_PER_MONTH, PDF_IMPORT_COST, EXCEL_IMPORT_COST,
  incrementMessageUsedBy, bumpTestChatUsage, isOrgExpired,
};
