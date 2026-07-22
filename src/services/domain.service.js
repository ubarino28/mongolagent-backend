"use strict";

// Домэйн захиалгыг ИДЕМПОТЕНТоор биелүүлнэ.
// pending→paid шилжилтийг updateMany-гаар АТОМААР claim хийж, count===1 авсан
// ганц хүсэлт л домэйн худалдаж авна. → polling + webhook зэрэг ажиллавал ч
// registrar-т давхар төлбөр төлж домэйн ХОЁР удаа авахгүй.
async function fulfillDomainOrder(prisma, deps, order, result) {
  const { vdomains, vercel } = deps;

  // Дүн баталгаажуулалт — reconcile зам өмнө дүн шалгалгүй дутуу төлбөрөөр домэйн авдаг байв.
  const { paidEnough } = require("./payment.service");
  if (result && !paidEnough(result, order.priceMnt)) {
    console.warn(`[domain] order ${order.id} underpaid — paid=${result.paid_amount}, expected=${order.priceMnt}`);
    return { status: order.status || "pending", domain: order.domain, error: "underpaid" };
  }

  const claim = await prisma.domainOrder.updateMany({
    where: { id: order.id, status: "pending" },
    data: { status: "paid", qpayStatus: "PAID" },
  });
  if (claim.count !== 1) {
    // Өөр хүсэлт аль хэдийн авч эхэлсэн/дуусгасан — одоогийн төлвийг буцаана
    const cur = await prisma.domainOrder.findUnique({ where: { id: order.id } });
    return { status: cur?.status || order.status, domain: order.domain, error: cur?.errorMsg || undefined };
  }

  try {
    const bought = await vdomains.buy(order.domain, { expectedPrice: order.priceUsd, years: 1, renew: true });
    await vercel.addCustomDomain(order.domain).catch(() => {});
    await prisma.store.update({ where: { id: order.storeId }, data: { customDomain: order.domain } });
    await prisma.domainOrder.update({ where: { id: order.id }, data: { status: "registered", vercelOrderId: bought.orderId || bought.id || null } });
    return { status: "registered", domain: order.domain };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    await prisma.domainOrder.update({ where: { id: order.id }, data: { status: "failed", errorMsg: msg } });
    return { status: "failed", error: msg };
  }
}

module.exports = { fulfillDomainOrder };
