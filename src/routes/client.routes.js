"use strict";
const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { getPrisma } = require("../lib/db");
const { clientAuthMiddleware } = require("../middleware/clientAuth");
const { sendText } = require("../services/facebook.service");

const router = express.Router();

const API_URL = process.env.API_URL || "https://turuuai-backend.onrender.com";
const FRONTEND_URL = process.env.FRONTEND_APP_URL || "https://turuuai-app.vercel.app";
const FB_CALLBACK = `${API_URL}/client/profile/facebook/callback`;

// Facebook OAuth callback — auth middleware байхгүй (Facebook-аас ирдэг)
router.get("/profile/facebook/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.redirect(`${FRONTEND_URL}/profile?fb_error=true`);

  try {
    const { orgId } = JSON.parse(Buffer.from(String(state), "base64").toString());

    const tokenRes = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
      params: {
        client_id: process.env.FB_APP_ID,
        client_secret: process.env.FB_APP_SECRET,
        redirect_uri: FB_CALLBACK,
        code,
      },
    });
    const userToken = tokenRes.data.access_token;

    const pagesRes = await axios.get("https://graph.facebook.com/v19.0/me/accounts", {
      params: { access_token: userToken, fields: "id,name,access_token,category,picture" },
    });
    const pages = pagesRes.data.data || [];

    // Instagram аккаунтуудыг page-аас авна
    const pagesWithIg = await Promise.all(
      pages.map(async (p) => {
        try {
          const igRes = await axios.get(`https://graph.facebook.com/v19.0/${p.id}`, {
            params: { fields: "instagram_business_account{id,name,username}", access_token: p.access_token },
          });
          return { ...p, instagram: igRes.data.instagram_business_account || null };
        } catch { return { ...p, instagram: null }; }
      })
    );

    const encoded = Buffer.from(JSON.stringify(pagesWithIg)).toString("base64");
    res.redirect(`${FRONTEND_URL}/profile?fb_pages=${encoded}&fb_org=${orgId}`);
  } catch (err) {
    console.error("[FB OAuth] callback error:", err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}/profile?fb_error=true`);
  }
});

// All routes below require auth
router.use(clientAuthMiddleware);

// GET /client/profile/facebook/auth-url
router.get("/profile/facebook/auth-url", (req, res) => {
  const state = Buffer.from(JSON.stringify({ orgId: req.org.orgId })).toString("base64");
  const scope = [
    "pages_messaging",
    "pages_show_list",
    "pages_manage_metadata",
    "pages_read_engagement",
    "instagram_basic",
    "instagram_manage_messages",
  ].join(",");

  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${process.env.FB_APP_ID}&redirect_uri=${encodeURIComponent(FB_CALLBACK)}&scope=${scope}&state=${state}`;
  res.json({ url });
});

