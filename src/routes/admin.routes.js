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
    const chat = await prisma.turuuChat.findFirst({ where: { psid: req.params.psid } });
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
    const chat = await prisma.turuuChat.findFirst({ where: { psid: req.params.psid } });
    const messages = Array.isArray(chat?.messages) ? [...chat.messages] : [];
    messages.push({ role: "assistant", content: `[Admin] ${text}` });
    await prisma.turuuChat.upsert({
      where: { orgId_psid: { orgId: null, psid: req.params.psid } },
      create: { psid: req.params.psid, orgId: null, messages },
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
      where: { orgId_psid: { orgId: null, psid: req.params.psid } },
      create: { psid: req.params.psid, orgId: null, blocked: !!blocked },
      update: { blocked: !!blocked },
    });
    res.json(chat);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/knowledge/summary — org бүрийн KB item тоо
router.get("/knowledge/summary", async (req, res) => {
  try {
    const prisma = getPrisma();
    const grouped = await prisma.turuuKnowledge.groupBy({
      by: ["orgId"],
      _count: { id: true },
    });
    res.json(grouped);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/knowledge — бүх KB items (orgId-аар filter хийх боломжтой)
router.get("/knowledge", async (req, res) => {
  try {
    const { orgId } = req.query;
    const prisma = getPrisma();
    const where = orgId ? { orgId: String(orgId) } : {};
    const items = await prisma.turuuKnowledge.findMany({ where, orderBy: { createdAt: "asc" } });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/knowledge
router.post("/knowledge", async (req, res) => {
  try {
    const { question, answer, category, orgId } = req.body;
    if (!question || !answer) return res.status(400).json({ error: "question and answer required" });
    const prisma = getPrisma();
    const item = await prisma.turuuKnowledge.create({ data: { question, answer, category, orgId: orgId || null } });
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
    const rows = await prisma.turuuSettings.findMany({ where: { orgId: null } });
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
        where: { orgId_key: { orgId: null, key } },
        create: { orgId: null, key, value: String(value) },
        update: { value: String(value) },
      })
    );
    await Promise.all(ops);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/organizations — бүх client байгууллагуудын жагсаалт
router.get("/organizations", async (req, res) => {
  try {
    const { page = 1, plan, status, search } = req.query;
    const take = 30;
    const skip = (Number(page) - 1) * take;
    const prisma = getPrisma();

    const where = {};
    if (plan) where.plan = plan;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { slug: { contains: search, mode: "insensitive" } },
      ];
    }

    const [orgs, total, planCounts] = await Promise.all([
      prisma.organization.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        select: {
          id: true, name: true, slug: true, email: true,
          plan: true, status: true, messageUsed: true,
          quotaResetAt: true, subscriptionEndsAt: true,
          createdAt: true, updatedAt: true,
          fbPageId: true, logoUrl: true,
        },
      }),
      prisma.organization.count({ where }),
      prisma.organization.groupBy({ by: ["plan"], _count: { id: true } }),
    ]);

    const planBreakdown = {};
    planCounts.forEach(({ plan, _count }) => { planBreakdown[plan] = _count.id; });

    res.json({ data: orgs, total, page: Number(page), pages: Math.ceil(total / take), planBreakdown });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/organizations/:id — нэг client-ийн дэлгэрэнгүй мэдээлэл
router.get("/organizations/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const orgId = req.params.id;

    const [org, conversations, leads, consultations, orders, unanswered, settings] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: orgId },
        select: {
          id: true, name: true, slug: true, email: true,
          plan: true, status: true, messageUsed: true,
          quotaResetAt: true, subscriptionEndsAt: true,
          createdAt: true, updatedAt: true,
          fbPageId: true, logoUrl: true,
          telegramBotToken: true, telegramChatId: true,
        },
      }),
      prisma.turuuChat.count({ where: { orgId } }),
      prisma.turuuLead.count({ where: { orgId } }),
      prisma.turuuConsultation.count({ where: { orgId } }),
      prisma.turuuOrder.count({ where: { orgId } }),
      prisma.turuuUnanswered.count({ where: { orgId, resolved: false } }),
      prisma.turuuSettings.findMany({ where: { orgId } }),
    ]);

    if (!org) return res.status(404).json({ error: "Organization not found" });

    const settingsMap = {};
    settings.forEach((s) => { settingsMap[s.key] = s.value; });

    const recentConvs = await prisma.turuuChat.findMany({
      where: { orgId },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { psid: true, updatedAt: true, messages: true, blocked: true },
    });

    res.json({
      org,
      stats: { conversations, leads, consultations, orders, unansweredCount: unanswered },
      settings: settingsMap,
      recentConversations: recentConvs.map((c) => ({
        psid: c.psid,
        blocked: c.blocked,
        updatedAt: c.updatedAt,
        messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
        lastMessage: Array.isArray(c.messages) && c.messages.length > 0
          ? c.messages[c.messages.length - 1] : null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /admin/organizations/:id — plan, status, subscriptionEndsAt шинэчлэх
router.put("/organizations/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const { plan, status, subscriptionEndsAt } = req.body;
    const data = {};
    if (plan) data.plan = plan;
    if (status) data.status = status;
    if (subscriptionEndsAt !== undefined) data.subscriptionEndsAt = subscriptionEndsAt ? new Date(subscriptionEndsAt) : null;
    const org = await prisma.organization.update({ where: { id: req.params.id }, data });
    res.json(org);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/unanswered — бүх org-ийн шийдэгдээгүй асуудлууд
router.get("/unanswered", async (req, res) => {
  try {
    const { page = 1, resolved = "false", orgId } = req.query;
    const take = 30;
    const skip = (Number(page) - 1) * take;
    const prisma = getPrisma();

    const where = {};
    if (resolved !== "all") where.resolved = resolved === "true";
    if (orgId) where.orgId = orgId;

    const [items, total] = await Promise.all([
      prisma.turuuUnanswered.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.turuuUnanswered.count({ where }),
    ]);

    // org нэрийг хавсаргах
    const orgIds = [...new Set(items.map((i) => i.orgId).filter(Boolean))];
    const orgs = await prisma.organization.findMany({
      where: { id: { in: orgIds } },
      select: { id: true, name: true, plan: true },
    });
    const orgMap = {};
    orgs.forEach((o) => { orgMap[o.id] = o; });

    const enriched = items.map((i) => ({ ...i, org: orgMap[i.orgId] || null }));
    res.json({ data: enriched, total, page: Number(page), pages: Math.ceil(total / take) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/unanswered/:id/resolve — шийдвэрлэх
router.post("/unanswered/:id/resolve", async (req, res) => {
  try {
    const prisma = getPrisma();
    const item = await prisma.turuuUnanswered.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: "Not found" });

    const { answer, category } = req.body;
    if (answer) {
      await prisma.turuuKnowledge.create({
        data: { orgId: item.orgId, question: item.question, answer, category: category || null, active: true },
      });
    }
    await prisma.turuuUnanswered.update({ where: { id: req.params.id }, data: { resolved: true } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /admin/unanswered/:id
router.delete("/unanswered/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.turuuUnanswered.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/health/business — бизнесийн pulse, quota alerts, OpenAI usage, connectivity
router.get("/health/business", async (req, res) => {
  try {
    const prisma = getPrisma();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 86400000);

    const QUOTA_MAP = { starter: 10000, growth: 15000, business: 15000, enterprise: 17000, free: 500 };
    const MSG_COST = 0.0001; // ~$0.0001 per message (GPT-4o-mini estimate)

    const [
      convsToday, leadsToday, leadsWeek,
      lastActivity, unansweredCount, unansweredWeek,
      allOrgs, kbGrouped,
    ] = await Promise.all([
      prisma.turuuChat.count({ where: { updatedAt: { gte: todayStart } } }),
      prisma.turuuLead.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.turuuLead.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.turuuChat.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
      prisma.turuuUnanswered.count({ where: { resolved: false } }),
      prisma.turuuUnanswered.count({ where: { resolved: false, createdAt: { gte: weekAgo } } }),
      prisma.organization.findMany({
        select: { id: true, name: true, plan: true, status: true, messageUsed: true, subscriptionEndsAt: true, fbPageId: true },
      }),
      prisma.turuuKnowledge.groupBy({ by: ["orgId"], _count: { id: true } }),
    ]);

    // OpenAI usage aggregate
    const totalMessages = allOrgs.reduce((s, o) => s + (o.messageUsed || 0), 0);
    const estimatedCost = (totalMessages * MSG_COST).toFixed(2);
    const topConsumers = [...allOrgs]
      .sort((a, b) => b.messageUsed - a.messageUsed)
      .slice(0, 5)
      .map((o) => ({ id: o.id, name: o.name, plan: o.plan, messageUsed: o.messageUsed, quota: QUOTA_MAP[o.plan] || 10000 }));

    // Quota alerts
    const quotaAlerts = allOrgs
      .filter((o) => {
        const quota = QUOTA_MAP[o.plan] || 10000;
        return (o.messageUsed / quota) >= 0.8;
      })
      .map((o) => {
        const quota = QUOTA_MAP[o.plan] || 10000;
        return { id: o.id, name: o.name, plan: o.plan, messageUsed: o.messageUsed, quota, pct: Math.round((o.messageUsed / quota) * 100) };
      })
      .sort((a, b) => b.pct - a.pct);

    // Expired subscriptions
    const now = new Date();
    const expiredOrgs = allOrgs.filter((o) => o.subscriptionEndsAt && new Date(o.subscriptionEndsAt) < now);
    const expiringSoon = allOrgs.filter((o) => {
      if (!o.subscriptionEndsAt) return false;
      const d = Math.ceil((new Date(o.subscriptionEndsAt) - now) / 86400000);
      return d >= 0 && d <= 7;
    });

    // Connectivity overview
    const kbOrgIds = new Set(kbGrouped.map((g) => g.orgId).filter(Boolean));
    const fbConnected = allOrgs.filter((o) => o.fbPageId).length;
    const kbConfigured = allOrgs.filter((o) => kbOrgIds.has(o.id)).length;
    const activeStatus = allOrgs.filter((o) => o.status === "active").length;

    res.json({
      pulse: {
        convsToday,
        leadsToday,
        leadsWeek,
        lastActivity: lastActivity?.updatedAt || null,
        unansweredCount,
        unansweredWeek,
      },
      openai: {
        totalMessages,
        estimatedCostUSD: estimatedCost,
        topConsumers,
      },
      quotaAlerts,
      expiredOrgs: expiredOrgs.map((o) => ({ id: o.id, name: o.name, plan: o.plan, subscriptionEndsAt: o.subscriptionEndsAt })),
      expiringSoon: expiringSoon.map((o) => ({ id: o.id, name: o.name, plan: o.plan, subscriptionEndsAt: o.subscriptionEndsAt })),
      connectivity: {
        total: allOrgs.length,
        activeStatus,
        fbConnected,
        kbConfigured,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/health/detailed — system health check
router.get("/health/detailed", async (req, res) => {
  const result = { db: "ok", openai: "ok", timestamp: new Date().toISOString() };

  try {
    const prisma = getPrisma();
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    result.db = "error";
  }

  if (!process.env.OPENAI_API_KEY) {
    result.openai = "missing_key";
  } else {
    try {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      result.openai = r.ok ? "ok" : "error";
      if (r.ok) {
        // usage endpoint (OpenAI dashboard API, separate from chat API)
        result.openaiKeyConfigured = true;
      }
    } catch {
      result.openai = "timeout";
    }
  }

  result.supabase = process.env.SUPABASE_URL ? "configured" : "not_configured";
  result.telegram = process.env.TELEGRAM_BOT_TOKEN ? "configured" : "not_configured";
  result.facebook = process.env.FB_PAGE_ACCESS_TOKEN ? "configured" : "not_configured";
  result.resend = process.env.RESEND_API_KEY ? "configured" : "not_configured";

  res.json(result);
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
