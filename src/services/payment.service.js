"use strict";
const { decrementStockForOrder } = require("./stock.service");

// Захиалгыг ИДЕМПОТЕНТоор PAID болгоно.
// updateMany нь зөвхөн PENDING→PAID шилжилтийг хийсэн ганц хүсэлтэд count=1 буцаана,
// тиймээс polling + webhook зэрэг ажиллавал ч нөөц/купон ЗӨВХӨН НЭГ УДАА тооцогдоно.
// → давхар нөөц хасах / давхар купон тоолох алдааг арилгана.
async function markStoreOrderPaid(prisma, order) {
  const r = await prisma.storeOrder.updateMany({
    where: { id: order.id, qpayStatus: { not: "PAID" } },
    data: { qpayStatus: "PAID", status: "PAID" },
  });
  if (r.count !== 1) return false; // өөр хүсэлт аль хэдийн PAID болгосон — давтахгүй

  // Нөөц хасах — зөвхөн анхны шилжилтэд
  await decrementStockForOrder(prisma, order).catch(() => {});

  // Купоны ашиглалтыг ЗӨВХӨН ТӨЛСНИЙ ДАРАА тоолно (төлөөгүй захиалга купон иддэггүй)
  if (order.discountCode && order.storeId) {
    await prisma.discount.updateMany({
      where: { storeId: order.storeId, code: order.discountCode },
      data: { usedCount: { increment: 1 } },
    }).catch(() => {});
  }
  return true;
}

// Хэтэвчийн цэнэглэлийг ИДЕМПОТЕНТоор хэрэгжүүлнэ.
// Зөвхөн PENDING→PAID шилжилт хийсэн ганц хүсэлт count=1 авч, тэр л balance нэмнэ.
// → polling + webhook давхар ажиллавал ч хэтэвч НЭГ Л УДАА цэнэглэгдэнэ.
async function applyWalletTopup(prisma, tx) {
  const r = await prisma.webWalletTx.updateMany({
    where: { id: tx.id, qpayStatus: { not: "PAID" } },
    data: { qpayStatus: "PAID" },
  });
  if (r.count !== 1) return false;
  await prisma.webWallet.upsert({
    where: { orgId: tx.orgId },
    create: { orgId: tx.orgId, balance: tx.amount },
    update: { balance: { increment: tx.amount } },
  });
  return true;
}

// Subscription төлбөрийг ИДЕМПОТЕНТоор хэрэгжүүлж эрхийг 30 хоног сунгана.
// webhook callback болон polling-check (/billing/pay/check) ХОЁУЛАА энэ функцийг
// дуудна — ингэснээр логик хоёр тийш салахгүй (өмнө polling нь зөвхөн subQpayStatus-г
// PAID болгоод subscriptionEndsAt-г сунгахгүй, subInvoiceId-г null болгохгүй байсан тул
// polling webhook-оос түрүүлбэл эрх сунгагдахгүй гацаж, дараагийн webhook count=0 болж
// сунгалт үүрд алдагддаг байсан).
// org-д { id, subInvoiceId, subscriptionEndsAt } байх ёстой.
async function applySubscriptionPayment(prisma, org) {
  if (!org?.id || !org.subInvoiceId) return { applied: false, subscriptionEndsAt: null };

  // Хүлээгдэж буй план + хугацаа (сар) — /billing/pay-д TuruuSettings-д хадгалсан. Байхгүй бол 1 сар.
  let months = 1, newPlan = null;
  try {
    const s = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId: org.id, key: "pending_subscription" } } });
    if (s && s.value) { const p = JSON.parse(s.value); if (p.months > 0) months = p.months; if (p.plan) newPlan = p.plan; }
  } catch { /* default 1 сар */ }

  const now = new Date();
  const base = org.subscriptionEndsAt && new Date(org.subscriptionEndsAt) > now
    ? new Date(org.subscriptionEndsAt)
    : now;
  const subscriptionEndsAt = new Date(base.getTime() + months * 30 * 24 * 60 * 60 * 1000);

  // Зөвхөн ЭНЭ invoice-ийг боловсруулсан ганц хүсэлт count=1 авна.
  // subInvoiceId=null болгосноор зэрэг ирсэн webhook+polling давхар нэмэхээс сэргийлнэ.
  const data = { subQpayStatus: "PAID", subscriptionEndsAt, status: "active", subInvoiceId: null };
  if (newPlan) data.plan = newPlan; // төлсөн план руу шилжинэ
  const r = await prisma.organization.updateMany({
    where: { id: org.id, subInvoiceId: org.subInvoiceId, subQpayStatus: { not: "PAID" } },
    data,
  });
  if (r.count === 1) {
    try { await prisma.turuuSettings.delete({ where: { orgId_key: { orgId: org.id, key: "pending_subscription" } } }); } catch { /* no-op */ }
  }
  return { applied: r.count === 1, subscriptionEndsAt };
}

// Нэмэлт message багц (top-up) төлбөрийг ИДЕМПОТЕНТоор хэрэгжүүлж credit нэмнэ.
// pending_topup (TuruuSettings) нь { invoiceId, units } хадгална. delete-as-mutex загвараар
// зэрэг ирсэн webhook+polling давхар нэмэхээс сэргийлнэ — зөвхөн pending_topup-ыг амжилттай
// УСТГАСАН ганц хүсэлт credit нэмнэ (устгал race-д зөвхөн нэг л амжилттай болно).
async function applyTopupPayment(prisma, orgId) {
  if (!orgId) return { applied: false, added: 0 };

  // Хүлээгдэж буй топ-ап (units)-ыг унших
  let units = 0;
  try {
    const s = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key: "pending_topup" } } });
    if (!s || !s.value) return { applied: false, added: 0 };
    const p = JSON.parse(s.value);
    if (p.units > 0) units = p.units;
  } catch { return { applied: false, added: 0 }; }
  if (units < 1) return { applied: false, added: 0 };

  // ИДЕМПОТЕНТ mutex: pending_topup-ыг устгаж чадсан ганц хүсэлт л credit нэмнэ.
  try {
    await prisma.turuuSettings.delete({ where: { orgId_key: { orgId, key: "pending_topup" } } });
  } catch { return { applied: false, added: 0 }; } // өөр хүсэлт аль хэдийн боловсруулсан

  // Persistent credit pool-д нэмэх (topup_remaining += units)
  let cur = 0;
  try {
    const r = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key: "topup_remaining" } } });
    if (r && r.value) { const n = parseInt(r.value, 10); if (Number.isFinite(n) && n > 0) cur = n; }
  } catch { /* байхгүй бол 0 */ }
  const next = cur + units;
  await prisma.turuuSettings.upsert({
    where: { orgId_key: { orgId, key: "topup_remaining" } },
    create: { orgId, key: "topup_remaining", value: String(next) },
    update: { value: String(next) },
  });
  return { applied: true, added: units, remaining: next };
}

module.exports = { markStoreOrderPaid, applyWalletTopup, applySubscriptionPayment, applyTopupPayment };