// POST /client/profile/facebook/select-page
router.post("/profile/facebook/select-page", async (req, res) => {
  try {
    const { pageId, pageName, pageToken, instagramId } = req.body;
    if (!pageId || !pageToken) return res.status(400).json({ error: "pageId, pageToken шаардлагатай" });
    const prisma = getPrisma();
    await prisma.organization.update({
      where: { id: req.org.orgId },
      data: {
        fbPageId: pageId,
        fbPageToken: pageToken,
        ...(instagramId && { instagramAccountId: instagramId }),
      },
    });
    res.json({ ok: true, pageName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /client/stats
router.get("/stats", async (req, res) => {
  try {
    const prisma = getPrisma();
    const orgId = req.org.orgId;

    const [conversations, leads, consultations, newLeads, recentLeads] = await Promise.all([
      prisma.turuuChat.count({ where: { orgId } }),
      prisma.turuuLead.count({ where: { orgId } }),
      prisma.turuuConsultation.count({ where: { orgId } }),
      prisma.turuuLead.count({ where: { orgId, status: "NEW" } }),
      prisma.turuuLead.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 5 }),
    ]);

    const dailyTraffic = await prisma.$queryRaw`
      SELECT DATE("createdAt") as date, COUNT(*)::int as count
      FROM "TuruuLead"
      WHERE "orgId" = ${orgId} AND "createdAt" >= NOW() - INTERVAL '14 days'
      GROUP BY DATE("createdAt")
      ORDER BY date ASC
    `;

    res.json({ conversations, leads, consultations, newLeads, recentLeads, dailyTraffic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /client/leads
router.get("/leads", async (req, res) => {
  try {
    const { page = 1, status, search } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;
    const orgId = req.org.orgId;
    const where = { orgId };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
      ];
    }

    const prisma = getPrisma();
    const [data, total] = await Promise.all([
      prisma.turuuLead.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
      prisma.turuuLead.count({ where }),
    ]);
    res.json({ data, total, page: Number(page), pages: Math.ceil(total / take) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /client/leads/:id
router.put("/leads/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const lead = await prisma.turuuLead.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!lead) return res.status(404).json({ error: "Not found" });
    const { status, notes } = req.body;
    const updated = await prisma.turuuLead.update({
      where: { id: req.params.id },
      data: { ...(status && { status }), ...(notes !== undefined && { notes }) },
    });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /client/consultations
router.get("/consultations", async (req, res) => {
  try {
    const { page = 1, status } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;
    const where = { orgId: req.org.orgId, ...(status && { status }) };

    const prisma = getPrisma();
    const [data, total] = await Promise.all([
      prisma.turuuConsultation.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
      prisma.turuuConsultation.count({ where }),
    ]);
    res.json({ data, total, page: Number(page), pages: Math.ceil(total / take) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /client/consultations/:id
router.put("/consultations/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const c = await prisma.turuuConsultation.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!c) return res.status(404).json({ error: "Not found" });
    const updated = await prisma.turuuConsultation.update({ where: { id: req.params.id }, data: { status: req.body.status } });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /client/conversations
router.get("/conversations", async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;
    const orgId = req.org.orgId;

    const prisma = getPrisma();
    const [data, total] = await Promise.all([
      prisma.turuuChat.findMany({ where: { orgId }, orderBy: { updatedAt: "desc" }, take, skip }),
      prisma.turuuChat.count({ where: { orgId } }),
    ]);

    const enriched = data.map((c) => ({
      ...c,
      messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
      lastMessage: Array.isArray(c.messages) && c.messages.length > 0 ? c.messages[c.messages.length - 1] : null,
    }));
    res.json({ data: enriched, total, page: Number(page), pages: Math.ceil(total / take) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /client/conversations/:psid
router.get("/conversations/:psid", async (req, res) => {
  try {
    const prisma = getPrisma();
    const chat = await prisma.turuuChat.findFirst({ where: { psid: req.params.psid, orgId: req.org.orgId } });
    if (!chat) return res.status(404).json({ error: "Not found" });
    res.json(chat);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/conversations/:psid/reply
router.post("/conversations/:psid/reply", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId } });
    if (!org?.fbPageToken) return res.status(400).json({ error: "Facebook холбогдоогүй байна" });

    await sendText(req.params.psid, text, org.fbPageToken);

    const chat = await prisma.turuuChat.findFirst({ where: { psid: req.params.psid, orgId: req.org.orgId } });
    const messages = Array.isArray(chat?.messages) ? [...chat.messages] : [];
    messages.push({ role: "assistant", content: `[Admin] ${text}` });
    await prisma.turuuChat.upsert({
      where: { orgId_psid: { orgId: req.org.orgId, psid: req.params.psid } },
      create: { psid: req.params.psid, orgId: req.org.orgId, messages },
      update: { messages },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /client/conversations/:psid/block
router.put("/conversations/:psid/block", async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.turuuChat.upsert({
      where: { orgId_psid: { orgId: req.org.orgId, psid: req.params.psid } },
      create: { psid: req.params.psid, orgId: req.org.orgId, blocked: !!req.body.blocked },
      update: { blocked: !!req.body.blocked },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /client/knowledge
router.get("/knowledge", async (req, res) => {
  try {
    const prisma = getPrisma();
    const items = await prisma.turuuKnowledge.findMany({ where: { orgId: req.org.orgId }, orderBy: { createdAt: "asc" } });
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/knowledge
router.post("/knowledge", async (req, res) => {
  try {
    const { question, answer, category } = req.body;
    if (!question || !answer) return res.status(400).json({ error: "question, answer шаардлагатай" });
    const prisma = getPrisma();
    const item = await prisma.turuuKnowledge.create({ data: { orgId: req.org.orgId, question, answer, category } });
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /client/knowledge/:id
router.put("/knowledge/:id", async (req, res) => {
  try {
    const { question, answer, category, active } = req.body;
    const prisma = getPrisma();
    const item = await prisma.turuuKnowledge.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!item) return res.status(404).json({ error: "Not found" });
    const updated = await prisma.turuuKnowledge.update({
      where: { id: req.params.id },
      data: { ...(question && { question }), ...(answer && { answer }), ...(category !== undefined && { category }), ...(active !== undefined && { active }) },
    });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /client/knowledge/:id
router.delete("/knowledge/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const item = await prisma.turuuKnowledge.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!item) return res.status(404).json({ error: "Not found" });
    await prisma.turuuKnowledge.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /client/settings
router.get("/settings", async (req, res) => {
  try {
    const prisma = getPrisma();
    const rows = await prisma.turuuSettings.findMany({ where: { orgId: req.org.orgId } });
    const map = {};
    rows.forEach((r) => { map[r.key] = r.value; });
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /client/settings
router.put("/settings", async (req, res) => {
  try {
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    const ops = Object.entries(req.body).map(([key, value]) =>
      prisma.turuuSettings.upsert({
        where: { orgId_key: { orgId, key } },
        create: { orgId, key, value: String(value) },
        update: { value: String(value) },
      })
    );
    await Promise.all(ops);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /client/profile
router.get("/profile", async (req, res) => {
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: req.org.orgId },
      select: { id: true, name: true, slug: true, email: true, plan: true, status: true, fbPageId: true, fbPageToken: true, telegramBotToken: true, telegramChatId: true, createdAt: true },
    });
    res.json(org);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /client/profile/facebook
router.put("/profile/facebook", async (req, res) => {
  try {
    const { fbPageId, fbPageToken } = req.body;
    if (!fbPageId || !fbPageToken) return res.status(400).json({ error: "fbPageId, fbPageToken шаардлагатай" });
    const prisma = getPrisma();
    await prisma.organization.update({
      where: { id: req.org.orgId },
      data: { fbPageId, fbPageToken },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /client/profile/telegram
router.put("/profile/telegram", async (req, res) => {
  try {
    const { telegramBotToken, telegramChatId } = req.body;
    const prisma = getPrisma();
    await prisma.organization.update({
      where: { id: req.org.orgId },
      data: { telegramBotToken: telegramBotToken || null, telegramChatId: telegramChatId || null },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
