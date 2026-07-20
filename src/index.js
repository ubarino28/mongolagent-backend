"use strict";
require("dotenv").config();
const app = require("./app");
const { startDomainHealthLoop } = require("./services/domainHealth.service");
const { startReconciliation } = require("./services/reconcile.service");
const { startRetention } = require("./services/retention.service");
const { startAffiliateAccrual } = require("./services/affiliate.service");
const { captureException } = require("./lib/sentry");
const { getPrisma } = require("./lib/db");

if (!process.env.SENTRY_DSN) {
  console.warn("[WARN] SENTRY_DSN тохируулаагүй — алдааны мониторинг идэвхгүй (production-д тохируулахыг зөвлөнө).");
}

// unhandledRejection — бүртгэнэ, процессыг унагаахгүй (зарим сангийн benign rejection байдаг)
process.on("unhandledRejection", (reason) => { console.error("[unhandledRejection]", reason); captureException(reason instanceof Error ? reason : new Error(String(reason))); });
// uncaughtException — төлөв эвдэрсэн гэж үзэж, бүртгээд RESTART хийнэ (zombie process-оос сэргийлнэ).
// Render автоматаар дахин асаана. Sentry flush хийх багахан зай өгнө.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  captureException(err);
  setTimeout(() => process.exit(1), 1000).unref?.();
});

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

const server = app.listen(PORT, () => {
  console.log(`[mongolagent] server running on port ${PORT}`);
  startDomainHealthLoop();
  // 30 минут тутамд auto-complete шалгана
  setInterval(autoCompleteReservations, 30 * 60 * 1000);
  autoCompleteReservations();
  // 5 минут тутамд төлбөрийн reconciliation (webhook алдвал барьж авах нөөц)
  startReconciliation(getPrisma());
  // Өдөрт нэг удаа хадгалах хугацааны бодлого. ӨГӨГДМӨЛ нь DRY-RUN (зөвхөн тоолно) —
  // жинхэнэ устгалыг RETENTION_ENABLED=1-ээр асаана.
  startRetention();
  // Өдөрт нэг удаа affiliate комиссыг боловсруулна (сар бүр аажим).
  startAffiliateAccrual();
});

// Graceful shutdown — Render deploy/restart үед холболтуудыг цэвэрхэн хаана (DB connection алдагдахаас сэргийлнэ)
async function shutdown(signal) {
  console.log(`[shutdown] ${signal} — серверийг цэвэрхэн хааж байна...`);
  server.close(() => console.log("[shutdown] HTTP сервер хаагдлаа"));
  try { await getPrisma().$disconnect(); } catch { /* no-op */ }
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
