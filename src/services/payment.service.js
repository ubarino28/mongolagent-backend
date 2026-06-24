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

module.exports = { markStoreOrderPaid, applyWalletTopup };
