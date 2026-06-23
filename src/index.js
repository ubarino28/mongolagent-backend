"use strict";
require("dotenv").config();
const app = require("./app");
const { startDomainHealthLoop } = require("./services/domainHealth.service");
const { getPrisma } = require("./lib/db");

const PORT = process.env.PORT || 3001;

// 6 цаг өнгөрсөн CONFIRMED захиалгыг автоматаар COMPLETED болгоно
async function autoCompleteReservations() {
  try {
    const prisma = getPrisma();
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const result = await prisma.$executeRawUnsafe(`
      UPDATE "TuruuReservation"
      SET "status" = 'COMPLETED', "updatedAt" = NOW()
      WHERE "status" = 'CONFIRMED'
        AND ("date" || ' ' || "timeSlot")::timestamp < $1
    `, sixHoursAgo);
    if (result > 0) console.log(`[auto-complete] ${result} reservations → COMPLETED`);

    // TuruuAppointment-д ч ижилээр
    const result2 = await prisma.$executeRawUnsafe(`
      UPDATE "TuruuAppointment"
      SET "status" = 'COMPLETED', "updatedAt" = NOW()
      WHERE "status" = 'CONFIRMED'
        AND ("date" || ' ' || "timeSlot")::timestamp < $1
    `, sixHoursAgo);
    if (result2 > 0) console.log(`[auto-complete] ${result2} appointments → COMPLETED`);
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
});
