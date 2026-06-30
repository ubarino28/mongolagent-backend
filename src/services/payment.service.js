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
  const now = new Date();
  const base = org.subscriptionEndsAt && new Date(org.subscriptionEndsAt) > now
    ? new Date(org.subscriptionEndsAt)
    : now;
  const subscriptionEndsAt = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Зөвхөн ЭНЭ invoice-ийг боловсруулсан ганц хүсэлт count=1 авна.
  // subInvoiceId=null болгосноор зэрэг ирсэн webhook+polling давхар 30 хоног нэмэхээс сэргийлнэ.
  const r = await prisma.organization.updateMany({
    where: { id: org.id, subInvoiceId: org.subInvoiceId, subQpayStatus: { not: "PAID" } },
    data: { subQpayStatus: "PAID", subscriptionEndsAt, status: "active", subInvoiceId: null },
  });
  return { applied: r.count === 1, subscriptionEndsAt };
}

module.exports = { markStoreOrderPaid, applyWalletTopup, applySubscriptionPayment };
