"use strict";
const { decrementStockForOrder } = require("./stock.service");
const { PLAN_PERIOD_PRICE, PERIOD_MONTHS } = require("../lib/planPricing");
const storeSync = require("./storeSync.service");
const qpay = require("./qpay.service");
const cache = require("../lib/cache");

// QPay-ийн check/callback хариунаас бодит төлсөн дүн хүлээгдсэн дүнд хүрсэн эсэх.
// paid_amount тодорхойгүй (хуучин/өөр формат) бол блоклохгүй — статусаар шийднэ (false-negative-аас сэргийлнэ).
// ЧУХАЛ: webhook, polling, reconcile ГУРВУУЛАА markStoreOrderPaid-аар дамждаг тул энэ шалгалт
// нэг л газар (доор) хийгдэнэ — өмнө зөвхөн webhook шалгаж, polling/reconcile алгасдаг байсан
// тул дутуу төлбөр бүтэн PAID болдог нүх байв.
function paidEnough(result, expected) {
  const exp = Number(expected);
  if (!exp || exp <= 0) return true;
  const paid = Number(result?.paid_amount);
  if (!Number.isFinite(paid) || paid <= 0) return true;
  return paid + 1 >= exp; // 1₮ бөөрөнхийллийн зөрүү тэвчинэ
}

// Купоны нөөцлөлтийг суллах (захиалга цуцлагдах/хугацаа дуусахад). 0-оос доош болгохгүй.
async function releaseDiscount(prisma, storeId, code) {
  if (!storeId || !code) return;
  await prisma.discount.updateMany({
    where: { storeId, code, usedCount: { gt: 0 } },
    data: { usedCount: { decrement: 1 } },
  }).catch(() => {});
}

// Захиалгыг ИДЕМПОТЕНТоор PAID болгоно.
// updateMany нь зөвхөн PENDING→PAID шилжилтийг хийсэн ганц хүсэлтэд count=1 буцаана,
// тиймээс polling + webhook зэрэг ажиллавал ч нөөц зөвхөн НЭГ УДАА хасагдана.
// result дамжуулбал (webhook/polling/reconcile бүгд дамжуулна): (1) invoice_status PAID эсэх,
// (2) төлсөн дүн хүрэлцсэн эсэх (paidEnough) хоёрыг НЭГ л газар шалгана.
async function markStoreOrderPaid(prisma, order, result) {
  // Дүн + статус баталгаажуулалт
  if (result) {
    const statusOk = result.invoice_status === "PAID" || result.payment_status === "PAID";
    if (!statusOk) return false;
    if (!paidEnough(result, order.totalAmount)) {
      console.warn(`[store paid] Order ${order.id} underpaid — paid=${result.paid_amount}, expected=${order.totalAmount}`);
      return false;
    }
  }

  // Идемпотент + ЦУЦЛАГДСАН/БУЦААГДСАН захиалгыг дахин PAID болгохгүй.
  // (өмнө зөвхөн qpayStatus шалгадаг байсан тул цуцалсан захиалгын амьд QR-ыг хожим
  //  уншуулбал CANCELLED→PAID болж, нөөц хасаж, орлого бүртгэдэг нүх байв.)
  const r = await prisma.storeOrder.updateMany({
    where: { id: order.id, qpayStatus: { not: "PAID" }, status: { notIn: ["CANCELLED", "REFUNDED"] } },
    data: { qpayStatus: "PAID", status: "PAID" },
  });
  if (r.count !== 1) return false; // өөр хүсэлт аль хэдийн PAID болгосон / цуцлагдсан — давтахгүй
  cache.invalidateOrg(order.orgId); // вэбсайт/QPay төлбөр → тайлан/dashboard шинэчлэгдэнэ

  // Нөөц хасах — зөвхөн анхны шилжилтэд. Product.stock-оос хасаад, дараа нь холбогдсон
  // мэдлэгийн сан (KB)-гийн variant нөөцийг ч хасаж, AI-ийн мэдэх нөөцтэй уялдуулна.
  await decrementStockForOrder(prisma, order).catch(() => {});
  await storeSync.decrementKnowledgeForStoreOrder(order.orgId, order.items).catch(() => {});

  // Купоны ашиглалт нь CHECKOUT дээр АЛЬ ХЭДИЙН атомикаар нөөцлөгдсөн (энд дахин нэмэхгүй) —
  // ингэснээр maxUses хязгаартай купоныг зэрэг захиалгууд хэтрүүлэн ашиглах боломжгүй.
  return true;
}

