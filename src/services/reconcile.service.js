"use strict";
// Төлбөрийн RECONCILIATION — webhook алдвал/орхигдвол барьж авах нөөц давхарга.
// QPay callback ирээгүй (сүлжээ тасрах, tab хаагдах г.м) тохиолдолд PENDING-д
// гацсан захиалга/цэнэглэлт/домэйнг тогтмол давтаж шалгаж, төлсөн бол биелүүлнэ.
// Бүх биелүүлэгч идемпотент тул polling/webhook-той зөрчилгүй.
const qpay = require("./qpay.service");
const subQpay = require("./subscription-qpay.service");
const { markStoreOrderPaid, cancelStoreOrder, applyWalletTopup, applySubscriptionPayment } = require("./payment.service");
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
      try {
        const chk = await qpay.checkPayment(o.qpayInvoiceId);
        // markStoreOrderPaid дотор invoice_status PAID + paidEnough(дүн) шалгагдана
        // (өмнө reconcile нь count>0 л хангалттай гэж дүн шалгалгүй PAID болгодог байв).
        if (await markStoreOrderPaid(prisma, o, chk)) return 1;
        // Төлөгдөөгүй + 24ц-аас удсан PENDING захиалга → цуцалж, амьд QPay invoice болон
        // купоны нөөцлөлтийг суллана (эс тэгвэл орхигдсон захиалга maxUses купоны слотыг үүрд барина).
        if (Date.now() - new Date(o.createdAt).getTime() > 24 * 60 * 60 * 1000) {
          await cancelStoreOrder(prisma, o).catch(() => {});
        }
        return 0;
      }
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
      try { const chk = await subQpay.checkPayment(tx.qpayInvoiceId); return isPaid(chk) && await applyWalletTopup(prisma, tx, chk) ? 1 : 0; }
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
      try { const chk = await subQpay.checkPayment(order.qpayInvoiceId); if (isPaid(chk)) { await fulfillDomainOrder(prisma, { vdomains, vercel }, order, chk); return 1; } return 0; }
      catch (e) { console.error(`[reconcile:domain] ${order.id}`, e.message); captureException(e, { orderId: order.id, ctx: "reconcile-domain" }); return 0; }
    });
    fixed += r.reduce((s, x) => s + (x === 1 ? 1 : 0), 0);
  } catch (e) { console.error("[reconcile:domain]", e.message); }

  // 3b) "paid"-д ГАЦСАН домэйн захиалга — төлбөр авсан атлаа provision дуусаагүй (крашд).
  //     Дахин худалдахгүй (registrar давхар төлбөрөөс сэргийлнэ) — эзэнд НЭГ УДАА мэдэгдэж
  //     гараар дуусгуулна. errorMsg="manual-review" тэмдэглэж давтан мэдэгдэхээс сэргийлнэ.
  try {
    const stuck = await prisma.domainOrder.findMany({
      where: { status: "paid", errorMsg: null, createdAt: { lt: new Date(Date.now() - 10 * 60 * 1000) } },
      take: 50,
    });
    for (const o of stuck) {
      await prisma.domainOrder.update({ where: { id: o.id }, data: { errorMsg: "manual-review: paid but not provisioned" } }).catch(() => {});
      try {
        require("./notify.service").notifyOwner(o.orgId, "⚠️ Домэйн бүртгэл дуусаагүй",
          { Домэйн: o.domain, Төлбөр: "төлөгдсөн", Анхаар: "Provision дуусаагүй — гараар шалгаж дуусгах шаардлагатай" },
          { label: "Домэйн харах", path: "/website/domain" }).catch(() => {});
      } catch { /* мэдэгдэл — үндсэн урсгалд нөлөөлөхгүй */ }
    }
    if (stuck.length) console.warn(`[reconcile] ${stuck.length} domain order(s) stuck in 'paid' — owner notified`);
  } catch (e) { console.error("[reconcile:domain-stuck]", e.message); }

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
      try { const chk = await subQpay.checkPayment(org.subInvoiceId); return isPaid(chk) && (await applySubscriptionPayment(prisma, org, chk)).applied ? 1 : 0; }
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
