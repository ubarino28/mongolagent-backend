"use strict";
// Ресторан: меню / ширээ / ширээний захиалга (client.routes.js-ээс салгав).
// Auth-ийг эцэг router (client.routes.js) clientAuthMiddleware-ээр тавьсан тул req.org бэлэн байна.
const express = require("express");
const { getPrisma } = require("../../lib/db");

const router = express.Router();

// ─── RESTAURANT: MENU ────────────────────────────────────────────────────────

router.get("/menu", async (req, res) => {
  try {
    const prisma = getPrisma();
    const items = await prisma.turuuMenuItem.findMany({ where: { orgId: req.org.orgId, isActive: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], take: 1000 });
    res.json(items);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

router.post("/menu", async (req, res) => {
  try {
    const { name, category, description, price, portions, imageUrl } = req.body;
    if (!name) return res.status(400).json({ error: "name шаардлагатай" });
    const prisma = getPrisma();
    const item = await prisma.turuuMenuItem.create({
      data: { orgId: req.org.orgId, name, category, description, price: Number(price) || 0, portions: portions || [], imageUrl },
    });
    res.json(item);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

router.put("/menu/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.turuuMenuItem.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!existing) return res.status(404).json({ error: "Олдсонгүй" });
    const { name, category, description, price, portions, imageUrl, isActive } = req.body;
    const item = await prisma.turuuMenuItem.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(category !== undefined && { category }),
        ...(description !== undefined && { description }),
        ...(price !== undefined && { price: Number(price) || 0 }),
        ...(portions !== undefined && { portions }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(isActive !== undefined && { isActive }),
      },
    });
    res.json(item);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

router.delete("/menu/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.turuuMenuItem.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!existing) return res.status(404).json({ error: "Олдсонгүй" });
    await prisma.turuuMenuItem.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── RESTAURANT: TABLES ──────────────────────────────────────────────────────

router.get("/tables", async (req, res) => {
  try {
    const prisma = getPrisma();
    const tables = await prisma.turuuTable.findMany({ where: { orgId: req.org.orgId, isActive: true }, orderBy: { tableNumber: "asc" }, take: 1000 });
    res.json(tables);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

router.post("/tables", async (req, res) => {
  try {
    const { tableNumber, capacity } = req.body;
    if (!tableNumber) return res.status(400).json({ error: "tableNumber шаардлагатай" });
    const prisma = getPrisma();
    const table = await prisma.turuuTable.create({
      data: { orgId: req.org.orgId, tableNumber: Number(tableNumber), capacity: Number(capacity) || 4 },
    });
    res.json(table);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

router.put("/tables/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.turuuTable.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!existing) return res.status(404).json({ error: "Олдсонгүй" });
    const { tableNumber, capacity, isActive } = req.body;
    const table = await prisma.turuuTable.update({
      where: { id: req.params.id },
      data: {
        ...(tableNumber !== undefined && { tableNumber: Number(tableNumber) }),
        ...(capacity !== undefined && { capacity: Number(capacity) }),
        ...(isActive !== undefined && { isActive }),
      },
    });
    res.json(table);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

router.delete("/tables/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.turuuTable.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!existing) return res.status(404).json({ error: "Олдсонгүй" });
    await prisma.turuuTable.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/tables/availability?date=YYYY-MM-DD&time=HH:MM&guests=N
router.get("/tables/availability", async (req, res) => {
  try {
    const { date, time, guests } = req.query;
    if (!date || !time || !guests) return res.status(400).json({ error: "date, time, guests шаардлагатай" });
    const prisma = getPrisma();
    const allTables = await prisma.turuuTable.findMany({ where: { orgId: req.org.orgId, isActive: true, capacity: { gte: Number(guests) } }, orderBy: { capacity: "asc" } });
    const reservations = await prisma.turuuReservation.findMany({
      where: { orgId: req.org.orgId, date, timeSlot: time, status: { not: "CANCELLED" } },
      select: { tableId: true },
    });
    const bookedIds = new Set(reservations.map((r) => r.tableId));
    const available = allTables.filter((t) => !bookedIds.has(t.id));
    res.json({ available, total: allTables.length, booked: reservations.length });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── RESTAURANT: RESERVATIONS ────────────────────────────────────────────────

router.get("/reservations", async (req, res) => {
  try {
    const { date, status, page = 1 } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;
    const prisma = getPrisma();
    const where = { orgId: req.org.orgId, ...(date && { date }), ...(status && { status }) };
    const [data, total] = await Promise.all([
      prisma.turuuReservation.findMany({ where, include: { table: { select: { tableNumber: true, capacity: true } } }, orderBy: [{ date: "asc" }, { timeSlot: "asc" }], take, skip }),
      prisma.turuuReservation.count({ where }),
    ]);
    res.json({ data, total, page: Number(page), pages: Math.ceil(total / take) });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/reservations — гар аргаар ширээ захиалга нэмэх
router.post("/reservations", async (req, res) => {
  try {
    const { tableId, date, timeSlot, guestCount, customerName, customerPhone } = req.body;
    if (!tableId || !date || !timeSlot) return res.status(400).json({ error: "tableId, date, timeSlot шаардлагатай" });
    const prisma = getPrisma();
    const conflict = await prisma.turuuReservation.findFirst({ where: { tableId, date, timeSlot, status: { not: "CANCELLED" } } });
    if (conflict) return res.status(400).json({ error: `Ширээ тэр цагт захиалагдсан байна` });
    const reservation = await prisma.turuuReservation.create({
      data: { orgId: req.org.orgId, tableId, date, timeSlot, guestCount: Number(guestCount) || 1, customerName, customerPhone },
    });
    res.json(reservation);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

router.put("/reservations/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["PENDING", "CONFIRMED", "CANCELLED", "COMPLETED"].includes(status)) return res.status(400).json({ error: "status буруу" });
    const prisma = getPrisma();
    const r = await prisma.turuuReservation.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!r) return res.status(404).json({ error: "Олдсонгүй" });
    const updated = await prisma.turuuReservation.update({ where: { id: req.params.id }, data: { status } });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

module.exports = router;
