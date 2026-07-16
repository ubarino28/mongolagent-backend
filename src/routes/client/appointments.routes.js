"use strict";
// Ажилтан / сул цаг / цаг захиалга / цаг захиалгын орлого (client.routes.js-ээс салгав).
// Auth-ийг эцэг router (client.routes.js) clientAuthMiddleware-ээр тавьсан тул req.org бэлэн.
const express = require("express");
const { getPrisma } = require("../../lib/db");

const router = express.Router();

// ─── STAFF ───────────────────────────────────────────────────────────────────

// GET /client/staff
router.get("/staff", async (req, res) => {
  try {
    const prisma = getPrisma();
    const staff = await prisma.turuuStaff.findMany({
      where: { orgId: req.org.orgId, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(staff);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/staff
router.post("/staff", async (req, res) => {
  try {
    const { name, services, workDays, workStart, workEnd, bufferMinutes } = req.body;
    if (!name) return res.status(400).json({ error: "name шаардлагатай" });
    const prisma = getPrisma();
    const staff = await prisma.turuuStaff.create({
      data: {
        orgId: req.org.orgId,
        name,
        services: services ?? [],
        workDays: workDays ?? [1, 2, 3, 4, 5],
        workStart: workStart ?? "09:00",
        workEnd:   workEnd   ?? "18:00",
        bufferMinutes: bufferMinutes ?? 0,
      },
    });
    res.json(staff);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// PUT /client/staff/:id
router.put("/staff/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.turuuStaff.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!existing) return res.status(404).json({ error: "Олдсонгүй" });
    const { name, services, workDays, workStart, workEnd, bufferMinutes, isActive } = req.body;
    const staff = await prisma.turuuStaff.update({
      where: { id: req.params.id },
      data: {
        ...(name          !== undefined && { name }),
        ...(services      !== undefined && { services }),
        ...(workDays      !== undefined && { workDays }),
        ...(workStart     !== undefined && { workStart }),
        ...(workEnd       !== undefined && { workEnd }),
        ...(bufferMinutes !== undefined && { bufferMinutes }),
        ...(isActive      !== undefined && { isActive }),
      },
    });
    res.json(staff);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// DELETE /client/staff/:id
router.delete("/staff/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.turuuStaff.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!existing) return res.status(404).json({ error: "Олдсонгүй" });
    await prisma.turuuStaff.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── AVAILABILITY ─────────────────────────────────────────────────────────────

function buildSlots(workStart, workEnd, durationMinutes) {
  const dur = Math.max(1, Number(durationMinutes) || 60);
  const [sh, sm] = workStart.split(":").map(Number);
  const [eh, em] = workEnd.split(":").map(Number);
  let cur = sh * 60 + sm;
  const end = eh * 60 + em;
  const slots = [];
  while (cur + dur <= end) {
    slots.push(`${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`);
    cur += dur;
  }
  return slots;
}

// GET /client/availability?date=2026-06-20&staffId=xxx
router.get("/availability", async (req, res) => {
  try {
    const { date, staffId } = req.query;
    if (!date || !staffId) return res.status(400).json({ error: "date, staffId шаардлагатай" });

    const prisma = getPrisma();
    const staff = await prisma.turuuStaff.findFirst({ where: { id: staffId, orgId: req.org.orgId, isActive: true } });
    if (!staff) return res.status(404).json({ error: "Мастер олдсонгүй" });

    // Амралтын өдөр шалгах (ISO weekday: 1=Даваа ... 7=Ням)
    const dayOfWeek = new Date(date).getDay() || 7; // 0(Sun)→7
    const offDays = Array.isArray(staff.workDays) ? staff.workDays : JSON.parse(staff.workDays);
    if (!offDays.includes(dayOfWeek)) {
      return res.json({ date, staffId, available: [], offDay: true });
    }

    // Тухайн өдрийн захиалгуудыг татах
    const booked = await prisma.turuuAppointment.findMany({
      where: { staffId, date, status: { not: "CANCELLED" } },
      select: { timeSlot: true },
    });
    const bookedSlots = booked.map((b) => b.timeSlot);

    // Slot тооцоолол — service-үүдийн хамгийн урт duration ашиглана
    const services = Array.isArray(staff.services) ? staff.services : JSON.parse(staff.services || "[]");
    const duration = services.length > 0
      ? Math.max(...services.map((s) => Number(s.durationMinutes) || 60))
      : 60;

    const buffer = Number(staff.bufferMinutes) || 0;
    const allSlots = buildSlots(staff.workStart, staff.workEnd, duration + buffer);
    const available = allSlots.filter((s) => !bookedSlots.includes(s));

    res.json({ date, staffId, staffName: staff.name, available, offDay: false });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── APPOINTMENTS ─────────────────────────────────────────────────────────────

// GET /client/appointments
router.get("/appointments", async (req, res) => {
  try {
    const { date, status, page = 1 } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;
    const prisma = getPrisma();
    const where = {
      orgId: req.org.orgId,
      status: { not: "BLOCKED" },
      ...(date   && { date }),
      ...(status && { status: String(status) }),
    };
    const [data, total] = await Promise.all([
      prisma.turuuAppointment.findMany({
        where,
        include: { staff: { select: { name: true } } },
        orderBy: [{ date: "asc" }, { timeSlot: "asc" }],
        take,
        skip,
      }),
      prisma.turuuAppointment.count({ where }),
    ]);
    res.json({ data, total, page: Number(page), pages: Math.ceil(total / take) });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// PUT /client/appointments/:id/status
router.put("/appointments/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["PENDING", "CONFIRMED", "CANCELLED", "COMPLETED"].includes(status)) return res.status(400).json({ error: "status буруу" });
    const prisma = getPrisma();
    const appt = await prisma.turuuAppointment.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!appt) return res.status(404).json({ error: "Олдсонгүй" });
    const updated = await prisma.turuuAppointment.update({ where: { id: req.params.id }, data: { status } });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/schedule?staffId=UUID&date=YYYY-MM-DD
// GET /client/staff/:id/schedule?date=YYYY-MM-DD  (backwards-compatible)
async function handleSchedule(req, res) {
  try {
    const staffId = req.query.staffId || req.params.id;
    const { date } = req.query;
    if (!staffId || !date) return res.status(400).json({ error: "staffId, date шаардлагатай" });
    const prisma = getPrisma();
    const staff = await prisma.turuuStaff.findFirst({ where: { id: staffId, orgId: req.org.orgId, isActive: true } });
    if (!staff) return res.status(404).json({ error: "Мастер олдсонгүй" });

    const dayOfWeek = new Date(`${date}T00:00:00`).getDay() || 7;
    const workDays = Array.isArray(staff.workDays) ? staff.workDays : JSON.parse(staff.workDays || "[1,2,3,4,5]");
    if (!workDays.includes(dayOfWeek)) {
      return res.json({ slots: [], staffName: staff.name, offDay: true });
    }

    const appointments = await prisma.turuuAppointment.findMany({
      where: { staffId, date, status: { not: "CANCELLED" } },
      select: { id: true, timeSlot: true, status: true, customerName: true, serviceName: true },
    });
    const apptMap = new Map(appointments.map((a) => [a.timeSlot, a]));

    const services = Array.isArray(staff.services) ? staff.services : JSON.parse(staff.services || "[]");
    const rawDurations = services.map((s) => s.durationMinutes);
    const duration = services.length > 0 ? Math.max(...services.map((s) => Number(s.durationMinutes) || 60)) : 60;
    const buffer = Number(staff.bufferMinutes) || 0;
    const allSlots = buildSlots(staff.workStart, staff.workEnd, duration + buffer);
    console.log("[SCHEDULE]", { staffId, date, dayOfWeek, workDays, workStart: staff.workStart, workEnd: staff.workEnd, rawDurations, duration, buffer, slotsCount: allSlots.length });

    const slots = allSlots.map((time) => {
      const appt = apptMap.get(time);
      if (!appt) return { time, status: "available" };
      if (appt.status === "BLOCKED") return { time, status: "blocked", appointmentId: appt.id };
      return { time, status: "booked", appointmentId: appt.id, customerName: appt.customerName, serviceName: appt.serviceName };
    });

    res.json({ slots, staffName: staff.name, offDay: false });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
}
router.get("/schedule", handleSchedule);
router.get("/staff/:id/schedule", handleSchedule);

// POST /client/schedule/block — тухайн мастерын цагийг гараар хаана
// POST /client/staff/:id/block  (backwards-compatible)
async function handleBlock(req, res) {
  try {
    const staffId = req.body.staffId || req.params.id;
    const { date, timeSlot } = req.body;
    if (!staffId || !date || !timeSlot) return res.status(400).json({ error: "staffId, date, timeSlot шаардлагатай" });
    const prisma = getPrisma();
    const staff = await prisma.turuuStaff.findFirst({ where: { id: staffId, orgId: req.org.orgId, isActive: true } });
    if (!staff) return res.status(404).json({ error: "Мастер олдсонгүй" });

    const existing = await prisma.turuuAppointment.findFirst({
      where: { staffId, date, timeSlot, status: { not: "CANCELLED" } },
    });
    if (existing) return res.status(400).json({ error: "Тухайн цаг захиалгатай байна" });

    const services = Array.isArray(staff.services) ? staff.services : JSON.parse(staff.services || "[]");
    const duration = services.length > 0 ? Math.max(...services.map((s) => Number(s.durationMinutes) || 60)) : 60;

    const block = await prisma.turuuAppointment.create({
      data: { orgId: req.org.orgId, staffId, date, timeSlot, serviceName: "Хаасан цаг", durationMinutes: duration, status: "BLOCKED" },
    });
    res.json(block);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
}
router.post("/schedule/block", handleBlock);
router.post("/staff/:id/block", handleBlock);

// DELETE /client/appointments/:id — зөвхөн BLOCKED цагийг устгана (нээнэ)
router.delete("/appointments/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const appt = await prisma.turuuAppointment.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!appt) return res.status(404).json({ error: "Олдсонгүй" });
    if (appt.status !== "BLOCKED") return res.status(400).json({ error: "Зөвхөн хаасан цагийг устгаж болно" });
    await prisma.turuuAppointment.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/appointment-revenue — цаг захиалгын орлого
router.get("/appointment-revenue", async (req, res) => {
  try {
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    const [deposit, completed, today] = await Promise.all([
      prisma.turuuAppointment.aggregate({ where: { orgId, depositStatus: "PAID" }, _sum: { depositAmount: true }, _count: true }),
      prisma.turuuAppointment.count({ where: { orgId, status: "COMPLETED" } }),
      prisma.turuuAppointment.count({ where: { orgId, status: { in: ["PENDING", "CONFIRMED"] }, date: new Date().toISOString().slice(0, 10) } }),
    ]);
    res.json({
      depositTotal: deposit._sum.depositAmount || 0,
      depositCount: deposit._count || 0,
      completedCount: completed,
      todayCount: today,
    });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

module.exports = router;
