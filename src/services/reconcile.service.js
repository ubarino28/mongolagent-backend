"use strict";
// Төлбөрийн RECONCILIATION — webhook алдвал/орхигдвол барьж авах нөөц давхарга.
// QPay callback ирээгүй (сүлжээ тасрах, tab хаагдах г.м) тохиолдолд PENDING-д
// гацсан захиалга/цэнэглэлт/домэйнг тогтмол давтаж шалгаж, төлсөн бол биелүүлнэ.
// Бүх биелүүлэгч идемпотент тул polling/webhook-той зөрчилгүй.
const qpay = require("./qpay.service");
const subQpay = require("./subscription-qpay.service");
const { markStoreOrderPaid, applyWalletTopup } = require("./payment.service");
const { fulfillDomainOrder } = require("./domain.service");
const vdomains = require("./vercelDomains.service");
const vercel = require("./vercel.service");

function isPaid(r) {
  return r && (r.invoice_status === "PAID" || (r.count != null && r.count > 0) || r.payment_status === "PAID");
}

async function runReconciliation(prisma) {
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // сүүлийн 3 хоног
  let fixed = 0;

  // 1) Дэлгүүрийн захиалга (tenant QPay)
  try {
    const orders = await prisma.storeOrder.findMany({
      where: { qpayStatus: "PENDING", qpayInvoiceId: { not: null }, createdAt: { gte: cutoff } },
      take: 200,
    });
    for (const o of orders) {
      try { if (isPaid(await qpay.checkPayment(o.qpayInvoiceId)) && await markStoreOrderPaid(prisma, o)) fixed++; }
      catch { /* ганц алдаа бусдыг зогсоохгүй */ }
    }
  } catch (e) { console.error("[reconcile:orders]", e.message); }

  // 2) Хэтэвчийн цэнэглэлт (platform QPay)
  try {
    const txs = await prisma.webWalletTx.findMany({
      where: { qpayStatus: "PENDING", type: "topup", qpayInvoiceId: { not: null }, createdAt: { gte: cutoff } },
      take: 200,
    });
    for (const tx of txs) {
      try { if (isPaid(await subQpay.checkPayment(tx.qpayInvoiceId)) && await applyWalletTopup(prisma, tx)) fixed++; }
      catch { /* skip */ }
    }
  } catch (e) { console.error("[reconcile:wallet]", e.message); }

  // 3) Домэйн захиалга (platform QPay)
  try {
    const domains = await prisma.domainOrder.findMany({
      where: { status: "pending", qpayInvoiceId: { not: null }, createdAt: { gte: cutoff } },
      take: 100,
    });
    for (const order of domains) {
      try { if (isPaid(await subQpay.checkPayment(order.qpayInvoiceId))) { await fulfillDomainOrder(prisma, { vdomains, vercel }, order); fixed++; } }
      catch { /* skip */ }
    }
  } catch (e) { console.error("[reconcile:domain]", e.message); }

  if (fixed) console.log(`[reconcile] ${fixed} pending payment(s) reconciled`);
  return fixed;
}

function startReconciliation(prisma, intervalMs = 5 * 60 * 1000) {
  if (process.env.RECONCILE_DISABLED === "1") { console.log("[reconcile] disabled by env"); return null; }
  const tick = () => runReconciliation(prisma).catch((e) => console.error("[reconcile]", e.message));
  const t = setInterval(tick, intervalMs);
  if (t.unref) t.unref();
  setTimeout(tick, 60 * 1000); // сервер босоод 1 минутын дараа эхний удаа
  return t;
}

module.exports = { runReconciliation, startReconciliation };
