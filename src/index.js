"use strict";
require("dotenv").config();
const app = require("./app");
const { startDomainHealthLoop } = require("./services/domainHealth.service");
const { startReconciliation } = require("./services/reconcile.service");
const { captureException } = require("./lib/sentry");
const { getPrisma } = require("./lib/db");

// Баригдаагүй алдаануудыг Sentry-д бүртгэнэ (процессыг унагаахгүй)
process.on("unhandledRejection", (reason) => { console.error("[unhandledRejection]", reason); captureException(reason instanceof Error ? reason : new Error(String(reason))); });
process.on("uncaughtException", (err) => { console.error("[uncaughtException]", err); captureException(err); });

const PORT = process.env.PORT || 3001;

// 6 цаг өнгөрсөн CONFIRMED захиалгыг автоматаар COMPLETED болгоно
async function autoCompleteReservations() {
  try {
    const prisma = getPrisma();
    const now = new Date();

    // Ширээ захиалга: цагаас 2 цагийн дараа COMPLETED (зочид ирж суугаад явсан)
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const result = await prisma.$executeRawUnsafe(`
      UPDATE "TuruuReservation"
      SET "status" = 'COMPLETED', "updatedAt" = NOW()
      WHERE "status" = 'CONFIRMED'
        AND ("date" || ' ' || "timeSlot")::timestamp < $1
    `, twoHoursAgo);
    if (result > 0) console.log(`[auto-complete] ${result} reservations → COMPLETED`);

    // Цаг захиалга: duration + 5 минутын дараа COMPLETED
    const result2 = await prisma.$executeRawUnsafe(`
      UPDATE "TuruuAppointment"
      SET "status" = 'COMPLETED', "updatedAt" = NOW()
      WHERE "status" = 'CONFIRMED'
        AND (("date" || ' ' || "timeSlot")::timestamp + ("durationMinutes" + 5) * INTERVAL '1 minute') < $1
    `, now);
    if (result2 > 0) console.log(`[auto-complete] ${result2} appointments → COMPLETED`);

    // 48 цаг төлөгдөөгүй захиалга → CANCELLED + QPay invoice цуцлах
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const staleOrders = await prisma.turuuOrder.findMany({
      where: { status: "NEW", createdAt: { lt: twoDaysAgo } },
      select: { id: true, qpayInvoiceId: true },
    });
    for (const order of staleOrders) {
      try {
        await prisma.turuuOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
        if (order.qpayInvoiceId) {
          const { cancelInvoice } = require("./services/qpay.service");
          await cancelInvoice(order.qpayInvoiceId).catch(() => {});
        }
      } catch { /* non-blocking */ }
    }
    if (staleOrders.length > 0) console.log(`[auto-cancel] ${staleOrders.length} orders → CANCELLED`);
  } catch (e) {
    console.error("[auto-complete]", e.message);
  }
}

app.listen(PORT, () => {
  console.log(`[mongolagent] server running on port ${PORT}`);
  startDomainHealthLoop();
  // 30 минут тутамд auto-complete шалгана
  setInterval(autoCompleteReservations, 30 * 60 * 1000);
  autoCompleteReservations();
  // 5 минут тутамд төлбөрийн reconciliation (webhook алдвал барьж авах нөөц)
  startReconciliation(getPrisma());
});