// Төлөгдөөгүй захиалгыг цуцалж, амьд QPay invoice-г хүчингүй болгож, купоны нөөцлөлтийг суллана.
// Мерчант гараар цуцлах болон reconcile-ийн хуучирсан PENDING цэвэрлэгээ ХОЁУЛАА үүнийг дуудна.
// PAID захиалгыг хөндөхгүй (буцаалт тусдаа урсгал).
async function cancelStoreOrder(prisma, order) {
  if (order.qpayStatus === "PAID" || order.status === "PAID") return false;
  const r = await prisma.storeOrder.updateMany({
    where: { id: order.id, qpayStatus: { not: "PAID" }, status: { notIn: ["CANCELLED", "REFUNDED"] } },
    data: { status: "CANCELLED", qpayStatus: "CANCELLED" },
  });
  if (r.count !== 1) return false; // аль хэдийн цуцлагдсан/төлөгдсөн — давхар суллахгүй
  if (order.qpayInvoiceId) { try { await qpay.cancelInvoice(order.qpayInvoiceId); } catch { /* DB-д CANCELLED хангалттай */ } }
  if (order.discountCode && order.storeId) await releaseDiscount(prisma, order.storeId, order.discountCode);
  cache.invalidateOrg(order.orgId);
  return true;
}

// Хэтэвчийн цэнэглэлийг ИДЕМПОТЕНТоор хэрэгжүүлнэ.
// Зөвхөн PENDING→PAID шилжилт хийсэн ганц хүсэлт count=1 авч, тэр л balance нэмнэ.
// → polling + webhook давхар ажиллавал ч хэтэвч НЭГ Л УДАА цэнэглэгдэнэ.
async function applyWalletTopup(prisma, tx, result) {
  // Дүн баталгаажуулалт — webhook/polling/reconcile бүх зам энд дамжина (өмнө reconcile нь
  // дүн шалгалгүй дутуу төлбөрийг credit болгодог байв).
  if (result && !paidEnough(result, tx.amount)) {
    console.warn(`[wallet] tx ${tx.id} underpaid — paid=${result.paid_amount}, expected=${tx.amount}`);
    return false;
  }
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
async function applySubscriptionPayment(prisma, org, result) {
  if (!org?.id || !org.subInvoiceId) return { applied: false, subscriptionEndsAt: null };

  // Хүлээгдэж буй план + хугацаа (сар) + дүн — /billing/pay-д TuruuSettings-д хадгалсан. Байхгүй бол 1 сар.
  let months = 1, newPlan = null, expectedAmount = 0;
  try {
    const s = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId: org.id, key: "pending_subscription" } } });
    if (s && s.value) { const p = JSON.parse(s.value); if (p.months > 0) months = p.months; if (p.plan) newPlan = p.plan; if (p.amount > 0) expectedAmount = p.amount; }
  } catch { /* default 1 сар */ }

  // Дүн баталгаажуулалт — subscription бол хамгийн үнэ цэнэтэй объект атлаа өмнө ГУРВАН
  // замын нэг ч дүн шалгадаггүй байв (webhook/polling/reconcile). Одоо энд нэг л удаа шалгана.
  if (result && expectedAmount > 0 && !paidEnough(result, expectedAmount)) {
    console.warn(`[sub] org ${org.id} underpaid — paid=${result.paid_amount}, expected=${expectedAmount}`);
    return { applied: false, subscriptionEndsAt: null };
  }

  const now = new Date();
  const base = org.subscriptionEndsAt && new Date(org.subscriptionEndsAt) > now
    ? new Date(org.subscriptionEndsAt)
    : now;
  const subscriptionEndsAt = new Date(base.getTime() + months * 30 * 24 * 60 * 60 * 1000);

  // Зөвхөн ЭНЭ invoice-ийг боловсруулсан ганц хүсэлт count=1 авна.
  // subInvoiceId=null болгосноор зэрэг ирсэн webhook+polling давхар нэмэхээс сэргийлнэ.
  // subMonthsPaid += months — affiliate accrual-ийн НАЙДВАРТАЙ суурь (атомик, best-effort биш).
  const data = { subQpayStatus: "PAID", subscriptionEndsAt, status: "active", subInvoiceId: null, subMonthsPaid: { increment: months } };
  if (newPlan) data.plan = newPlan; // төлсөн план руу шилжинэ
  const r = await prisma.organization.updateMany({
    where: { id: org.id, subInvoiceId: org.subInvoiceId, subQpayStatus: { not: "PAID" } },
    data,
  });
  if (r.count === 1) {
    try { await prisma.turuuSettings.delete({ where: { orgId_key: { orgId: org.id, key: "pending_subscription" } } }); } catch { /* no-op */ }
    // Санхүүгийн тайланд "манайд төлсөн зардал"-ыг автоматаар гаргахын тулд бодит төлбөрийг бүртгэнэ —
    // perMonth нь тухайн хугацааны ХЯМДРАЛТАЙ сарын үнэ (жилээр төлсөн бол жилийн хямдралтай үнэ).
    try {
      const finalPlan = newPlan || (await prisma.organization.findUnique({ where: { id: org.id }, select: { plan: true } }))?.plan || "starter";
      const periodKey = Object.keys(PERIOD_MONTHS).find((k) => PERIOD_MONTHS[k] === months) || "monthly";
      const perMonth = PLAN_PERIOD_PRICE[finalPlan]?.[periodKey] ?? PLAN_PERIOD_PRICE[finalPlan]?.monthly ?? 0;
      await prisma.auditLog.create({
        data: { orgId: org.id, actor: "system", role: "system", action: "subscription.paid", target: finalPlan,
          meta: { plan: finalPlan, months, period: periodKey, perMonth, totalPaid: perMonth * months } },
      });
    } catch { /* тайлангийн бүртгэл — үндсэн урсгалд нөлөөлөхгүй */ }

    // Affiliate: комиссын суурь болох эффектив сарын үнийг тэмдэглэнэ. Мөн энэ нь
    // санал болгогдсон клиентийн АНХНЫ төлбөр бол referredAt-ыг тавьж 12 сарын
    // цонхыг эхлүүлнэ (комисс зөвхөн ТӨЛБӨР ТӨЛӨГДСӨН үед эхэлдэг).
    try {
      const finalPlan = newPlan || (await prisma.organization.findUnique({ where: { id: org.id }, select: { plan: true } }))?.plan || "starter";
      const periodKey = Object.keys(PERIOD_MONTHS).find((k) => PERIOD_MONTHS[k] === months) || "monthly";
      const perMonth = PLAN_PERIOD_PRICE[finalPlan]?.[periodKey] ?? PLAN_PERIOD_PRICE[finalPlan]?.monthly ?? 0;
      const cur = await prisma.organization.findUnique({ where: { id: org.id }, select: { referredBy: true, referredAt: true } });
      const affData = { subPerMonth: perMonth };
      // referredAt-ыг subscription-ий суурьтай ЯГ ижил `now`-оор тавина (тусдаа new Date()
      // биш) — эс тэгвэл referredAt хэдэн ms хойш унаж, accrual-ийн сарын хил (referredAt+N×30д)
      // subscriptionEndsAt-аас эпсилоноор давж, комисс бодогдохгүй болно.
      if (cur?.referredBy && !cur.referredAt && cur.referredBy !== org.id) affData.referredAt = now;
      await prisma.organization.update({ where: { id: org.id }, data: affData });
    } catch { /* affiliate тэмдэглэл — үндсэн урсгалд нөлөөлөхгүй */ }
  }
  return { applied: r.count === 1, subscriptionEndsAt };
}

