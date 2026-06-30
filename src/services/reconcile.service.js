"use strict";
// Төлбөрийн RECONCILIATION — webhook алдвал/орхигдвол барьж авах нөөц давхарга.
// QPay callback ирээгүй (сүлжээ тасрах, tab хаагдах г.м) тохиолдолд PENDING-д
// гацсан захиалга/цэнэглэлт/домэйнг тогтмол давтаж шалгаж, төлсөн бол биелүүлнэ.
// Бүх биелүүлэгч идемпотент тул polling/webhook-той зөрчилгүй.
const qpay = require("./qpay.service");
const subQpay = require("./subscription-qpay.service");
const { markStoreOrderPaid, applyWalletTopup, applySubscriptionPayment } = require("./payment.service");
const { fulfillDomainOrder } = require("./domain.service");
const vdomains = require("./vercelDomains.service");
const vercel = require("./vercel.service");
const { captureException } = require("../lib/sentry");
const { mapLimit } = require("../lib/concurrency");

const RECONCILE_CONCURRENCY = 5; // QPay-г хэт ачаалахгүйгээр зэрэгцээ шалгана

function isPaid(r) {
  return !!(r && (r.invoice_status === "PAID" || (r.count != null && r.count > 0) || r.payment_status === "PAID"));
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
    const r = await mapLimit(orders, RECONCILE_CONCURRENCY, async (o) => {
      try { return isPaid(await qpay.checkPayment(o.qpayInvoiceId)) && await markStoreOrderPaid(prisma, o) ? 1 : 0; }
      catch (e) { console.error(`[reconcile:orders] ${o.id}`, e.message); captureException(e, { orderId: o.id, ctx: "reconcile-order" }); return 0; }
    });
    fixed += r.reduce((s, x) => s + (x === 1 ? 1 : 0), 0);
  } catch (e) { console.error("[reconcile:orders]", e.message); }

  // 2) Хэтэвчийн цэнэглэлт (platform QPay)
  try {
    const txs = await prisma.webWalletTx.findMany({
      where: { qpayStatus: "PENDING", type: "topup", qpayInvoiceId: { not: null }, createdAt: { gte: cutoff } },
      take: 200,
    });
    const r = await mapLimit(txs, RECONCILE_CONCURRENCY, async (tx) => {
      try { return isPaid(await subQpay.checkPayment(tx.qpayInvoiceId)) && await applyWalletTopup(prisma, tx) ? 1 : 0; }
      catch (e) { console.error(`[reconcile:wallet] ${tx.id}`, e.message); captureException(e, { txId: tx.id, ctx: "reconcile-wallet" }); return 0; }
    });
    fixed += r.reduce((s, x) => s + (x === 1 ? 1 : 0), 0);
  } catch (e) { console.error("[reconcile:wallet]", e.message); }

  // 3) Домэйн захиалга (platform QPay)
  try {
    const domains = await prisma.domainOrder.findMany({
      where: { status: "pending", qpayInvoiceId: { not: null }, createdAt: { gte: cutoff } },
      take: 100,
    });
    const r = await mapLimit(domains, RECONCILE_CONCURRENCY, async (order) => {
      try { if (isPaid(await subQpay.checkPayment(order.qpayInvoiceId))) { await fulfillDomainOrder(prisma, { vdomains, vercel }, order); return 1; } return 0; }
      catch (e) { console.error(`[reconcile:domain] ${order.id}`, e.message); captureException(e, { orderId: order.id, ctx: "reconcile-domain" }); return 0; }
    });
    fixed += r.reduce((s, x) => s + (x === 1 ? 1 : 0), 0);
  } catch (e) { console.error("[reconcile:domain]", e.message); }

  // 4) Subscription (platform QPay) — polling/webhook хоёулаа алдвал барих нөөц давхарга.
  //    (өмнө subscription-г reconcile огт шалгадаггүй байсан тул polling-ийн алдаатай
  //     хослоход төлсөн ч сунгагдаагүй эрх гацдаг байсан.)
  try {
    const orgs = await prisma.organization.findMany({
      where: { subQpayStatus: "PENDING", subInvoiceId: { not: null } },
      select: { id: true, subInvoiceId: true, subscriptionEndsAt: true },
      take: 200,
    });
    const r = await mapLimit(orgs, RECONCILE_CONCURRENCY, async (org) => {
      try { return isPaid(await subQpay.checkPayment(org.subInvoiceId)) && (await applySubscriptionPayment(prisma, org)).applied ? 1 : 0; }
      catch (e) { console.error(`[reconcile:sub] ${org.id}`, e.message); captureException(e, { orgId: org.id, ctx: "reconcile-sub" }); return 0; }
    });
    fixed += r.reduce((s, x) => s + (x === 1 ? 1 : 0), 0);
  } catch (e) { console.error("[reconcile:sub]", e.message); }

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

module.exports = { runReconciliation, startReconciliation, isPaid };
