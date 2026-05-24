"use strict";
const express = require("express");
const jwt = require("jsonwebtoken");
const { getPrisma } = require("../lib/db");
const { authMiddleware } = require("../middleware/auth");
const { sendText } = require("../services/facebook.service");

const router = express.Router();

// POST /admin/login
router.post("/login", (req, res) => {
  const { password } = req.body;
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Нууц үг буруу" });
  }
  const token = jwt.sign(
    { admin: true },
    process.env.JWT_SECRET || "turuuai_admin_secret_change_me",
    { expiresIn: "7d" }
  );
  res.json({ token });
});

// All routes below require auth
router.use(authMiddleware);

// GET /admin/stats
router.get("/stats", async (req, res) => {
  try {
    const prisma = getPrisma();
    const [conversations, leads, consultations, newLeads, recentLeads] = await Promise.all([
      prisma.turuuChat.count(),
      prisma.turuuLead.count(),
      prisma.turuuConsultation.count(),
      prisma.turuuLead.count({ where: { status: "NEW" } }),
      prisma.turuuLead.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
    ]);

    // Daily traffic last 14 days
    const dailyTraffic = await prisma.$queryRaw`
      SELECT DATE("createdAt") as date, COUNT(*)::int as count
      FROM "TuruuLead"
      WHERE "createdAt" >= NOW() - INTERVAL '14 days'
      GROUP BY DATE("createdAt")
      ORDER BY date ASC
    `;

    res.json({ conversations, leads, consultations, newLeads, recentLeads, dailyTraffic });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/leads
router.get("/leads", async (req, res) => {
  try {
    const { page = 1, status, search } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;
    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
        { company: { contains: search, mode: "insensitive" } },
      ];
    }

    const prisma = getPrisma();
    const [data, total] = await Promise.all([
      prisma.turuuLead.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
      prisma.turuuLead.count({ where }),
    ]);
    res.json({ data, total, page: Number(page), pages: Math.ceil(total / take) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /admin/leads/:id
router.put("/leads/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const { status, notes } = req.body;
    const lead = await prisma.turuuLead.update({
      where: { id: req.params.id },
      data: {
        ...(status && { status }),
        ...(notes !== undefined && { notes }),
      },
    });
    res.json(lead);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /admin/leads/:id
router.delete("/leads/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.turuuLead.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/consultations
router.get("/consultations", async (req, res) => {
  try {
    const { page = 1, status } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;
    const where = status ? { status } : {};

    const prisma = getPrisma();
    const [data, total] = await Promise.all([
      prisma.turuuConsultation.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
      prisma.turuuConsultation.count({ where }),
    ]);
    res.json({ data, total, page: Number(page), pages: Math.ceil(total / take) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /admin/consultations/:id
router.put("/consultations/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const { status } = req.body;
    const record = await prisma.turuuConsultation.update({
      where: { id: req.params.id },
      data: { status },
    });
    res.json(record);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/conversations
router.get("/conversations", async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;

    const prisma = getPrisma();
    const [data, total] = await Promise.all([
      prisma.turuuChat.findMany({ orderBy: { updatedAt: "desc" }, take, skip }),
      prisma.turuuChat.count(),
    ]);

    const enriched = data.map((c) => ({
      ...c,
      messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
      lastMessage: Array.isArray(c.messages) && c.messages.length > 0
        ? c.messages[c.messages.length - 1]
        : null,
    }));
    res.json({ data: enriched, total, page: Number(page), pages: Math.ceil(total / take) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/conversations/:psid
router.get("/conversations/:psid", async (req, res) => {
  try {
    const prisma = getPrisma();
    const chat = await prisma.turuuChat.findUnique({ where: { psid: req.params.psid } });
    if (!chat) return res.status(404).json({ error: "Not found" });
    res.json(chat);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/conversations/:psid/reply
router.post("/conversations/:psid/reply", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });

  try {
    await sendText(req.params.psid, text);

    const prisma = getPrisma();
    const chat = await prisma.turuuChat.findUnique({ where: { psid: req.params.psid } });
    const messages = Array.isArray(chat?.messages) ? [...chat.messages] : [];
    messages.push({ role: "assistant", content: `[Admin] ${text}` });
    await prisma.turuuChat.upsert({
      where: { psid: req.params.psid },
      create: { psid: req.params.psid, messages },
      update: { messages },
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /admin/conversations/:psid/block
router.put("/conversations/:psid/block", async (req, res) => {
  try {
    const prisma = getPrisma();
    const { blocked } = req.body;
    const chat = await prisma.turuuChat.upsert({
      where: { psid: req.params.psid },
      create: { psid: req.params.psid, blocked: !!blocked },
      update: { blocked: !!blocked },
    });
    res.json(chat);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/knowledge
router.get("/knowledge", async (req, res) => {
  try {
    const prisma = getPrisma();
    const items = await prisma.turuuKnowledge.findMany({ orderBy: { createdAt: "asc" } });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/knowledge
router.post("/knowledge", async (req, res) => {
  try {
    const { question, answer, category } = req.body;
    if (!question || !answer) return res.status(400).json({ error: "question and answer required" });
    const prisma = getPrisma();
    const item = await prisma.turuuKnowledge.create({ data: { question, answer, category } });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /admin/knowledge/:id
router.put("/knowledge/:id", async (req, res) => {
  try {
    const { question, answer, category, active } = req.body;
    const prisma = getPrisma();
    const item = await prisma.turuuKnowledge.update({
      where: { id: req.params.id },
      data: {
        ...(question && { question }),
        ...(answer && { answer }),
        ...(category !== undefined && { category }),
        ...(active !== undefined && { active }),
      },
    });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /admin/knowledge/:id
router.delete("/knowledge/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.turuuKnowledge.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/settings
router.get("/settings", async (req, res) => {
  try {
    const prisma = getPrisma();
    const rows = await prisma.turuuSettings.findMany();
    const map = {};
    rows.forEach((r) => { map[r.key] = r.value; });
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /admin/settings
router.put("/settings", async (req, res) => {
  try {
    const prisma = getPrisma();
    const updates = req.body;
    const ops = Object.entries(updates).map(([key, value]) =>
      prisma.turuuSettings.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) },
      })
    );
    await Promise.all(ops);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/users
router.get("/users", async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;

    const prisma = getPrisma();
    const [data, total] = await Promise.all([
      prisma.turuuChat.findMany({
        orderBy: { updatedAt: "desc" },
        take,
        skip,
        select: { id: true, psid: true, blocked: true, createdAt: true, updatedAt: true, messages: true },
      }),
      prisma.turuuChat.count(),
    ]);

    const enriched = data.map((u) => ({
      ...u,
      messageCount: Array.isArray(u.messages) ? u.messages.length : 0,
      messages: undefined,
    }));
    res.json({ data: enriched, total, page: Number(page), pages: Math.ceil(total / take) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