// Нэмэлт message багц (top-up) төлбөрийг ИДЕМПОТЕНТоор хэрэгжүүлж credit нэмнэ.
// pending_topup (TuruuSettings) нь { invoiceId, units } хадгална. delete-as-mutex загвараар
// зэрэг ирсэн webhook+polling давхар нэмэхээс сэргийлнэ — зөвхөн pending_topup-ыг амжилттай
// УСТГАСАН ганц хүсэлт credit нэмнэ (устгал race-д зөвхөн нэг л амжилттай болно).
async function applyTopupPayment(prisma, orgId, result) {
  if (!orgId) return { applied: false, added: 0 };

  // Хүлээгдэж буй топ-ап (units + amount)-ыг унших
  let units = 0, expectedAmount = 0;
  try {
    const s = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key: "pending_topup" } } });
    if (!s || !s.value) return { applied: false, added: 0 };
    const p = JSON.parse(s.value);
    if (p.units > 0) units = p.units;
    if (p.amount > 0) expectedAmount = p.amount;
  } catch { return { applied: false, added: 0 }; }
  if (units < 1) return { applied: false, added: 0 };

  // Дүн баталгаажуулалт — polling зам (/billing/topup/check) өмнө дүн шалгадаггүй байв.
  if (result && expectedAmount > 0 && !paidEnough(result, expectedAmount)) {
    console.warn(`[topup] org ${orgId} underpaid — paid=${result.paid_amount}, expected=${expectedAmount}`);
    return { applied: false, added: 0 };
  }

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

  // Санхүүгийн тайланд "token/мессежийн нэмэлт зардал"-ыг автоматаар гаргахын тулд бүртгэнэ.
  try {
    const { MESSAGE_TOPUP } = require("../lib/planPricing");
    const amount = MESSAGE_TOPUP[units] || 0;
    await prisma.auditLog.create({
      data: { orgId, actor: "system", role: "system", action: "topup.paid", target: String(units), meta: { units, amount } },
    });
  } catch { /* тайлангийн бүртгэл — үндсэн урсгалд нөлөөлөхгүй */ }

  return { applied: true, added: units, remaining: next };
}

module.exports = { markStoreOrderPaid, cancelStoreOrder, paidEnough, releaseDiscount, applyWalletTopup, applySubscriptionPayment, applyTopupPayment };
