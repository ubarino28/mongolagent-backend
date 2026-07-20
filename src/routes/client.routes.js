"use strict";
const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Resend } = require("resend");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { getPrisma } = require("../lib/db");
const { clientAuthMiddleware, blockIfExpired } = require("../middleware/clientAuth");
const { requireFeature, getOrgPlan, kbLimit, planAllows, PLAN_LABEL } = require("../lib/planFeatures");
const { logAudit } = require("../services/audit.service");
const { saveLead, saveConsultation, saveOrder } = require("../services/lead.service");
const { sendText } = require("../services/facebook.service");
const storeSync = require("../services/storeSync.service");
const cache = require("../lib/cache");
const { mergedTemplates } = require("../lib/categoryAttributes");
const { applySubscriptionPayment, applyTopupPayment } = require("../services/payment.service");
const { encrypt, decrypt } = require("../lib/secretCrypto");

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Зургийн хэмжээ хэтэрсэн байна (дээд тал нь 5MB)" });
    }
    return res.status(400).json({ error: "Файл хүлээн авахад алдаа гарлаа" });
  }
  next(err);
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const API_URL = process.env.API_URL || "https://mongolagent-backend.onrender.com";
const FRONTEND_URL = process.env.FRONTEND_APP_URL || "https://mongolagent-app.vercel.app";
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@mongolagent.mn";
const FB_CALLBACK = `${API_URL}/client/profile/facebook/callback`;

// Facebook OAuth state-ийг HMAC-аар гарын үсэг зурж/баталгаажуулна.
// (өмнө state нь зүгээр base64(JSON{orgId}) байсан тул халдагч дурын orgId-той state
//  зохиож callback дуудах боломжтой байсан — CSRF/буруу tenant-д холбох эрсдэл.)
const FB_STATE_SECRET = process.env.FB_STATE_SECRET || process.env.JWT_SECRET || "fb-oauth-state";
function signFbState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", FB_STATE_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyFbState(state) {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", FB_STATE_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
}

// Facebook OAuth callback — auth middleware байхгүй (Facebook-аас ирдэг)
router.get("/profile/facebook/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.redirect(`${FRONTEND_URL}/profile?fb_error=true`);

  try {
    const parsed = verifyFbState(state);
    if (!parsed?.orgId || (parsed.ts && Date.now() - parsed.ts > 15 * 60 * 1000)) {
      console.error("[FB OAuth] state баталгаажсангүй (хүчингүй эсвэл хугацаа дууссан)");
      return res.redirect(`${FRONTEND_URL}/profile?fb_error=true`);
    }
    const { orgId } = parsed;

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

// ─── Эрхийн хамгаалалт (store.routes.js-тэй ИЖИЛ зарчим, дүрэм нь lib/rbac.js-д) ──
// Өмнө нь энэ файлд эрхийн шалгалт ОГТ байгаагүй тул "viewer" ажилтан мэдлэгийн
// санг устгах, имэйл солих (бүртгэл булаах), төлбөр хийх боломжтой байсан.
const { requireOwner, blockViewerWrites } = require("../lib/rbac");

// viewer зөвхөн ХАРНА. Салгасан модулиудыг ч хамгаалахын тулд mount-аас ӨМНӨ байрлана.
// Заавар туслах (/assistant) нь read-only ТУСЛАМЖ — POST боловч viewer-т ч нээлттэй байлгана.
router.use((req, res, next) => {
  if (req.path === "/assistant" || req.path.startsWith("/assistant/")) return next();
  return blockViewerWrites(req, res, next);
});

// Салгасан модулиуд (client.routes.js-ийг багасгах — зан төлөв ижил хэвээр)
router.use(require("./client/restaurant.routes"));
router.use(require("./client/appointments.routes"));
router.use(require("./client/team.routes"));

// GET /client/profile/facebook/auth-url
router.get("/profile/facebook/auth-url", requireOwner, (req, res) => {
  const state = signFbState({ orgId: req.org.orgId, ts: Date.now() });
  const scope = [
    "pages_messaging",
    "pages_show_list",
    "pages_manage_metadata",
    "pages_read_engagement",      // хуудасны пост/engagement унших (пост тайлан)
    "instagram_basic",            // холбогдсон IG account унших
    "instagram_manage_messages",  // Instagram DM хариулах
  ].join(",");

  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${process.env.FB_APP_ID}&redirect_uri=${encodeURIComponent(FB_CALLBACK)}&scope=${scope}&state=${state}`;
  res.json({ url });
});

// POST /client/profile/facebook/select-page
router.post("/profile/facebook/select-page", requireOwner, async (req, res) => {
  try {
    const { pageId, pageName, pageToken, instagramId } = req.body;
    if (!pageId || !pageToken) return res.status(400).json({ error: "pageId, pageToken шаардлагатай" });

    // Page эзэмшил баталгаажуулна — дамжуулсан pageToken тухайн pageId-г ҮНЭХЭЭР удирддаг эсэх.
    // (өмнө client-ийн дамжуулсан pageId/pageToken-д шууд итгэдэг байсан тул хортой хэрэглэгч
    //  өөр хүний Page ID-г булааж webhook урсгалыг өөр луугаа татах боломжтой байсан.)
    try {
      const me = await axios.get("https://graph.facebook.com/v19.0/me", {
        params: { access_token: pageToken, fields: "id" },
      });
      if (!me.data?.id || String(me.data.id) !== String(pageId)) {
        return res.status(403).json({ error: "Page token энэ хуудсанд тохирохгүй байна" });
      }
    } catch (verr) {
      console.error("[select-page] token verify failed:", verr.response?.data || verr.message);
      return res.status(403).json({ error: "Page token баталгаажсангүй" });
    }

    const prisma = getPrisma();
    await prisma.organization.update({
      where: { id: req.org.orgId },
      data: {
        fbPageId: pageId,
        fbPageToken: encrypt(pageToken), // C2: at-rest шифрлэлт (ENCRYPTION_KEY-гүй бол NO-OP)
        ...(instagramId && { instagramAccountId: instagramId }),
      },
    });
    res.json({ ok: true, pageName });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/facebook/posts — холбогдсон хуудасны сүүлийн постууд + engagement тайлан.
// pages_read_engagement эрхээр ажиллана. 5 минут кэшлэнэ (Graph API-г хэт олон дуудахгүй).
router.get("/facebook/posts", async (req, res) => {
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: req.org.orgId }, select: { fbPageId: true, fbPageToken: true },
    });
    if (!org?.fbPageId || !org?.fbPageToken) {
      return res.json({ connected: false, posts: [], summary: null });
    }
    const { fetchPagePosts } = require("../services/facebookInsights.service");
    const data = await cache.getOrSet(`fbposts:${req.org.orgId}`, 5 * 60_000, async () => {
      const token = decrypt(org.fbPageToken) || process.env.FB_PAGE_ACCESS_TOKEN;
      return fetchPagePosts(org.fbPageId, token, 25);
    });
    res.json({ connected: true, ...data });
  } catch (e) {
    // Graph API алдаа (токен хүчингүй, эрх хүрэлцэхгүй г.м) — цэвэр мессеж буцаана
    const fbErr = e.response?.data?.error?.message;
    console.error("[fb-posts]", fbErr || e.message);
    res.status(502).json({ error: fbErr ? `Facebook: ${fbErr}` : "Постуудыг татахад алдаа гарлаа" });
  }
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
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
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
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
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
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
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
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// PUT /client/consultations/:id
router.put("/consultations/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const c = await prisma.turuuConsultation.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!c) return res.status(404).json({ error: "Not found" });
    const updated = await prisma.turuuConsultation.update({ where: { id: req.params.id }, data: { status: req.body.status } });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
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
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/conversations/:psid
router.get("/conversations/:psid", async (req, res) => {
  try {
    const prisma = getPrisma();
    const chat = await prisma.turuuChat.findFirst({ where: { psid: req.params.psid, orgId: req.org.orgId } });
    if (!chat) return res.status(404).json({ error: "Not found" });
    res.json(chat);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/conversations/:psid/reply
router.post("/conversations/:psid/reply", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId } });
    if (!org?.fbPageToken) return res.status(400).json({ error: "Facebook холбогдоогүй байна" });

    await sendText(req.params.psid, text, decrypt(org.fbPageToken));

    const chat = await prisma.turuuChat.findFirst({ where: { psid: req.params.psid, orgId: req.org.orgId } });
    const messages = Array.isArray(chat?.messages) ? [...chat.messages] : [];
    messages.push({ role: "assistant", content: `[Admin] ${text}` });
    await prisma.turuuChat.upsert({
      where: { orgId_psid: { orgId: req.org.orgId, psid: req.params.psid } },
      create: { psid: req.params.psid, orgId: req.org.orgId, messages, aiPaused: true, handoffRequested: true, handoffAt: new Date() },
      update: { messages, aiPaused: true, handoffRequested: true, handoffAt: new Date() },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
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
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// PUT /client/conversations/ai-pause-all — Бүх чатын AI унтраах/асаах
router.put("/conversations/ai-pause-all", async (req, res) => {
  try {
    const prisma = getPrisma();
    const paused = !!req.body.paused;
    const result = await prisma.turuuChat.updateMany({
      where: { orgId: req.org.orgId },
      data: { aiPaused: paused },
    });
    res.json({ ok: true, aiPaused: paused, updated: result.count });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// PUT /client/conversations/:psid/ai-pause — AI түр унтраах/асаах
router.put("/conversations/:psid/ai-pause", async (req, res) => {
  try {
    const prisma = getPrisma();
    const paused = !!req.body.paused;
    await prisma.turuuChat.upsert({
      where: { orgId_psid: { orgId: req.org.orgId, psid: req.params.psid } },
      create: { psid: req.params.psid, orgId: req.org.orgId, aiPaused: paused },
      update: { aiPaused: paused },
    });
    res.json({ ok: true, aiPaused: paused });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/knowledge
router.get("/knowledge", async (req, res) => {
  try {
    const prisma = getPrisma();
    const _take = 500;
    const _skip = (Math.max(1, Number(req.query.page) || 1) - 1) * _take;
    const items = await prisma.turuuKnowledge.findMany({ where: { orgId: req.org.orgId }, orderBy: { createdAt: "asc" }, take: _take, skip: _skip });
    res.json(items);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/knowledge
// Сөрөг үнэ/үлдэгдэл KB-д орохоос сэргийлнэ — variants[].stock сөрөг эсвэл тоо биш бол,
// эсвэл answer текстэд "Үнэ: -..." гэх мэт сөрөг үнэ бичигдсэн бол буцаана.
function validateKnowledgeInput(answer, variants) {
  if (/Үнэ\s*:\s*-\s*[\d,]/i.test(answer || "")) return "Үнэ сөрөг тоо байж болохгүй";
  if (Array.isArray(variants)) {
    for (const v of variants) {
      if (v?.stock != null && (!Number.isFinite(Number(v.stock)) || Number(v.stock) < 0)) {
        return "Үлдэгдэл (stock) сөрөг тоо байж болохгүй";
      }
    }
  }
  return null;
}

// Барааны үзүүлэлт { "Чадал": "2000W" }-ыг ариутгана — зөвхөн утгатай мөрийг, богиносгож үлдээнэ.
// Хоосон обьект/буруу төрөл бол null (DB bloat-аас сэргийлнэ).
function cleanAttributes(attributes) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return null;
  const out = {};
  for (const [k, v] of Object.entries(attributes)) {
    const key = String(k).trim().slice(0, 40);
    const val = (v == null ? "" : String(v)).trim().slice(0, 200);
    if (key && val) out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : null;
}

router.post("/knowledge", async (req, res) => {
  try {
    const { question, answer, category, imageUrl, variants, attributes } = req.body;
    if (!question || !answer) return res.status(400).json({ error: "question, answer шаардлагатай" });
    const validationError = validateKnowledgeInput(answer, variants);
    if (validationError) return res.status(400).json({ error: validationError });
    const prisma = getPrisma();
    // Мэдлэгийн сангийн багтаамжийн лимит (план бүр: 100 / 500 / 2,000 / ∞)
    const plan = await getOrgPlan(req.org.orgId);
    const limit = kbLimit(plan);
    if (Number.isFinite(limit)) {
      const count = await prisma.turuuKnowledge.count({ where: { orgId: req.org.orgId } });
      if (count >= limit) {
        return res.status(403).json({ error: `${PLAN_LABEL[plan] || "Таны"} багцын мэдлэгийн сангийн багтаамж (бараа + мэдээлэл нийт ${limit}) дүүрсэн байна. Илүү нэмэхийн тулд багцаа дээшлүүлээрэй.`, code: "KB_LIMIT", limit });
      }
    }
    const item = await prisma.turuuKnowledge.create({
      data: { orgId: req.org.orgId, question, answer, category, imageUrl: imageUrl || null, variants: variants ?? null, attributes: cleanAttributes(attributes) },
    });
    // Вэбсайттай (Store-той) org бол барааг вэбсайтын Product руу автоматаар тусгана
    await storeSync.syncKnowledgeToStore(req.org.orgId, item);
    res.json(item);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// PUT /client/knowledge/:id
router.put("/knowledge/:id", async (req, res) => {
  try {
    const { question, answer, category, active, imageUrl, variants, attributes } = req.body;
    const validationError = validateKnowledgeInput(answer, variants);
    if (validationError) return res.status(400).json({ error: validationError });
    const prisma = getPrisma();
    const item = await prisma.turuuKnowledge.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!item) return res.status(404).json({ error: "Not found" });
    const updated = await prisma.turuuKnowledge.update({
      where: { id: req.params.id },
      data: {
        ...(question && { question }),
        ...(answer && { answer }),
        ...(category !== undefined && { category }),
        ...(active !== undefined && { active }),
        ...(imageUrl !== undefined && { imageUrl: imageUrl || null }),
        ...(variants !== undefined && { variants: variants ?? null }),
        ...(attributes !== undefined && { attributes: cleanAttributes(attributes) }),
      },
    });
    await storeSync.syncKnowledgeToStore(req.org.orgId, updated);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// DELETE /client/knowledge/:id
router.delete("/knowledge/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const item = await prisma.turuuKnowledge.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!item) return res.status(404).json({ error: "Not found" });
    await prisma.turuuKnowledge.delete({ where: { id: req.params.id } });
    await storeSync.removeStoreProductForKnowledge(req.org.orgId, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// DELETE /client/knowledge — бүх мэдлэгийн санг устгана (frontend-ийн "Дахин эхлүүлэх" товчинд)
router.delete("/knowledge", async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.turuuKnowledge.deleteMany({ where: { orgId: req.org.orgId } });
    await storeSync.removeAllSyncedProducts(req.org.orgId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── CATEGORY ATTRIBUTE TEMPLATES ─────────────────────────────────────────────
// Ангилал бүрийн үзүүлэлтийн загвар (Чадал/Хүчдэл/Материал г.м). Org өөрийн загвараа
// TuruuSettings key "category_attributes"-д JSON хэлбэрээр хадгална. GET нь анхдагч + org-ийн
// загварыг нэгтгэж буцаана.

// GET /client/category-attributes
router.get("/category-attributes", async (req, res) => {
  try {
    const prisma = getPrisma();
    const row = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId: req.org.orgId, key: "category_attributes" } } });
    let orgTemplates = {};
    if (row?.value) { try { orgTemplates = JSON.parse(row.value); } catch { /* буруу JSON — анхдагч */ } }
    res.json({ templates: mergedTemplates(orgTemplates) });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// PUT /client/category-attributes — { templates: { "<ангилал>": [{ key, unit? }] } }
router.put("/category-attributes", async (req, res) => {
  try {
    const { templates } = req.body;
    if (!templates || typeof templates !== "object") return res.status(400).json({ error: "templates шаардлагатай" });
    // Ариутгал: зөвхөн key-тэй, богино нэр/нэгжтэй үзүүлэлтийг үлдээнэ (bloat/misuse-аас сэргийлнэ)
    const clean = {};
    for (const [cat, attrs] of Object.entries(templates)) {
      if (!Array.isArray(attrs)) continue;
      const list = attrs
        .filter((a) => a && typeof a.key === "string" && a.key.trim())
        .slice(0, 20)
        .map((a) => ({
          key: String(a.key).trim().slice(0, 40),
          ...(a.unit ? { unit: String(a.unit).trim().slice(0, 12) } : {}),
          ...(a.eg ? { eg: String(a.eg).trim().slice(0, 40) } : {}),
        }));
      clean[String(cat).trim().slice(0, 60)] = list;
    }
    const prisma = getPrisma();
    await prisma.turuuSettings.upsert({
      where: { orgId_key: { orgId: req.org.orgId, key: "category_attributes" } },
      create: { orgId: req.org.orgId, key: "category_attributes", value: JSON.stringify(clean) },
      update: { value: JSON.stringify(clean) },
    });
    res.json({ templates: mergedTemplates(clean) });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/upload — зураг Supabase Storage-д байршуулна
router.post("/upload", upload.single("file"), handleUploadError, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file шаардлагатай" });
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: "Зөвхөн зураг (jpg, png, webp, gif) оруулна уу" });

    const ext = req.file.originalname.split(".").pop().toLowerCase();
    const filename = `${req.org.orgId}/${Date.now()}.${ext}`;
    const supabase = getSupabase();

    const { error } = await supabase.storage.from("turuuai-assets").upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) {
      console.error("[client/upload] Supabase storage error:", error.message);
      return res.status(500).json({ error: "Зураг байршуулахад серверийн алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу." });
    }

    const { data } = supabase.storage.from("turuuai-assets").getPublicUrl(filename);
    res.json({ url: data.publicUrl });
  } catch (e) {
    console.error("[client/upload] Error:", e.message);
    res.status(500).json({ error: "Зураг байршуулахад серверийн алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу." });
  }
});

// PUT /client/profile/logo — компанийн лого шинэчилнэ
router.put("/profile/logo", async (req, res) => {
  try {
    const { logoUrl } = req.body;
    if (!logoUrl) return res.status(400).json({ error: "logoUrl шаардлагатай" });
    const prisma = getPrisma();
    await prisma.organization.update({ where: { id: req.org.orgId }, data: { logoUrl } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// KB merge helper functions
const PRODUCT_ROOT = "Бүтээгдэхүүн";
const PRODUCT_PREFIX = "Бүтээгдэхүүн / ";

function normKB(s) {
  return s.toLowerCase()
    .replace(/[?!。？！.,;:]/g, "")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function kbSimilarity(a, b) {
  const wa = new Set(normKB(a).split(" ").filter((w) => w.length > 1));
  const wb = new Set(normKB(b).split(" ").filter((w) => w.length > 1));
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 ? intersection / union : 0;
}

// decrement_stock/increment_stock-д ашиглах бараа хайлт — "Jordan 1" мэт нэг оронтой
// тоо агуулсан нэрсийг "Jordan 1 Low"/"Jordan 1 High"-аас ялгахын тулд digit токеныг хадгална.
function productWords(s) {
  return new Set(
    normKB(s).split(" ").filter((w) => w.length > 1 || /^\d+$/.test(w))
  );
}

function productSimilarity(a, b) {
  const wa = productWords(a);
  const wb = productWords(b);
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 ? intersection / union : 0;
}

function mergeAnswers(existing, newAnswer) {
  // Маш ижил бол урт нь дэлгэрэнгүйг нь ав
  if (kbSimilarity(existing, newAnswer) >= 0.7) {
    return existing.length >= newAnswer.length ? existing : newAnswer;
  }
  // Өөр мэдээлэл байвал нэмэлт болгон залга
  const trimExist = existing.trimEnd();
  const sep = trimExist.endsWith(".") ? " " : ". ";
  return `${trimExist}${sep}${newAnswer.trim()}`;
}

// Барааны variant-уудыг нэгтгэнэ — size+color таарвал stock-ыг шинэчилж,
// таарахгүй бол шинэ variant болгон нэмнэ.
function mergeVariants(existing, incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return existing || null;
  const result = Array.isArray(existing) ? [...existing] : [];
  const key = (v) => `${(v.size || "").trim().toLowerCase()}|${(v.color || "").trim().toLowerCase()}`;
  for (const v of incoming) {
    const idx = result.findIndex((r) => key(r) === key(v));
    if (idx >= 0) {
      result[idx] = { ...result[idx], ...v };
    } else {
      result.push(v);
    }
  }
  return result;
}

// GPT variants талбарыг хоосон үлдээж "M размер, улаан өнгийн нийт 50 ширхэг" гэх мэт
// мэдээллийг answer текст рүү бичсэн тохиолдолд — нөөц (fallback) болгож задлана.
const VARIANT_TEXT_PATTERNS = [
  // <size> размер..., <color> өнг..., [нийт] <N> ш[ирхэг]
  /(\S+)\s*размер\p{L}*[,.\s]*\s*(\S+)\s*өнг\p{L}*[,.\s]*\s*(?:нийт\s*)?(\d+)\s*ш\p{L}*/iu,
  // <color> өнг..., <size> размер..., [нийт] <N> ш[ирхэг]
  /(\S+)\s*өнг\p{L}*[,.\s]*\s*(\S+)\s*размер\p{L}*[,.\s]*\s*(?:нийт\s*)?(\d+)\s*ш\p{L}*/iu,
];

function cleanupAnswerText(answer, matched) {
  return answer
    .replace(matched, "")
    .replace(/\s*\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,.\s]+|[,.\s]+$/g, "")
    .trim();
}

function extractVariantFromAnswer(answer) {
  if (!answer) return null;
  for (let i = 0; i < VARIANT_TEXT_PATTERNS.length; i++) {
    const m = answer.match(VARIANT_TEXT_PATTERNS[i]);
    if (m) {
      const variant = i === 0
        ? { size: m[1], color: m[2], stock: parseInt(m[3], 10) }
        : { color: m[1], size: m[2], stock: parseInt(m[3], 10) };
      return { variant, cleanedAnswer: cleanupAnswerText(answer, m[0]) };
    }
  }
  // size/color дурдалгаагүй, зөвхөн тоо ширхэг
  const onlyCount = answer.match(/нийт\s*(\d+)\s*ш\p{L}*/iu);
  if (onlyCount) {
    const variant = { stock: parseInt(onlyCount[1], 10) };
    return { variant, cleanedAnswer: cleanupAnswerText(answer, onlyCount[0]) };
  }
  return null;
}

// GPT-ийн өгсөн (эсвэл текстээс задалсан) category-г, variant мэдээлэлтэй бол
// "Бүтээгдэхүүн / <дэд ангилал>" хэлбэрт албан журмаар оруулна.
function normalizeProductCategory(category) {
  const trimmed = (category || "").trim();
  if (!trimmed) return PRODUCT_ROOT;
  if (trimmed.toLowerCase().startsWith("бүтээгдэхүүн")) {
    const sub = trimmed.split("/")[1]?.trim();
    return sub ? `${PRODUCT_PREFIX}${sub}` : PRODUCT_ROOT;
  }
  return `${PRODUCT_PREFIX}${trimmed}`;
}

// POST /client/settings/builder — Builder AI: бизнесийн мэдээллээс мэдлэгийн сан үүсгэнэ
router.post("/settings/builder", blockIfExpired, async (req, res) => {
  try {
    const { message, history = [], imageUrl } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message шаардлагатай" });

    const userContent = imageUrl
      ? `${message.trim()}\n\n[ХАВСАРГАСАН ЗУРАГНЫ URL: ${imageUrl}]`
      : message.trim();

    const orgId = req.org.orgId;
    const prisma = getPrisma();
    const OpenAI = require("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Бизнесийн чиглэлийг keyword-аар серверт detect хийнэ (AI-д найдахгүй)
    const allText = [message, ...history.filter((h) => h.role === "user").map((h) => h.content)].join(" ").toLowerCase();
    let serverDetectedType = null;
    if (/эмнэлэг|клиник|emneleg|klinik|clinic|шүд|shud|эмч|emch|hospital/.test(allText)) serverDetectedType = "clinic";
    else if (/салон|salon|гоо сайх|goo saih|beauty|үсчин|uschin|усчин|стилист|stylist|маникюр|manicur/.test(allText)) serverDetectedType = "salon";
    else if (/ресторан|restoran|restaurant|кафе|cafe|хоолны|hoolni|зоогийн|zoogiin|тогооч|togooch|пицц|pizz/.test(allText)) serverDetectedType = "restaurant";
    else if (/дэлгүүр|delguur|shop|store|худалд|hudald|бараа|baraa|онлайн.*дэлгүүр|online.*shop/.test(allText)) serverDetectedType = "shop";

    // Одоо байгаа KB-г ачаалж Builder-д мэдүүлнэ
    const existingKB = await prisma.turuuKnowledge.findMany({
      where: { orgId, active: true },
      select: { id: true, question: true, answer: true, variants: true },
    });
    console.log("[BUILDER]", { orgId, kbCount: existingKB.length });

    const existingKBSummary = existingKB.length > 0
      ? existingKB.map((k) => {
          let line = `— ${k.question}: ${k.answer.slice(0, 80)}${k.answer.length > 80 ? "..." : ""}`;
          if (Array.isArray(k.variants) && k.variants.length > 0) {
            const variantStr = k.variants
              .map((v) => `${v.size || ""}${v.size && v.color ? "/" : ""}${v.color || ""}: ${v.stock ?? 0}ш`)
              .join(", ");
            line += `\n   variants: ${variantStr}`;
          }
          return line;
        }).join("\n")
      : "Хоосон";

    const INIT_BLOCK = existingKB.length === 0
      ? `━━━━━━━━━━━━━━━━━━━━━━━━━
ЭХЛЭХ (__INIT__)
━━━━━━━━━━━━━━━━━━━━━━━━━
Яг ийм мессежээр эхэл:
"Сайн байна уу! 😊 Таны AI chatbot-ыг тохируулъя.

Би хэдэн асуулт асуух бөгөөд та хариулахад л хангалттай — бусдыг нь би автоматаар тохируулна.

**Эхний асуулт:**
Компанийнхаа нэр болон ямар чиглэлийн бизнес эрхэлдгээ товч танилцуулаач?
Нийтлэг жишээ: "Номин цэцэг — гэрийн ургамал, цэцгийн дэлгүүр. УБ-д 3 салбартай, онлайн захиалга хүлээн авдаг.""
`
      : `━━━━━━━━━━━━━━━━━━━━━━━━━
ЭХЛЭХ (__INIT__) — KB аль хэдийн байна
━━━━━━━━━━━━━━━━━━━━━━━━━
Мэдлэгийн санд ${existingKB.length} зүйл байна. Дээрх KB жагсаалтыг судлаад:
1. ТАНИХ асуулт болон сонгогдсон багцын 7 асуулт тус бүрийн хариулт KB-д бий эсэхийг тодорхойл
2. Зөвхөн ДУТУУ асуултуудыг асуу — аль хэдийн байгааг дахин асуухгүй
3. Бүх асуулт хариулагдсан байвал шууд save_knowledge_items + save_business_profile дуудаж дуусга
Эхний мессежэд аль асуултууд дутуу байгааг тоочиж хэлэх хэрэггүй — зүгээр эхний дутуу асуултаа асуу.
`;

    const RESTART_BLOCK = `━━━━━━━━━━━━━━━━━━━━━━━━━
ДАХИН ЭХЛҮҮЛЭХ — ҮРГЭЛЖ БАТАЛГААЖУУЛАЛТ ШААРДЛАГАТАЙ
━━━━━━━━━━━━━━━━━━━━━━━━━
Хэрэглэгч "эхнээс эхлүүлэх", "дахин тохируулах", "бүгдийг устгаад шинээр эхэл" гэх мэт хүсэлт гаргавал clear_knowledge-г ШУУД ХЭЗЭЭ Ч бүү дуудаарай — KB-д хэдэн зүйл байгаас үл хамаарч ЗААВАЛ баталгаажуулах асуулт асуу.

Яг дараах байдлаар асуу:
"⚠️ Танай мэдлэгийн санд одоогоор ${existingKB.length} зүйл байгаа. Үүнийг бүгдийг нь устгаад эхнээс тохируулахад итгэлтэй байна уу?
— Тийм гэвэл бүх мэдлэгийн сан устаж, шинээр тохиргоо эхэлнэ
— Үгүй гэвэл одоогийн тохиргоо хэвээр хадгалагдана"

→ Хэрэглэгч "Тийм", "за", "тийм ээ", "устга", "эхэл" гэх мэт ИЛТ ЗӨВШӨӨРСӨН хариулт өгсний ДАРАА Л clear_knowledge функцийг дуудна.
→ clear_knowledge амжилттай дуудсаны ДАРАА ЗААВАЛ шууд ТАНИХ АСУУЛТЫГ асуу:
  "Мэдлэгийн санг цэвэрлэлээ! Эхнээс эхэлцгээе 😊

  Компанийнхаа нэр болон ямар чиглэлийн бизнес эрхэлдгээ товч хэлнэ үү?
  Жишээ: 'Бид ABC Shop — онлайн дэлгүүр' / 'Бид Belle Studio — гоо сайхны салон'"
→ "Үгүй", "болих", "хэрэггүй", "болио" гэвэл clear_knowledge ХЭЗЭЭ Ч ДУУДАХГҮЙ — "Ойлголоо, тохиргоо хэвээрээ үлдлээ 👍" гэж хариулаад өөрчлөлт хийхгүй.`;

    const STOCK_BLOCK = `━━━━━━━━━━━━━━━━━━━━━━━━━
ҮЛДЭГДЭЛ ХАСАХ / НЭМЭХ
━━━━━━━━━━━━━━━━━━━━━━━━━
Хэрэглэгч "X-н нэг ширхэгийг хас", "X зарлаа", "stock хас", "нэгийг хас" гэх мэт хэлэхэд:
→ decrement_stock функцийг дуудаж бодитоор хасна — save_knowledge_items ДУУДАХГҮЙ.
→ ok: true → "✅ [бараа] [размер/өнгө] — хасагдлаа. Үлдэгдэл: [remaining]ш"
→ ok: false → "⚠️ Тохирох бараа/variant олдсонгүй. Нэр, размер, өнгийг тодруулна уу."

Хэрэглэгч "X-г нийт үлдэгдэл дээр нэм", "X ширхэг ирлээ", "нөөц нэмэгдлээ" гэх мэт хэлэхэд:
→ increment_stock функцийг дуудаж бодитоор нэмнэ — save_knowledge_items ДУУДАХГҮЙ.
→ ok: true → "✅ [бараа] [размер/өнгө] — нэмэгдлээ. Үлдэгдэл: [remaining]ш"
→ ok: false → "⚠️ Тохирох бараа/variant олдсонгүй. Нэр, размер, өнгийг тодруулна уу."

→ Tool result-д "ambiguous: true" ирвэл — энэ нэрэнд тохирох ХЭДЭН бараа байгаа тул аль нь болохыг шийдэж чадахгүй байна гэсэн үг. "candidates" жагсаалтыг хэрэглэгчид харуулж "Аль бараа вэ — [candidates]?" гэж тодруулах асуулт асуу. ДАХИН decrement_stock/increment_stock бүү дуудаарай — хэрэглэгчийн хариултыг хүлээ.

→ Дээрх "ОДОО БАЙГАА МЭДЛЭГИЙН САН"-д variants (размер/өнгө/үлдэгдэл) харагдаж байгаа — "бүх размер/өнгө дээр нэм/хас" гэх мэт хүсэлтэд ЗӨВХӨН дээрх жагсаалтад бодитоор байгаа variant-уудаар л increment_stock/decrement_stock-г дуудна (таамаглаж бусад размер бүү үүсгэ).

→ Аль ч тохиолдолд баталгаажуулах асуулт АСУУХГҮЙ — функцийг шууд дуудна.
🚫 Хэрэглэгчийн хүсэлтэд тохирох tool (decrement_stock / increment_stock / save_knowledge_items гэх мэт) ОЛДОХГҮЙ бол ХЭЗЭЭ Ч save_knowledge_items-г ойролцоо/санаатай мэдээллээр бүү дуудаарай — зүгээр "Уучлаарай, энэ үйлдлийг одоогоор дэмжихгүй байна" гэх мэт байгалийн хариу өг.`;

    let BUILDER_SYSTEM;

    if (existingKB.length >= 7) {
      // ── САЙЖРУУЛАХ ГОРИМ: chatbot тохируулагдсан, хэрэглэгч мэдлэгийн санг шинэчилж байна ──
      BUILDER_SYSTEM = `Чи мэдлэгийн санг хялбархан шинэчлэхэд туслах AI.
Хэрэглэгч мэдээлэл нэмэх, байгааг өөрчлөх, эсвэл ямар мэдээлэл байгааг асуувал тодорхой, байгалийн байдлаар тусал.

━━━━━━━━━━━━━━━━━━━━━━━━━
ОДОО БАЙГАА МЭДЛЭГИЙН САН (${existingKB.length} зүйл)
━━━━━━━━━━━━━━━━━━━━━━━━━
${existingKBSummary}

━━━━━━━━━━━━━━━━━━━━━━━━━
ХЭРЭГЛЭГЧ ЮУ ХЭЛЭХЭД ЯАЖ ХАРИУЛАХ
━━━━━━━━━━━━━━━━━━━━━━━━━

А. KB-ийн агуулгыг асуусан ("ямар мэдээлэл байна?", "хүргэлт байна уу?", "юу хадгалагдсан бэ?" гэх мэт):
→ save_knowledge_items ДУУДАХГҮЙ — зүгээр дээрх KB жагсаалтыг шалгаад шууд хариул.
→ KB-д байвал: "Танай хүргэлтийн мэдээлэл: [KB-ийн агуулга]" гэж харуул.
→ KB-д байхгүй бол: "Хүргэлтийн мэдээлэл одоогоор хадгалагдаагүй байна — нэмэх үү?" гэж хэл.
→ Асуулт тавих хэрэггүй — мэдлэгийн санг чи аль хэдийн харж байна.

Б. Өөрчлөхийг/нэмэхийг хүссэн — шинэ УТГА ӨГӨӨГҮЙ:
→ Тухайн нэг зүйлийн шинэ утгыг НЭГ Л асуулт асуу. Өөр юу ч асуухгүй.
→ Жишээ: "хамрах хүрээ өөрчлөгдсөн" → "Хамрах хүрээ ямар болсон бэ?"
→ Жишээ: "үнэ өссөн" → "Шинэ үнэ хэд болсон бэ?"
→ Хэрэглэгч хариулсаны дараа В руу шил.

В. Шинэ утга өгсөн (эсвэл Б-ийн хариулт):
→ save_knowledge_items ШУУД дуудаж хадгал — "Хадгалах уу?", "Ингэж хадгалах уу?" гэх мэт баталгаажуулах асуулт АСУУЛГҮЙГЭЭР. Мэдээлэл (нэр/үнэ/размер/өнгө/тоо) дутуугүй байвал эргэлзэлгүй ШУУД дуудна — variant олон байх нь хойшлуулах шалтгаан БИШ.
→ 🏷️ CATEGORY ШИЙДВЭР (заавал дагах):
   • Хэрэв энэ бол тодорхой БҮТЭЭГДЭХҮҮН/БАРАА тухай мэдээлэл (нэр + үнэ/размер/өнгө/зураг зэрэг тодорхой нэг бараанд хамаарах) бол category-г ЗААВАЛ "Бүтээгдэхүүн / <дэд ангилал>" хэлбэрээр бич.
   • <дэд ангилал>-ыг ЗААВАЛ Монгол КИРИЛЛ бичгээр бич — хэрэглэгч латин үсгээр ("tsamts", "gutal") бичсэн ч кирилл рүү хөрвүүлж бич ("Цамц", "Гутал").
   • Дээрх "ОДОО БАЙГАА МЭДЛЭГИЙН САН"-д "Бүтээгдэхүүн / ..." эхэлсэн ижил төстэй дэд ангилал байвал яг тэр нэрийг давтан ашигла — шинэ хувилбар (өөр бичигдэлтэй ижил утгатай) бүү үүсгэ.
   • Бизнесийн ерөнхий мэдээлэл (компани, хүргэлт, цаг, FAQ, бодлого г.м.) бол "Бүтээгдэхүүн / ..." АШИГЛАХГҮЙ — ердийн category (Компани, Хүргэлт, FAQ г.м.) ашигла.
   • Мэдээлэл нь СЭДВИЙН дагуу: хүргэлттэй холбоотой бол category "Хүргэлт", буцаалт/солилт/гомдлын журамтай холбоотой бол category "Буцаалт", төлбөртэй холбоотой бол category "Төлбөр" гэж ангилж хадгал — "Үйлчилгээ" гэх мэт ерөнхий category-д хольж хадгалахгүй. Эдгээр нь зөвхөн жишээ — category-н тоо ХЯЗГААРГҮЙ, агуулгад хамгийн тохирох category нэрийг чи өөрөө шийдэж ашиглана.
   • ⚠️ Аль хэдийн "Бүтээгдэхүүн / ..." гэж тогтсон бараанд НЭМЭЛТ мэдээлэл (размер, өнгө, үлдэгдэл, нэмэлт зураг г.м.) өгч байгаа бол category-г ХЭВЭЭР "Бүтээгдэхүүн / <ижил дэд ангилал>" гэж бич — ердийн category руу СОЛИХГҮЙ.
   • Хэрэв БҮТЭЭГДЭХҮҮНИЙ мэдээлэлд размер/өнгө/үлдэгдлийн тоо орсон бол (жишээ: "M размер, улаан өнгөтэй, нийт 50 ширхэг") — энэ мэдээллийг variants массивт {size, color, stock} хэлбэрээр оруул. "answer" (тайлбар) дотор тоо хэмжээгээ ДАВТАН БИЧИХГҮЙ — зөвхөн үнэ/материал/онцлог зэрэг тайлбарыг бич.
   • 📌 ЖИШЭЭ (1 variant): хэрэглэгч "цамц категори нээгээд 50 ширхэг нэмээрэй, нэр нь Свитер, өнгө нь улаан, M размер" гэвэл →
     save_knowledge_items({ items: [{ question: "Свитер", answer: "Хөнгөн даавуу", category: "Бүтээгдэхүүн / Цамц", variants: [{ size: "M", color: "Улаан", stock: 50 }] }] })
     (category-д ЗААВАЛ "Бүтээгдэхүүн / " угтвар орно, "answer"-д хэмжээ/тоо ДАВТАГДАХГҮЙ, variants-д size/color/stock тусдаа орно.)
   • 📌 ЖИШЭЭ (ОЛОН variant НЭГ мессежинд): хэрэглэгч "гутал нэмэх гэсэн юм, нэр нь Puma Suede, S размерт 5ш, M размерт 8ш, L размерт 3ш, бүгд хар өнгөтэй, үнэ 120,000₮" гэвэл →
     save_knowledge_items({ items: [{ question: "Puma Suede", answer: "Үнэ: 120,000₮", category: "Бүтээгдэхүүн / Гутал", variants: [{ size: "S", color: "Хар", stock: 5 }, { size: "M", color: "Хар", stock: 8 }, { size: "L", color: "Хар", stock: 3 }] }] })
     ⚠️ variants массивт ХЭДЭН ч ширхэг {size, color, stock} обьект орж болно (2, 3, 5+ ялгаатай хэмжээ/өнгийн хослол ч гэсэн) — variant-уудын тоо олон байх нь баталгаажуулах асуулт асуух шалтгаан БОЛОХГҮЙ. Бүх variant тодорхой (тоо, размер/өнгө өгөгдсөн) л бол ЭРГЭЛЗЭЛГҮЙ шууд save_knowledge_items дуудна.
→ KB-д ижил сэдвийн зүйл байвал — тэр зүйлийн question текстийг ашигла (overlap ихснэ → шинэчлэгдэнэ).
→ Tool result-д merged > 0 → "Солигдлоо ✅"
→ Tool result-д created > 0 → "Нэмэгдлээ ✅"
→ Дараа нь Г руу шил.

Г. Хадгалсны ДАРАА ГАГЦХАН (В дуусаагүй бол энэ хэсгийг ХЭРЭГЖҮҮЛЭХГҮЙ):
→ Дээрх KB жагсаалтад ОГТООС байхгүй чухал мэдээлэл байвал ГАНЦХАН товч санал болго.
→ KB-д аль хэдийн байгаа зүйлийг санал болгохгүй — "Солигдлоо ✅" эсвэл "Нэмэгдлээ ✅" гэж хариулаад зогс.

━━━━━━━━━━━━━━━━━━━━━━━━━
ХЭЗЭЭ Ч ХИЙХГҮЙ
━━━━━━━━━━━━━━━━━━━━━━━━━
✗ Хэрэглэгч KB-ийн агуулга асуухад "Хүргэлт байгаа уу?" гэх мэт дахин асуулт тавихгүй — KB-г өөрөө шалгаад хариул
✗ "Захиалга яаж хийгддэг вэ?", "Буцаалтын бодлого?" гэх мэт хэрэглэгч санаачлаагүй асуулт асуухгүй
✗ 8 асуултын дараалал — ЭНЭ ГОРИМД БАЙХГҮЙ, хэзээ ч дагахгүй
✗ Нэг хариулт дотор 2+ асуулт асуухгүй
✗ Урт тайлбар, алхамлал, жагсаалт хийхгүй — 1-2 өгүүлбэр хангалттай
✗ "Хадгалъя уу?", "Зөв үү?" гэх баталгаажуулах асуулт — шууд хадгал

${STOCK_BLOCK}

${RESTART_BLOCK}`;
    } else {
      BUILDER_SYSTEM = `Чи Монголын бизнес эздэд AI chatbot тохируулахад туслах мэргэжилтэн.
Зорилго: ТАНИХ асуулт + сонгогдсон салбарын 7 асуулт (нийт 8 алхам) асуугаад KB + AI persona бүтээнэ.

━━━━━━━━━━━━━━━━━━━━━━━━━
ОДОО БАЙГАА МЭДЛЭГИЙН САН (${existingKB.length} зүйл)
━━━━━━━━━━━━━━━━━━━━━━━━━
${existingKBSummary}
→ Дээрх асуултууд KB-д байгаа тул тэдгээрийг ЗААВАЛ алгасаж дараагийн дутуу асуултаа асуу.
→ Шинэ эсвэл гүнзгийрүүлэх мэдээлэл байвал нэм.

${INIT_BLOCK}

━━━━━━━━━━━━━━━━━━━━━━━━━
0️⃣ ТАНИХ АСУУЛТ — ХАМГИЙН ЭХЭНД ЗААВАЛ АСУУХ
━━━━━━━━━━━━━━━━━━━━━━━━━
Бусад бүх зүйлээс өмнө ЭХЛЭЭД дараах НЭГ асуултыг тусад нь асууна:

"Эхлээд компанийнхаа нэр болон ямар чиглэлийн бизнес эрхэлдгээ товч танилцуулаач?
Нийтлэг жишээ: "Бид Энержи Шүдний Эмнэлэг — шүдний эмчилгээ хийдэг" / "Бид ABC Shop — онлайн дэлгүүр, гутал хувцас худалдаалдаг" / "Бид Belle Studio — үс засалт, гоо сайхны салон" / "Бид Эко Клин — байшин, оффис цэвэрлэгээний үйлчилгээ""

Энэ хариултыг авсны дараа:
1. Компанийн НЭР болон ҮЙЛ АЖИЛЛАГААНЫ мэдээллийг шууд тэмдэглэж ав — энэ мэдээлэл KB-д ордог тул дараа дахин асуухгүй.

2. 🚨 ЗААВАЛ ДАГАХ ШИЙДВЭРИЙН ДАРААЛАЛ (нэг л удаа эхэнд шийднэ — асуулт болгон бүү харьц, ШУУД ГҮЙЦЭТГЭ):
Хариултыг ЯМАР ҮСГЭЭР бичигдсэн байсан ч (Кирилл, Латин галиг, холимог, цэг таслал/зайгүй, "shudnii emneleg", "shudn emnlg", "шудний эмнэлэг" гэх мэт хэлбэрүүд БҮГД АДИЛ УТГАТАЙ) — ҮСЭГ ТААРУУЛАХ БИШ, УТГААР НЬ ОЙЛГОЖ дараах дарааллаар, эхний таарсан тохиолдолд зогсож шийд:

ХЭРЭВ хариултын УТГА "эмнэлэг/клиник/шүдний эмнэлэг/эмчилгээ/эмч/өвчтөн/үзлэг" зэрэг ЭМНЭЛГИЙН ҮЙЛЧИЛГЭЭ гэдгийг ИЛЭРХИЙ ХЭЛЖ БАЙВАЛ:
   → чиглэл ТОДОРХОЙ БОЛЛОО. Цаашид зөвхөн "Б. ЭМНЭЛЭГ / КЛИНИК" багцыг ашигла.

ЭСВЭЛ ХЭРЭВ хариултын УТГА "салон/үсчин/гоо сайхан/стилист/маникюр" зэрэг ГОО САЙХНЫ ҮЙЛЧИЛГЭЭ гэдгийг ИЛЭРХИЙ ХЭЛЖ БАЙВАЛ:
   → чиглэл ТОДОРХОЙ БОЛЛОО. Цаашид зөвхөн "В. САЛОН / ГОО САЙХАН" багцыг ашигла.

ЭСВЭЛ ХЭРЭВ хариултын УТГА "ресторан/зоогийн газар/кафе/хоолны газар/паб/бар/пиццерия/тогооч/хоол" зэрэг ХООЛ ҮЙЛДВЭРЛЭЛ/ЗООГИЙН ГАЗАР гэдгийг ИЛЭРХИЙ ХЭЛЖ БАЙВАЛ:
   → чиглэл ТОДОРХОЙ БОЛЛОО. Цаашид зөвхөн "Г. РЕСТОРАН / ХООЛНЫ ГАЗАР" багцыг ашигла.

ЭСВЭЛ ХЭРЭВ хариулт ЗӨВХӨН компанийн нэрийг л агуулж, үйл ажиллагааны мэдээлэл ОГТ ӨГӨӨГҮЙ бол (жишээ нь зүгээр нэрээ хэлээд зогссон):
   → ГАНЦХАН удаа дараах тодруулах асуултыг ас:
   "Ямар чиглэлийн үйл ажиллагаа явуулдаг компани вэ — бараа зардаг уу, үйлчилгээ үзүүлдэг үү, эсвэл өөр зүйл вэ?
   Жишээ: "Бид онлайн дэлгүүр — гэр ахуйн бараа худалдаалдаг" / "Бид сургалтын төв — англи хэлний сургалт явуулдаг" / "Бид зөвлөх газар — бизнес стратегийн зөвлөгөө өгдөг""
   — энэ хариултаар ч тодорхойгүй л бол → "А. ЕРӨНХИЙ" багцыг ашигла.

🚫 ЭНЭ ШИЙДВЭРИЙГ ХИЙСНИЙ ДАРАА ЗААВАЛ ДАГАХ ХЯЗГААРЛАЛТ:
Нэг хариултанд "чиглэл тодорхой боллоо" гэдгийг ОЙЛГОСОН ХЭДИЙ Ч — БАТАЛГААЖУУЛАХ ӨГҮҮЛБЭР БИЧЭЭД ТҮҮНИЙ АРД ДАХИН ТОДРУУЛАХ АСУУЛТ НЭМЖ БОЛОХГҮЙ ("чиглэл тодорхой боллоо" + "ямар чиглэлийн..." гэдгийг ХАМТ хэзээ ч бүү бич — энэ нь зөрчилтэй). Чиглэл (эмнэлэг/гоо сайхан) ИЛЭРХИЙ танигдсан тохиолдолд НЭГ МЕССЕЖИНД зөвхөн дараахаас аль нэгийг л хийнэ:
   (a) шууд сонгосон бүлгийн 1️⃣ асуултыг ас, ЭСВЭЛ
   (b) "Таны компани [нэр] нь [чиглэл] эрхэлдэг гэдгийг ойлголоо 👍" гэх мэт 1 өгүүлбэрээр баталгаажуулаад, ШУУД ДАРААЛАН тухайн бүлгийн 1️⃣ асуултыг ас.
Аль ч тохиолдолд "Ямар чиглэлийн үйл ажиллагаа явуулдаг компани вэ — бараа зардаг уу..." гэсэн тодруулах асуултыг ОГТ АШИГЛАХГҮЙ — учир нь чиглэл хэдийнэ тодорхой болсон.

⚠️ "А. ЕРӨНХИЙ" бол ХАМГИЙН СҮҮЛИЙН сонголт — зөвхөн эмнэлэг, гоо сайхны утга огт илрээгүй үед л ашиглана.

${serverDetectedType ? `\n🚨 СЕРВЕРЭЭС ТОДОРХОЙЛСОН БИЗНЕСИЙН ЧИГЛЭЛ: "${serverDetectedType === "clinic" ? "Б. ЭМНЭЛЭГ / КЛИНИК" : serverDetectedType === "salon" ? "В. САЛОН / ГОО САЙХАН" : serverDetectedType === "restaurant" ? "Г. РЕСТОРАН / ХООЛНЫ ГАЗАР" : "А. ЕРӨНХИЙ"}" — ЭНЭ БАГЦЫГ ЗААВАЛ АШИГЛА, дүрмийн 2-р алхамыг алгасаж шууд 1️⃣ асуултаас эхэл.\n` : ""}
3. Сонгосон багцаа 1-7 асуултын турш ТОГТВОРТОЙ ашигла — дунд нь бүү сольж.
⚠️ Компанийн нэр, чиглэл аль хэдийн мэдэгдсэн тул сонгосон багцад ДАХИН "КОМПАНИ" асуулт асуухгүй — нийт ЗӨВХӨН 7 асуулт асууна.

━━━━━━━━━━━━━━━━━━━━━━━━━
А. ЕРӨНХИЙ 7 АСУУЛТ
━━━━━━━━━━━━━━━━━━━━━━━━━

Асуулт бүрийн АРД заавал "Нийтлэг жишээ:" оруулна.
Нэг мессежид НЭГХЭН асуулт. Хариулт авсны дараа дараагийнх руу шил.

1️⃣ ГОЛ ХЭРЭГЛЭГЧ
"Танай гол хэрэглэгчид хэн бэ — нас, хэрэгцээ, байршил?
Нийтлэг жишээ: "25-45 насны УБ-д амьдардаг эмэгтэйчүүд. Ажлын завгүй учраас цэвэрлэгээгээ аутсорс хийдэг.""

2️⃣ ДАВУУ ТАЛ
"Өрсөлдөгчдөөсөө юугаараа ялгардаг вэ?
Нийтлэг жишээ: "Байгалийн ногоон цэвэрлэгч бодис ашигладаг, ажилчид бүгд сургалттай, хохирол даатгалтай.""

3️⃣ БҮТЭЭГДЭХҮҮН / ҮЙЛЧИЛГЭЭНИЙ ЧИГЛЭЛ
"Ямар бүтээгдэхүүн эсвэл үйлчилгээ үзүүлдэг вэ? Онцлог шинж юу вэ?
Нийтлэг жишээ: "Гэр ахуйн цэвэрлэгээ, оффис цэвэрлэгээ. Байгалийн бодис ашигладаг, 2-3 цагт хийж дуусна."
(Үнийг Dashboard-аас нэмнэ — энд асуухгүй)"

4️⃣ БАЙНГА АСУУДАГ АСУУЛТУУД (FAQ)
"Хэрэглэгчид хамгийн ихэвчлэн ямар асуулт тавьдаг вэ? 3-5 асуулт хариулттай нь бичнэ үү.
Нийтлэг жишээ: "Хүргэлт хэдэн хоногт ирдэг? — УБ-т 1-2 хоног. / Баталгаат хугацаа хэд вэ? — 1 жил. / Хэмжээ буруу бол солидог уу? — Тийм, 7 хоногийн дотор авчирвал солино.""

5️⃣ АЖЛЫН ЦАГ + ХҮРГЭЛТ + ХЯМДРАЛ
"Ажлын цаг хэд вэ? Хүргэлтийн нөхцөлөө хэлнэ үү — хамрах хүрээ (аль хот/дүүрэг), хүргэлтийн төлбөр, хэдэн хоногт хүргэдэг, ямар үнээс дээш захиалгад үнэгүй болохыг хэлнэ үү. Мөн хямдрал/урамшуулал байгаа бол хэлээрэй (жишээ нь тодорхой дүнгээс дээш авбал хямдрах).
Нийтлэг жишээ: "Да-Ба 9:00-20:00, Ня 10:00-18:00. Зөвхөн УБ хот, 1-2 хоногт хүргэнэ. Хүргэлт 6,000₮, 100,000₮-аас дээш үнэгүй. 200,000₮-аас дээш авбал 10% хямдрал.""

6️⃣ ЗАХИАЛГА + БУЦААЛТ
"Захиалга яаж хийгддэг, буцаалт эсвэл гомдлын бодлого ямар байдаг вэ?
Нийтлэг жишээ: "Мессежээр захиалга авна, 50% урьдчилгаа төлбөр. Гомдол байвал 24 цагийн дотор дахин үнэгүй үйлчилнэ.""

7️⃣ AI-ИЙН ЗАН ЧАНАР
"Chatbot тань үргэлж эелдэгээр 'та' гэж хандах болно, emoji ашиглаж болно 😊 — танд ямар өнгө аястай санагдаж байна вэ (найрсаг уу, мэргэжлийн үү)? Хориглох сэдэв байвал хэлнэ үү?
Нийтлэг жишээ: "Найрсаг, мэргэжлийн өнгө аястай. Үнийн хямдрал санал болгохгүй, өрсөлдөгч дурдахгүй.""

━━━━━━━━━━━━━━━━━━━━━━━━━
Б. ЭМНЭЛЭГ / КЛИНИК — 7 АСУУЛТ
━━━━━━━━━━━━━━━━━━━━━━━━━

1️⃣ ГОЛ ХЭРЭГЛЭГЧ
"Танай үйлчлүүлэгчид голчлон хэн бэ — нас, хүйс, ямар асуудалтай ханддаг вэ?
Жишээ: "20-50 насны хүмүүс. Шүдний өвдөлт, цайруулалт, гажиг заслуулахаар ханддаг.""

2️⃣ ДАВУУ ТАЛ
"Бусад эмнэлгээс юугаараа ялгардаг вэ — тоног төхөөрөмж, эмчийн туршлага, үнэ?
Жишээ: "Орчин үеийн дижитал тоног төхөөрөмжтэй, мэргэшсэн эмч нартай, өвдөлт багатай эмчилгээний арга ашигладаг.""

3️⃣ ТУСЛАМЖ ҮЙЛЧИЛГЭЭНИЙ ЧИГЛЭЛ
"Ямар төрлийн тусламж үйлчилгээ үзүүлдэг вэ? Онцлог шинж юу вэ?
Жишээ: "Шүдний эмчилгээ, цэвэрлэлт, гажиг засал. Өвдөлтгүй эмчилгээний арга ашигладаг."
(Дэлгэрэнгүй үйлчилгээ, үнийг Dashboard-ын 'Эмч нар' хэсгээс нэмнэ — энд асуухгүй)"

4️⃣ БАЙНГА АСУУДАГ АСУУЛТУУД (FAQ)
"Үйлчлүүлэгчид хамгийн ихээр юу асуудаг вэ? 3-5 асуулт хариулттай нь бичнэ үү.
Жишээ: "Эмчилгээ өвддөг үү? — Мэдээ алдуулалттай тул бараг өвдөхгүй. / Даатгал авдаг уу? — Тийм, ХЭТ даатгалтай хамтардаг. / Яаралтай үед хүлээж авдаг уу? — Тийм, өдрийн турш яаралтай үзлэг авна.""

5️⃣ ЦАГ ЗАХИАЛГА + АЖЛЫН ЦАГ
"Цаг захиалга яаж хийдэг, ажлын цаг хэд вэ?
Жишээ: "Утас эсвэл Messenger-ээр цаг захиална. Да-Бя 9:00-19:00, Бя 10:00-15:00.""

6️⃣ ТӨЛБӨР + ЦУЦЛАЛТЫН ЖУРАМ
"Төлбөр яаж төлдөг, цаг цуцлах бол ямар журамтай вэ?
Жишээ: "Үзлэгийн дараа төлнө — бэлэн, картаар авна. Цаг цуцлах бол 24 цагийн өмнө мэдэгдэнэ үү.""

7️⃣ AI-ИЙН ЗАН ЧАНАР
"Chatbot тань үргэлж эелдэгээр 'та' гэж хандах болно, emoji ашиглаж болно 😊 — танд ямар өнгө аястай санагдаж байна вэ (итгэл төрүүлсэн үү, тайван уу)? Хориглох сэдэв байвал хэлнэ үү?
Жишээ: "Итгэл төрүүлсэн, тайван өнгө аястай. Онош өгөхгүй — зөвхөн ерөнхий мэдээлэл хуваалцана.""

━━━━━━━━━━━━━━━━━━━━━━━━━
В. САЛОН / ГОО САЙХАН — 7 АСУУЛТ
━━━━━━━━━━━━━━━━━━━━━━━━━

1️⃣ ГОЛ ХЭРЭГЛЭГЧ
"Үйлчлүүлэгчид голчлон хэн бэ — нас, хүйс, ямар хэв маягт дуртай вэ?
Жишээ: "20-40 насны эмэгтэйчүүд. Орчин үеийн загвар, өнгө будалт, арчилгаанд дуртай.""

2️⃣ ДАВУУ ТАЛ
"Бусад салонгоос юугаараа ялгардаг вэ — стилистийн ур чадвар, бүтээгдэхүүн, орчин?
Жишээ: "Олон улсын сертификаттай стилистүүд, органик материал ашигладаг, тав тухтай орчинтой.""

3️⃣ ҮЙЛЧИЛГЭЭНИЙ ЧИГЛЭЛ
"Ямар төрлийн үйлчилгээ үзүүлдэг вэ? Онцлог шинж юу вэ?
Жишээ: "Үс засалт, будалт, маникюр, педикюр. Органик материал ашигладаг."
(Дэлгэрэнгүй үйлчилгээ, үнийг Dashboard-ын 'Мастерууд' хэсгээс нэмнэ — энд асуухгүй)"

4️⃣ БАЙНГА АСУУДАГ АСУУЛТУУД (FAQ)
"Үйлчлүүлэгчид хамгийн их юу асуудаг вэ? 3-5 асуулт хариулттай нь бичнэ үү.
Жишээ: "Цаг захиалах шаардлагатай юу? — Тийм, урьдчилан захиална уу. / Материалаа авчрах хэрэгтэй юу? — Үгүй, бид бэлдсэн байдаг. / Хүүхдэд үйлчилдэг үү? — Тийм, 5-аас дээш насны хүүхдэд үйлчилнэ.""

5️⃣ ЦАГ ЗАХИАЛГА + АЖЛЫН ЦАГ
"Цаг захиалга яаж хийдэг, ажлын цаг хэд вэ?
Жишээ: "Messenger эсвэл утсаар захиална. Да-Ня 10:00-20:00 тогтмол ажиллана.""

6️⃣ ТӨЛБӨР + ЦУЦЛАЛТЫН ЖУРАМ
"Төлбөрийн болон цаг цуцлалтын журам ямар вэ?
Жишээ: "Үйлчилгээний дараа төлнө — бэлэн, картаар авна. Цаг цуцлах бол 3 цагийн өмнө мэдэгдэнэ үү.""

7️⃣ AI-ИЙН ЗАН ЧАНАР
"Chatbot тань үргэлж эелдэгээр 'та' гэж хандах болно, emoji ашиглаж болно 😊 — танд ямар өнгө аястай санагдаж байна вэ (дотно уу, урам зоригтой уу)? Хориглох сэдэв байвал хэлнэ үү?
Жишээ: "Дотно, урам зоригтой, эерэг өнгө аястай.""

━━━━━━━━━━━━━━━━━━━━━━━━━
Г. РЕСТОРАН / ХООЛНЫ ГАЗАР — 7 АСУУЛТ
━━━━━━━━━━━━━━━━━━━━━━━━━

1️⃣ ГОЛ ХЭРЭГЛЭГЧ
"Танай зочдод голчлон хэн бэ — нас, үйл явдал (гэр бүлээр, найзуудтай, бизнес уулзалт)?
Жишээ: "25-45 насны ажилтай хүмүүс. Өдрийн цайны цаг, оройн зоог, найзуудтайгаа уулзалт.""

2️⃣ ДАВУУ ТАЛ
"Бусад ресторануудаас юугаараа ялгардаг вэ — хоолны чанар, орчин, тогооч?
Жишээ: "Монгол уламжлалт хоолны орчин үеийн хувилбар, Францын сургуультай тогоочтой, органик бүтээгдэхүүн ашигладаг.""

3️⃣ ХООЛНЫ ЧИГЛЭЛ + ОНЦЛОГ
"Ямар төрлийн хоол бэлтгэдэг вэ? Онцлог шинж юу вэ?
Жишээ: "Монгол уламжлалт хоол, европ хоол. Органик мах, гар бэлдмэл гоймон ашигладаг. Вегетариан меню бас байгаа."
(Дэлгэрэнгүй меню, үнийг Dashboard-ын 'Меню' хэсгээс нэмнэ — энд асуухгүй)"

4️⃣ БАЙНГА АСУУДАГ АСУУЛТУУД (FAQ)
"Зочид хамгийн их юу асуудаг вэ? 3-5 асуулт хариулттай нь бичнэ үү.
Жишээ: "Хүргэлт хийдэг үү? — Тийм, 5км дотор хүргэнэ. / Урьдчилж захиалах шаардлагатай юу? — Ширээ захиалга утсаар авна. / Вегетариан меню байгаа юу? — Тийм, тусгай меню байна.""

5️⃣ ШИРЭЭ ЗАХИАЛГА + АЖЛЫН ЦАГ
"Ширээ захиалга яаж хийдэг, ажлын цаг хэд вэ? Хэдэн ширээтэй, хамгийн том ширээ хэдэн хүнтэй вэ?
Жишээ: "Messenger эсвэл утсаар захиална. Да-Ня 11:00-22:00. 15 ширээтэй, хамгийн том нь 8 хүний.""

6️⃣ ХҮРГЭЛТ + АВАХ ЗАХИАЛГА
"Take-away / хүргэлтийн үйлчилгээ байгаа юу? Хүргэлтийн нөхцөл ямар вэ?
Жишээ: "Take-away захиалга авна. Хүргэлт 5км дотор 3,000₮, 50,000₮-аас дээш захиалгад үнэгүй. 30-45 минутад хүргэнэ.""

7️⃣ AI-ИЙН ЗАН ЧАНАР
"Chatbot тань үргэлж эелдэгээр 'та' гэж хандах болно, emoji ашиглаж болно 😊 — танд ямар өнгө аястай санагдаж байна вэ? Хориглох сэдэв байвал хэлнэ үү?
Жишээ: "Найрсаг, урин дулаан өнгө аястай. Бусад ресторан дурдахгүй, хямдрал амлахгүй.""

━━━━━━━━━━━━━━━━━━━━━━━━━
МЭДЭЭЛЭЛ ЦУГЛУУЛАХ ЗАРЧИМ
━━━━━━━━━━━━━━━━━━━━━━━━━
— Клиент нэгэн зэрэг олон зүйл өгч болно — бүгдийг хүлээн ав, давтан асуухгүй
— "Мэдэхгүй", "байхгүй" гэвэл алгасаж дараагийнхыг асуу
— Төлбөрийн хэлбэр АСУУХГҮЙ

━━━━━━━━━━━━━━━━━━━━━━━━━
БҮТЭЭГДЭХҮҮНИЙ ЗУРАГ ХАВСАРГАХ
━━━━━━━━━━━━━━━━━━━━━━━━━
Хэрэглэгчийн мессежийн төгсгөлд "[ХАВСАРГАСАН ЗУРАГНЫ URL: https://...]" гэсэн тэмдэглэгээ харагдвал — энэ бол тухайн мессежид дурдсан тодорхой бүтээгдэхүүн/бараанд хамаарах зураг. save_knowledge_items дуудахдаа яг тухайн барааны Q&A зүйлийн imageUrl талбарт энэ URL-г шууд хуулж оруул (бусад зүйлд бүү давхар оруул). Дараа нь хэрэглэгчид зургийг хүлээн авснаа эелдэгээр баталгаажуул, жишээ нь: "📸 Зургийг хүлээн авлаа — [бараа]-нд холбож хадгаллаа ✅".

━━━━━━━━━━━━━━━━━━━━━━━━━
TOOL ДУУДАХ — АСУУЛТ БҮРИЙН ДАРАА ШУУД, ЖИЖИГ ХЭМЖЭЭГЭЭР
━━━━━━━━━━━━━━━━━━━━━━━━━
🚨 ЗААВАЛ ДАГАХ ДҮРЭМ: 1️⃣-ээс 7️⃣ хүртэлх асуулт ТУС БҮРД нь хариулт авмагц ШУУДАА (дараагийн асуултыг асуухаасаа ӨМНӨ) тухайн ганц хариултыг save_knowledge_items функцээр ЯГ НЭГ Q&A зүйлтэйгээр дуудаж хадгал:
   { question: "<асуултын утга>", answer: "<хэрэглэгчийн өгсөн хариулт>", category: "<тухайн асуултын сэдэв — жишээ нь 'Гол хэрэглэгч', 'Давуу тал', 'Үйлчилгээ ба үнэ', 'FAQ', 'Цаг захиалга', 'Хүргэлт', 'Төлбөр ба цуцлалт', 'AI зан чанар'>" }
⚠️ "А. ЕРӨНХИЙ" багцын 5️⃣ асуулт (АЖЛЫН ЦАГ + ХҮРГЭЛТ + ХЯМДРАЛ): хэрэглэгчийн хариултыг СЭДЭВ тус бүрээр ТУСДАА save_knowledge_items зүйл болгон хадга:
   • Хүргэлтийн мэдээлэл (төлбөр/хамрах хүрээ/хугацаа/үнэгүй болох босго) → category ЗААВАЛ "Хүргэлт" (захиалгын тооцоолол search_knowledge("хүргэлт")-ээр энэ category-г хайдаг)
   • Хямдрал/урамшуулал (тодорхой дүнгээс дээш авбал хямдрах гэх мэт) → category ЗААВАЛ "Хямдрал" (search_knowledge("хямдрал")-ээр энэ category-г хайдаг)
   • Ажлын цаг → category "Ажлын цаг"
⚠️ "А. ЕРӨНХИЙ" багцын 6️⃣ асуулт (ЗАХИАЛГА + БУЦААЛТ): хэрэглэгчийн хариултыг СЭДЭВ тус бүрээр ТУСДАА save_knowledge_items зүйл болгон ангилж хадгал (дээрх "ЯГ НЭГ Q&A" дүрмийн онцгой тохиолдол) — category-н тоо ХЯЗГААРГҮЙ, агуулгад хамгийн тохирох category нэрийг чи өөрөө шийднэ. Жишээ нь:
   • Хүргэлттэй холбоотой агуулга (хэдэн хоногт хүргэх, хаана хүргэх г.м.) → category "Хүргэлт"
   • Буцаалт/солилт/гомдлын журам → category "Буцаалт"
   • Төлбөртэй холбоотой агуулга (урьдчилгаа, төлбөрийн хэлбэр) → category "Төлбөр"
   • Захиалга өгөх арга/процессын тайлбар (жишээ: "мессежээр захиална") → category "Захиалга"
   Эдгээр нь зөвхөн жишээ — агуулгад илүү тохирох өөр category нэр байвал (жишээ: "Баталгаа", "Урамшуулал" г.м.) чөлөөтэй үүсгэж ашигла. Жишээ: "Мессежээр захиалга авна, 50% урьдчилгаа төлбөр. Хэмжээ таараагүй бол 7 хоногийн дотор солино." гэсэн хариултыг 3 тусдаа item болгож (category: "Захиалга", "Төлбөр", "Буцаалт") хадгал.
Ингэснээр мэдээлэл аажмаар, жижиг хэсгүүдээр найдвартай хадгалагдана. ХЭЗЭЭ Ч бүх 7 хариултыг ТӨГСГӨЛД нь нэг дор, том багцаар хадгалахгүй — том хариулт JSON хэлбэрээр үүсгэхэд тасарч KB-д огт орохгүй болох эрсдэлтэй.

→ save_business_profile: ЗӨВХӨН 7️⃣-р асуултад хариулт авсны ДАРАА, бусад ямар ч tool-той ХАМТ биш, ДАНГААРАА нэг л удаа дуудна — компанийн бүрэн профайл, system prompt, AI persona-г үүсгэнэ.
  businessType талбарыг ЗААВАЛ тохируул: Б.ЭМНЭЛЭГ/КЛИНИК → "clinic" | В.САЛОН/ГОО САЙХАН → "salon" | Г.РЕСТОРАН/ХООЛНЫ ГАЗАР → "restaurant" | А.ЕРӨНХИЙ+бараа/онлайн дэлгүүр → "shop" | А.ЕРӨНХИЙ+бусад үйлчилгээ → "service" | тодорхойгүй → "other"

AI нэр: өгөөгүй бол компани нэрнээс үүсгэ ("Номин" → "Номин туслах")

━━━━━━━━━━━━━━━━━━━━━━━━━
ДУУСГАХ
━━━━━━━━━━━━━━━━━━━━━━━━━
save_business_profile амжилттай дуудсаны дараа яг ийм хариул:
"✅ Таны AI chatbot бэлэн боллоо!

🤖 [aiName] — [company]-ийн AI зөвлөх
📚 Мэдлэгийн сан бэлэн боллоо

'AI Чат' хэсэгт орж туршиж үзнэ үү 🚀"

${RESTART_BLOCK}`;
    }

    const BUILDER_TOOLS = [
      {
        type: "function",
        function: {
          name: "save_knowledge_items",
          description: "Q&A хэлбэрт мэдлэгийн санд хадгална. Category заавал оруулна.",
          parameters: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    question: { type: "string" },
                    answer:   { type: "string" },
                    category: { type: "string", description: "Жишээ: Бүтээгдэхүүн, Үнэ, Хүргэлт, Процесс, FAQ" },
                    imageUrl: { type: "string", description: "Хэрэглэгчийн хавсаргасан барааны зургийн URL — зөвхөн тухайн зурагтай шууд холбоотой нэг зүйлд л оруулна, өгөгдөөгүй бол орхино" },
                    variants: {
                      type: "array",
                      description: "Бүтээгдэхүүний размер/өнгө/үлдэгдэл мэдээлэл байвал л оруулна (жишээ: 'M размер, улаан өнгөтэй, нийт 50 ширхэг'). Өгөгдөөгүй бол орхино.",
                      items: {
                        type: "object",
                        properties: {
                          size:  { type: "string", description: "Размер (байвал)" },
                          color: { type: "string", description: "Өнгө (байвал)" },
                          stock: { type: "number", description: "Үлдэгдлийн тоо" },
                        },
                      },
                    },
                  },
                  required: ["question", "answer", "category"],
                },
              },
            },
            required: ["items"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "save_business_profile",
          description: "Бизнесийн бүрэн профайлыг хадгалж narrative AI persona үүсгэнэ",
          parameters: {
            type: "object",
            properties: {
              company:        { type: "string" },
              aiName:         { type: "string", description: "Өгөөгүй бол компани нэрнээс үүсгэ" },
              contact:        { type: "string" },
              description:    { type: "string", description: "Компанийн тайлбар, түүх, зорилго" },
              targetCustomers:{ type: "string", description: "Голлох хэрэглэгч: нас, хэрэгцээ" },
              differentiators:{ type: "string", description: "Өрсөлдөгчдөөс ялгарах давуу тал" },
              productDetails: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name:              { type: "string" },
                    price:             { type: "string" },
                    targetUser:        { type: "string" },
                    features:          { type: "string" },
                    objection:         { type: "string" },
                    objectionResponse: { type: "string" },
                  },
                  required: ["name"],
                },
              },
              orderProcess:   { type: "string" },
              returnPolicy:   { type: "string" },
              workingHours:   { type: "string" },
              tone: {
                type: "object",
                properties: {
                  taOrChi:  { type: "string", enum: ["та", "чи"], description: "Үргэлж 'та' гэж тохируулна — хэрэглэгчээс асуухгүй" },
                  useEmoji: { type: "boolean" },
                  style:    { type: "string" },
                },
              },
              caseStudy:      { type: "string" },
              forbiddenTopics:{ type: "string" },
              extraRules:     { type: "string" },
              businessType:   { type: "string", enum: ["shop", "salon", "clinic", "restaurant", "service", "other"], description: "Бизнесийн чиглэл: Б.ЭМНЭЛЭГ/КЛИНИК → clinic, В.САЛОН/ГОО САЙХАН → salon, Г.РЕСТОРАН/ХООЛНЫ ГАЗАР → restaurant, А.ЕРӨНХИЙ+бараа/дэлгүүр → shop, А.ЕРӨНХИЙ+бусад үйлчилгээ → service, тодорхойгүй → other" },
            },
            required: ["company"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "clear_knowledge",
          description: "Бүх мэдлэгийн санг устгаж дахин эхлэнэ",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "decrement_stock",
          description: "Бүтээгдэхүүний variant-ийн үлдэгдлийг хасна. Хэрэглэгч тухайн барааны нэг ширхэгийг зарлаа / хасаарай гэвэл дуудна.",
          parameters: {
            type: "object",
            properties: {
              productName: { type: "string", description: "Бүтээгдэхүүний нэр" },
              color: { type: "string", description: "Өнгө (байвал)" },
              size: { type: "string", description: "Размер (байвал)" },
              quantity: { type: "number", description: "Хасах тоо (default 1)" },
            },
            required: ["productName"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "increment_stock",
          description: "Бүтээгдэхүүний variant-ийн үлдэгдлийг нэмэгдүүлнэ. Хэрэглэгч 'нийт үлдэгдэл дээр нэм', 'X ширхэг ирлээ' гэх мэт хэлэхэд дуудна.",
          parameters: {
            type: "object",
            properties: {
              productName: { type: "string", description: "Бүтээгдэхүүний нэр" },
              color: { type: "string", description: "Өнгө (байвал)" },
              size: { type: "string", description: "Размер (байвал)" },
              quantity: { type: "number", description: "Нэмэх тоо (default 1)" },
            },
            required: ["productName"],
          },
        },
      },
    ];

    const messages = [
      { role: "system", content: BUILDER_SYSTEM },
      ...history.slice(-20),
      { role: "user", content: userContent },
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools: BUILDER_TOOLS,
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 2048,
    });

    const choice = response.choices[0];
    let reply = "";
    let savedItems = 0;
    let promptUpdated = false;
    let cleared = false;

    if (choice.finish_reason === "tool_calls") {
      const toolCalls = choice.message.tool_calls;
      const toolResults = [];

      for (const toolCall of toolCalls) {
        let args;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (parseErr) {
          console.error(`Builder tool JSON.parse алдаа (${toolCall.function.name}):`, parseErr.message, "raw:", toolCall.function.arguments?.slice(0, 500));
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, error: "JSON parse failed" }) });
          continue;
        }

        if (toolCall.function.name === "save_knowledge_items") {
          let created = 0, merged = 0, skipped = 0;
          const touchedIds = []; // вэбсайт руу sync хийх KB мөрүүдийн id
          // Шинэ save бүрт existingKB-г refresh хийнэ
          const currentKB = await prisma.turuuKnowledge.findMany({
            where: { orgId }, select: { id: true, question: true, answer: true, category: true, variants: true },
          });

          for (const item of args.items) {
            // Сөрөг үнэ/үлдэгдэлтэй item-ийг KB руу оруулахгүй — AI яриандаа хэлж болзошгүй
            // тоо (жишээ: "-5 ширхэг үлдсэн") эсвэл GPT-ийн буруу задласан утга орохоос сэргийлнэ.
            if (validateKnowledgeInput(item.answer, item.variants)) { skipped++; continue; }
            // GPT variants-ыг хоосон үлдээж "M размер, улаан өнгийн нийт 50 ширхэг" гэх мэт
            // мэдээллийг answer текст рүү бичсэн бол — нөөц (fallback) болгож задална.
            let effectiveVariants = Array.isArray(item.variants) && item.variants.length > 0 ? item.variants : null;
            let effectiveAnswer = item.answer;
            if (!effectiveVariants) {
              const extracted = extractVariantFromAnswer(item.answer);
              if (extracted) {
                effectiveVariants = [extracted.variant];
                effectiveAnswer = extracted.cleanedAnswer || item.answer;
              }
            }
            // Variant (размер/өнгө/үлдэгдэл) мэдээлэлтэй бол category-г "Бүтээгдэхүүн / ..."
            // хэлбэрт албан журмаар оруулна — GPT буруу/дутуу category өгсөн ч KB руу алдагдахгүй.
            const effectiveCategory = effectiveVariants ? normalizeProductCategory(item.category) : item.category;

            // Ижил утгатай KB хайна (60%+ word overlap). Зурагтай зүйлд threshold-ыг өндөрсгөж,
            // өөр бараа руу санамсаргүй merge хийгдэхээс сэргийлнэ — зураг бүр өөрийн KB зүйлтэй холбогддог.
            const mergeThreshold = item.imageUrl ? 0.85 : 0.6;
            let bestMatch = null;
            let bestScore = 0;
            for (const kb of currentKB) {
              const score = kbSimilarity(item.question, kb.question);
              if (score > bestScore) { bestScore = score; bestMatch = kb; }
            }

            if (bestMatch && bestScore >= mergeThreshold) {
              // Байгаа KB-тэй нэгтгэнэ
              const mergedAnswer = mergeAnswers(bestMatch.answer, effectiveAnswer);
              const mergedVariants = mergeVariants(bestMatch.variants, effectiveVariants);
              // Аль хэдийн "Бүтээгдэхүүн / ..." болсон зүйлийг шинэ category нь
              // тэр төрлийн биш бол санамсаргүйгээр KB руу бууруулахгүй.
              const isDowngrade = bestMatch.category?.startsWith(PRODUCT_PREFIX) && !effectiveCategory?.startsWith(PRODUCT_PREFIX);
              await prisma.turuuKnowledge.update({
                where: { id: bestMatch.id },
                data: {
                  answer: mergedAnswer,
                  ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
                  ...(effectiveCategory && !isDowngrade ? { category: effectiveCategory } : {}),
                  ...(mergedVariants ? { variants: mergedVariants } : {}),
                },
              });
              // currentKB-д шинэчилнэ (дараагийн item-д нөлөөлнө)
              bestMatch.answer = mergedAnswer;
              bestMatch.variants = mergedVariants;
              if (effectiveCategory && !isDowngrade) bestMatch.category = effectiveCategory;
              touchedIds.push(bestMatch.id);
              merged++;
            } else {
              // Шинэ KB үүсгэнэ
              const newItem = await prisma.turuuKnowledge.create({
                data: {
                  orgId, question: item.question, answer: effectiveAnswer, category: effectiveCategory || null, imageUrl: item.imageUrl || null,
                  variants: effectiveVariants,
                },
              });
              currentKB.push({ id: newItem.id, question: item.question, answer: newItem.answer, category: newItem.category, variants: newItem.variants });
              touchedIds.push(newItem.id);
              created++;
            }
          }
          savedItems += created + merged;
          // Вэбсайттай org бол шинэ/шинэчлэгдсэн барааг Product руу тусгана
          if (touchedIds.length > 0) {
            const touched = await prisma.turuuKnowledge.findMany({ where: { id: { in: touchedIds } } });
            await storeSync.syncManyKnowledgeToStore(orgId, touched);
          }
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ created, merged, ...(skipped > 0 ? { skipped, skipReason: "Сөрөг үнэ/үлдэгдэлтэй тул алгасав" } : {}) }) });
        }

        if (toolCall.function.name === "save_business_profile") {
          const { buildNarrativePrompt, extractKBFromProfile } = require("../lib/prompt");
          const autoAiName = args.aiName || (args.company ? `${args.company} туслах` : "AI туслах");
          const profile = { ...args, aiName: autoAiName };
          const narrativePrompt = buildNarrativePrompt(profile);
          const upserts = [
            { key: "ai_company",    value: args.company },
            { key: "ai_name",       value: autoAiName },
            { key: "ai_contact",    value: args.contact || "" },
            { key: "ai_profile",    value: JSON.stringify(profile) },
            { key: "system_prompt", value: narrativePrompt },
            { key: "business_type", value: args.businessType || "other" },
          ];
          for (const u of upserts) {
            await prisma.turuuSettings.upsert({
              where: { orgId_key: { orgId, key: u.key } },
              create: { orgId, key: u.key, value: u.value },
              update: { value: u.value },
            });
          }

          // Профайлын баримтат мэдээллийг KB-д хадгалж нэгтгэнэ
          const profileKBItems = extractKBFromProfile(profile);
          if (profileKBItems.length > 0) {
            const currentKBForProfile = await prisma.turuuKnowledge.findMany({
              where: { orgId }, select: { id: true, question: true, answer: true },
            });
            for (const item of profileKBItems) {
              let bestMatch = null;
              let bestScore = 0;
              for (const kb of currentKBForProfile) {
                const score = kbSimilarity(item.question, kb.question);
                if (score > bestScore) { bestScore = score; bestMatch = kb; }
              }
              if (bestMatch && bestScore >= 0.6) {
                const mergedAnswer = mergeAnswers(bestMatch.answer, item.answer);
                await prisma.turuuKnowledge.update({ where: { id: bestMatch.id }, data: { answer: mergedAnswer } });
                bestMatch.answer = mergedAnswer;
              } else {
                const newItem = await prisma.turuuKnowledge.create({
                  data: { orgId, question: item.question, answer: item.answer, category: item.category || null },
                });
                currentKBForProfile.push({ id: newItem.id, question: item.question, answer: item.answer });
              }
            }
            savedItems += profileKBItems.length;
          }

          promptUpdated = true;
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ ok: true, aiName: autoAiName, company: args.company, kbExtracted: profileKBItems.length }) });
        }

        if (toolCall.function.name === "clear_knowledge") {
          await Promise.all([
            prisma.turuuKnowledge.deleteMany({ where: { orgId } }),
            prisma.turuuAppointment.deleteMany({ where: { orgId } }),
            prisma.turuuStaff.deleteMany({ where: { orgId } }),
            prisma.turuuSettings.deleteMany({ where: { orgId, key: { in: ["business_type", "ai_name", "ai_tone"] } } }),
          ]);
          await storeSync.removeAllSyncedProducts(orgId);
          cleared = true;
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ ok: true }) });
        }

        if (toolCall.function.name === "decrement_stock" || toolCall.function.name === "increment_stock") {
          const { productName, color, size, quantity = 1 } = args;
          const allItems = await prisma.turuuKnowledge.findMany({
            where: { orgId, active: true },
            select: { id: true, question: true, variants: true },
          });

          const scored = allItems
            .map((item) => ({ item, score: productSimilarity(productName, item.question) }))
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score);

          if (scored.length === 0) {
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, error: "Бүтээгдэхүүн олдсонгүй" }) });
          } else {
            const topScore = scored[0].score;
            const topCandidates = scored.filter((s) => s.score === topScore);

            if (topScore < 1 && topCandidates.length > 1) {
              toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, ambiguous: true, candidates: topCandidates.map((c) => c.item.question) }) });
            } else {
              const bestMatch = topCandidates[0].item;
              if (Array.isArray(bestMatch.variants) && bestMatch.variants.length > 0) {
                let matched = false, newStock = null;
                const newVariants = bestMatch.variants.map((v) => {
                  if (matched) return v;
                  const colorOk = !color || normKB(v.color || "").includes(normKB(color)) || normKB(color).includes(normKB(v.color || ""));
                  const sizeOk = !size || String(v.size || "").toLowerCase() === String(size).toLowerCase();
                  if (colorOk && sizeOk) {
                    matched = true;
                    newStock = toolCall.function.name === "decrement_stock"
                      ? Math.max(0, (v.stock || 0) - quantity)
                      : (v.stock || 0) + quantity;
                    return { ...v, stock: newStock };
                  }
                  return v;
                });
                if (matched) {
                  await prisma.turuuKnowledge.update({ where: { id: bestMatch.id }, data: { variants: newVariants } });
                  // Нөөцийн өөрчлөлтийг вэбсайтын Product руу тусгана
                  const fresh = await prisma.turuuKnowledge.findUnique({ where: { id: bestMatch.id } });
                  if (fresh) await storeSync.syncKnowledgeToStore(orgId, fresh);
                  toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ ok: true, remaining: newStock, product: bestMatch.question }) });
                } else {
                  toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, error: "Тохирох variant олдсонгүй" }) });
                }
              } else {
                toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, error: "Бүтээгдэхүүн эсвэл variant олдсонгүй" }) });
              }
            }
          }
        }
      }

      const followUp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          ...messages,
          choice.message,
          ...toolResults.map((r) => ({ role: "tool", tool_call_id: r.tool_call_id, content: r.content })),
        ],
        temperature: 0.3,
        max_tokens: 512,
      });
      reply = followUp.choices[0].message.content?.trim() || "";
    } else {
      reply = choice.message.content?.trim() || "";
    }

    res.json({ reply, savedItems, promptUpdated, cleared });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/settings
router.get("/settings", async (req, res) => {
  try {
    const prisma = getPrisma();
    const rows = await prisma.turuuSettings.findMany({ where: { orgId: req.org.orgId } });
    const map = {};
    rows.forEach((r) => { map[r.key] = r.value; });
    res.json(map);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// PUT /client/settings
router.put("/settings", async (req, res) => {
  try {
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    // AI тохиргоо (загвар / өнгө аяс / max_tokens) — зөвхөн Business+. Доод планд эдгээр key-г
    // ЧИМЭЭГҮЙ ХАСНА (bot_name / system_prompt зэрэг бусад тохиргоо хадгалагдана, 403 өгөхгүй).
    const AI_CONFIG_KEYS = ["ai_model", "ai_temperature", "ai_max_tokens"];
    let body = req.body || {};
    if (AI_CONFIG_KEYS.some((k) => k in body)) {
      const plan = await getOrgPlan(orgId);
      if (!planAllows(plan, "aiConfig")) {
        body = { ...body };
        for (const k of AI_CONFIG_KEYS) delete body[k];
      }
    }
    const ops = Object.entries(body).map(([key, value]) =>
      prisma.turuuSettings.upsert({
        where: { orgId_key: { orgId, key } },
        create: { orgId, key, value: String(value) },
        update: { value: String(value) },
      })
    );
    await Promise.all(ops);
    try { require("../services/ai.service").invalidatePrompt(orgId); } catch { /* no-op */ }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── QUOTA ───────────────────────────────────────────────────────────────────

const { PLAN_QUOTA } = require("../lib/quotas");

// GET /client/quota
router.get("/quota", async (req, res) => {
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: req.org.orgId },
      select: { plan: true, messageUsed: true, quotaResetAt: true },
    });
    const quota = PLAN_QUOTA[org.plan] || 10000;
    const { getTopupRemaining } = require("../lib/quota");
    const topup = await getTopupRemaining(req.org.orgId);   // үлдсэн нэмэлт message credit (persistent)
    const used = org.messageUsed || 0;
    const effectiveQuota = quota + topup;                    // base + топ-ап
    res.json({
      plan: org.plan, quota, messageUsed: used, quotaResetAt: org.quotaResetAt,
      topup, effectiveQuota,
      remaining: Math.max(0, effectiveQuota - used),
      exhausted: used >= effectiveQuota,                      // 100% дүүрсэн → шинэ message блоклогдоно
    });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── ANALYTICS ───────────────────────────────────────────────────────────────

// GET /client/analytics
router.get("/analytics", async (req, res) => {
  try {
    // ТҮР ЗУУР demo (зөвхөн local, DEMO_ANALYTICS=1) — dashboard-ыг хиймэл өгөгдлөөр дүүргэж үзүүлнэ
    const demo = require("../lib/demoAnalytics");
    if (demo.DEMO_ON()) {
      // preset (period=today/7d/30d/all) болон календарь (from/to) хоёуланг дэмжинэ
      let demoFrom = req.query.from, demoTo = req.query.to;
      if (!demoFrom && !demoTo) {
        const p = req.query.period || "30d";
        const now = new Date();
        demoTo = now.toISOString().slice(0, 10);
        if (p === "today") demoFrom = demoTo;
        else if (p === "7d") demoFrom = new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10);
        else if (p === "all") demoFrom = new Date(now.getTime() - 179 * 86400000).toISOString().slice(0, 10);
        else demoFrom = new Date(now.getTime() - 29 * 86400000).toISOString().slice(0, 10); // 30d
      }
      return res.json(demo.demoAnalytics(demoFrom, demoTo));
    }
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    // Кэш — dashboard analytics. 30с TTL; захиалга/төлбөр орох үед invalidate.
    const cacheKeyA = `analytics:${orgId}:${req.query.period || "all"}:${req.query.from || ""}:${req.query.to || ""}`;
    const cachedAnalytics = cache.get(cacheKeyA);
    if (cachedAnalytics !== undefined) return res.json(cachedAnalytics);

    const [totalConversations, totalLeads, totalConsultations, totalOrders, newLeads,
      dailyMessages, dailyLeads] = await Promise.all([
      prisma.turuuChat.count({ where: { orgId } }),
      prisma.turuuLead.count({ where: { orgId } }),
      prisma.turuuConsultation.count({ where: { orgId } }),
      prisma.turuuOrder.count({ where: { orgId } }),
      prisma.turuuLead.count({ where: { orgId, status: "NEW" } }),
      prisma.$queryRaw`
        SELECT DATE("updatedAt") as date, COUNT(*)::int as count
        FROM "TuruuChat"
        WHERE "orgId" = ${orgId} AND "updatedAt" >= NOW() - INTERVAL '30 days'
        GROUP BY DATE("updatedAt") ORDER BY date ASC`,
      prisma.$queryRaw`
        SELECT DATE("createdAt") as date, COUNT(*)::int as count
        FROM "TuruuLead"
        WHERE "orgId" = ${orgId} AND "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY DATE("createdAt") ORDER BY date ASC`,
    ]);

    // Орлогын тооцоолол — period (today/7d/30d/all) ЭСВЭЛ from/to (календарь огноогоор шүүх)
    const period = req.query.period || "all";
    const fromQ = req.query.from ? new Date(req.query.from) : null;
    const toQ = req.query.to ? new Date(req.query.to) : null;
    if (toQ) toQ.setHours(23, 59, 59, 999);
    let periodFilter;
    if (fromQ || toQ) {
      periodFilter = { ...(fromQ ? { gte: fromQ } : {}), ...(toQ ? { lte: toQ } : {}) };
    } else {
      periodFilter = period === "today" ? { gte: new Date(new Date().setHours(0, 0, 0, 0)) }
        : period === "7d" ? { gte: new Date(Date.now() - 7 * 86400000) }
        : period === "30d" ? { gte: new Date(Date.now() - 30 * 86400000) }
        : undefined;
    }
    const dateWhere = periodFilter ? { createdAt: periodFilter } : {};
    const dailyGte = (periodFilter && periodFilter.gte) || new Date(Date.now() - 30 * 86400000);
    const dailyLte = (periodFilter && periodFilter.lte) || new Date();

    const [orderRevenue, appointmentRevenue, storeRevenue, dailyRevenue] = await Promise.all([
      prisma.turuuOrder.aggregate({ where: { orgId, status: "PAID", ...dateWhere }, _sum: { totalAmount: true }, _count: true }),
      prisma.turuuAppointment.aggregate({ where: { orgId, depositStatus: "PAID", ...dateWhere }, _sum: { depositAmount: true }, _count: true }),
      prisma.$queryRaw`SELECT COALESCE(SUM("totalAmount"), 0)::float as total, COUNT(*)::int as cnt FROM "StoreOrder" WHERE "orgId" = ${orgId} AND "status" = 'PAID'
        ${periodFilter && periodFilter.gte ? prisma.$queryRaw`AND "createdAt" >= ${periodFilter.gte}` : prisma.$queryRaw``}
        ${periodFilter && periodFilter.lte ? prisma.$queryRaw`AND "createdAt" <= ${periodFilter.lte}` : prisma.$queryRaw``}`.catch(() => [{ total: 0, cnt: 0 }]),
      prisma.$queryRaw`
        SELECT d.date, COALESCE(SUM(d.amount), 0)::float as amount FROM (
          SELECT DATE("createdAt") as date, "totalAmount" as amount FROM "TuruuOrder" WHERE "orgId" = ${orgId} AND "status" = 'PAID' AND "createdAt" >= ${dailyGte} AND "createdAt" <= ${dailyLte}
          UNION ALL
          SELECT DATE("createdAt") as date, "depositAmount" as amount FROM "TuruuAppointment" WHERE "orgId" = ${orgId} AND "depositStatus" = 'PAID' AND "createdAt" >= ${dailyGte} AND "createdAt" <= ${dailyLte}
          UNION ALL
          SELECT DATE("createdAt") as date, "totalAmount" as amount FROM "StoreOrder" WHERE "orgId" = ${orgId} AND "status" = 'PAID' AND "createdAt" >= ${dailyGte} AND "createdAt" <= ${dailyLte}
        ) d GROUP BY d.date ORDER BY d.date ASC`,
    ]);

    const revenue = {
      orders: orderRevenue._sum.totalAmount || 0,
      ordersCount: orderRevenue._count || 0,
      appointments: appointmentRevenue._sum.depositAmount || 0,
      appointmentsCount: appointmentRevenue._count || 0,
      store: Array.isArray(storeRevenue) ? (storeRevenue[0]?.total || 0) : 0,
      storeCount: Array.isArray(storeRevenue) ? (storeRevenue[0]?.cnt || 0) : 0,
      total: (orderRevenue._sum.totalAmount || 0) + (appointmentRevenue._sum.depositAmount || 0) + (Array.isArray(storeRevenue) ? (storeRevenue[0]?.total || 0) : 0),
      daily: dailyRevenue || [],
      period,
    };

    // ── Trend (сүүлийн 30 хоног vs өмнөх 30 хоног), өдрийн цуваа (sparkline), топ бараа ──
    const nowMs = Date.now();
    const d30 = new Date(nowMs - 30 * 86400000);
    const d60 = new Date(nowMs - 60 * 86400000);
    const cur = { gte: d30 };
    const prev = { gte: d60, lt: d30 };
    const [
      cChat, pChat, cLead, pLead, cCons, pCons, cOrd, pOrd,
      dailyConsultations, dailyOrders, paidOrders,
    ] = await Promise.all([
      prisma.turuuChat.count({ where: { orgId, updatedAt: cur } }),
      prisma.turuuChat.count({ where: { orgId, updatedAt: prev } }),
      prisma.turuuLead.count({ where: { orgId, createdAt: cur } }),
      prisma.turuuLead.count({ where: { orgId, createdAt: prev } }),
      prisma.turuuConsultation.count({ where: { orgId, createdAt: cur } }),
      prisma.turuuConsultation.count({ where: { orgId, createdAt: prev } }),
      prisma.turuuOrder.count({ where: { orgId, createdAt: cur } }),
      prisma.turuuOrder.count({ where: { orgId, createdAt: prev } }),
      prisma.$queryRaw`
        SELECT DATE("createdAt") as date, COUNT(*)::int as count
        FROM "TuruuConsultation"
        WHERE "orgId" = ${orgId} AND "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY DATE("createdAt") ORDER BY date ASC`,
      prisma.$queryRaw`
        SELECT DATE("createdAt") as date, COUNT(*)::int as count
        FROM "TuruuOrder"
        WHERE "orgId" = ${orgId} AND "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY DATE("createdAt") ORDER BY date ASC`,
      // Топ бараа — сонгосон period-ийн PAID захиалгуудын items (хамгийн сүүлийн 1000)
      prisma.turuuOrder.findMany({ where: { orgId, status: "PAID", ...dateWhere }, select: { items: true }, orderBy: { createdAt: "desc" }, take: 1000 }),
    ]);

    const pctDelta = (c, p) => (p === 0 ? (c > 0 ? 100 : 0) : Math.round(((c - p) / p) * 100));
    const deltas = {
      conversations: pctDelta(cChat, pChat),
      leads:         pctDelta(cLead, pLead),
      consultations: pctDelta(cCons, pCons),
      orders:        pctDelta(cOrd, pOrd),
    };

    // items (JSON) массивыг барааны нэрээр нэгтгэж борлуулалт/ширхэгээр эрэмбэлнэ
    const prodMap = {};
    for (const o of paidOrders) {
      const items = Array.isArray(o.items) ? o.items : [];
      for (const it of items) {
        const name = ((it && it.name) || "").toString().trim();
        if (!name) continue;
        const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
        const price = Math.max(0, Number(it.price) || 0);
        if (!prodMap[name]) prodMap[name] = { name, units: 0, revenue: 0 };
        prodMap[name].units += qty;
        prodMap[name].revenue += qty * price;
      }
    }
    const topProducts = Object.values(prodMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

    // Analytics (deltas / топ бараа / орлого) — бүх планд НЭЭЛТТЭЙ (Starter=Growth ижил түвшин).
    // Ирээдүйн "Дэвшилтэт analytics" (Business) нэмэлт зүйлсийг дараа тусад нь gate хийнэ.
    const analyticsPayload = {
      totalConversations, totalLeads, totalConsultations, totalOrders, newLeads,
      dailyMessages, dailyLeads, dailyConsultations, dailyOrders,
      deltas, topProducts, revenue,
    };
    cache.set(cacheKeyA, analyticsPayload, 30_000);
    res.json(analyticsPayload);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// Тайлангийн БАТАЛГААЖУУЛАЛТ — Баталгаат (QPay/вэб/цаг захиалгын гүйлгээ) vs Өөрийн мэдүүлсэн
// (данс/бэлэн гараар). Snapshot үүсгэхэд ашиглана (сервер дээр дахин бодож, клиентэд итгэхгүй).
async function computeReportIntegrity(prisma, orgId, since) {
  const [orders, storeAgg, apptAgg] = await Promise.all([
    prisma.turuuOrder.findMany({ where: { orgId, status: "PAID", createdAt: { gte: since } }, select: { paymentMethod: true, qpayStatus: true, qpayInvoiceId: true, totalAmount: true } }),
    prisma.$queryRaw`SELECT COALESCE(SUM("totalAmount"),0)::float as amount, COUNT(*)::int as cnt FROM "StoreOrder" WHERE "orgId"=${orgId} AND "status"='PAID' AND "createdAt" >= ${since}`.catch(() => [{ amount: 0, cnt: 0 }]),
    prisma.turuuAppointment.aggregate({ where: { orgId, depositStatus: "PAID", createdAt: { gte: since } }, _sum: { depositAmount: true }, _count: true }),
  ]);
  let vR = 0, vO = 0, sR = 0, sO = 0;
  for (const o of orders) {
    const verified = o.paymentMethod === "qpay" || o.qpayStatus === "PAID" || !!o.qpayInvoiceId;
    const amt = o.totalAmount || 0;
    if (verified) { vR += amt; vO += 1; } else { sR += amt; sO += 1; }
  }
  vR += storeAgg[0]?.amount || 0; vO += storeAgg[0]?.cnt || 0;
  vR += apptAgg._sum.depositAmount || 0; vO += apptAgg._count || 0;
  return { verifiedRevenue: vR, verifiedOrders: vO, selfReportedRevenue: sR, selfReportedOrders: sO, totalRevenue: vR + sR, totalOrders: vO + sO };
}

// Хүн уншихад ойлгомжтой баталгаажуулах код (андуурч болзошгүй O/0, I/1 хассан)
function genReportCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += abc[crypto.randomInt(abc.length)];
  return `MA-${s.slice(0, 4)}-${s.slice(4)}`;
}

// Тайлан төлбөр төлөгдөх үед ӨӨРЧЛӨШГҮЙ snapshot үүсгэж, баталгаажуулах кодыг буцаана.
async function createReportSnapshot(prisma, orgId, monthsRaw) {
  const N = Math.min(Math.max(parseInt(monthsRaw, 10) || 6, 1), 36);
  const since = new Date(); since.setMonth(since.getMonth() - (N - 1)); since.setDate(1); since.setHours(0, 0, 0, 0);
  const integ = await computeReportIntegrity(prisma, orgId, since);
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }).catch(() => null);
  const code = genReportCode();
  const id = crypto.randomUUID();
  const periodLabel = `${N} сар`;
  const bizName = org?.name || "Бизнес";
  const apiUrl = process.env.API_URL || "https://api.mongolagent.mn";
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ReportSnapshot" ("id","orgId","code","months","periodLabel","bizName","verifiedRevenue","selfReportedRevenue","totalRevenue","verifiedOrders","totalOrders","figures") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    id, orgId, code, N, periodLabel, bizName, integ.verifiedRevenue, integ.selfReportedRevenue, integ.totalRevenue, integ.verifiedOrders, integ.totalOrders, JSON.stringify(integ)
  );
  const url = `${apiUrl}/verify/report/${code}`;
  // QR — банк уншаад verify хуудас руу шууд ордог (код гараар бичих алхмыг халж).
  // data URL болгож үүсгэнэ → PDF (html2canvas) + хэвлэх хоёулаа барина. Алдаа гарвал
  // qr=null → app код текстээ (нөөц) харуулна, тайлан унахгүй.
  let qr = null;
  try { qr = await require("qrcode").toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: "M" }); }
  catch (e) { console.error("[report.qr]", e && e.message); }
  return { code, url, qr, bizName, periodLabel, ...integ };
}

// GET /client/report?months=N — сар бүрийн орлого/үзүүлэлт (банкны зээлийн тайлан / хар дэвтэр)
router.get("/report", async (req, res) => {
  try {
    const N = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 36);
    const demo = require("../lib/demoAnalytics");
    if (demo.DEMO_ON()) return res.json(demo.demoReport(N));
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    // Кэш — хүнд тайлан (~15+ query). 30с TTL; захиалга/төлбөр орох үед invalidate хийнэ.
    const cacheKey = `report:${orgId}:${N}`;
    const cachedReport = cache.get(cacheKey);
    if (cachedReport !== undefined) return res.json(cachedReport);
    const since = new Date(); since.setMonth(since.getMonth() - (N - 1)); since.setDate(1); since.setHours(0, 0, 0, 0);
    const mnLabel = (key) => { const [y, m] = key.split("-"); return `${y} ${parseInt(m, 10)}-р сар`; };

    const [rev, store, leads, convs, src] = await Promise.all([
      prisma.$queryRaw`
        SELECT to_char(date_trunc('month', d.created), 'YYYY-MM') as month, COALESCE(SUM(d.amount),0)::float as revenue, COUNT(*)::int as orders
        FROM (
          SELECT "createdAt" as created, "totalAmount" as amount FROM "TuruuOrder" WHERE "orgId"=${orgId} AND "status"='PAID' AND "createdAt" >= ${since}
          UNION ALL
          SELECT "createdAt" as created, "depositAmount" as amount FROM "TuruuAppointment" WHERE "orgId"=${orgId} AND "depositStatus"='PAID' AND "createdAt" >= ${since}
        ) d GROUP BY 1`,
      prisma.$queryRaw`SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') as month, COALESCE(SUM("totalAmount"),0)::float as revenue, COUNT(*)::int as orders FROM "StoreOrder" WHERE "orgId"=${orgId} AND "status"='PAID' AND "createdAt" >= ${since} GROUP BY 1`.catch(() => []),
      prisma.$queryRaw`SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') as month, COUNT(*)::int as c FROM "TuruuLead" WHERE "orgId"=${orgId} AND "createdAt" >= ${since} GROUP BY 1`,
      prisma.$queryRaw`SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') as month, COUNT(*)::int as c FROM "TuruuChat" WHERE "orgId"=${orgId} AND "createdAt" >= ${since} GROUP BY 1`,
      Promise.all([
        prisma.turuuOrder.aggregate({ where: { orgId, status: "PAID", createdAt: { gte: since } }, _sum: { totalAmount: true }, _count: true }),
        prisma.turuuAppointment.aggregate({ where: { orgId, depositStatus: "PAID", createdAt: { gte: since } }, _sum: { depositAmount: true }, _count: true }),
        prisma.$queryRaw`SELECT COALESCE(SUM("totalAmount"),0)::float as total, COUNT(*)::int as cnt FROM "StoreOrder" WHERE "orgId"=${orgId} AND "status"='PAID' AND "createdAt" >= ${since}`.catch(() => [{ total: 0, cnt: 0 }]),
      ]),
    ]);

    // Сүүлийн N сарын товч бэлдэж, нүхийг 0-оор дүүргэнэ
    const keys = [];
    for (let i = N - 1; i >= 0; i--) { const d = new Date(); d.setMonth(d.getMonth() - i); keys.push(d.toISOString().slice(0, 7)); }
    const b = {}; keys.forEach((k) => { b[k] = { month: k, label: mnLabel(k), revenue: 0, orders: 0, leads: 0, conversations: 0 }; });
    rev.forEach((r) => { if (b[r.month]) { b[r.month].revenue += r.revenue; b[r.month].orders += r.orders; } });
    store.forEach((r) => { if (b[r.month]) { b[r.month].revenue += r.revenue; b[r.month].orders += r.orders; } });
    leads.forEach((r) => { if (b[r.month]) b[r.month].leads = r.c; });
    convs.forEach((r) => { if (b[r.month]) b[r.month].conversations = r.c; });
    const monthly = keys.map((k) => b[k]);
    const totals = monthly.reduce((t, m) => ({ revenue: t.revenue + m.revenue, orders: t.orders + m.orders, leads: t.leads + m.leads, conversations: t.conversations + m.conversations }), { revenue: 0, orders: 0, leads: 0, conversations: 0 });
    const [o, a, s] = src;
    const revenueBySource = {
      orders: o._sum.totalAmount || 0, ordersCount: o._count || 0,
      appointments: a._sum.depositAmount || 0, appointmentsCount: a._count || 0,
      store: Array.isArray(s) ? (s[0]?.total || 0) : 0, storeCount: Array.isArray(s) ? (s[0]?.cnt || 0) : 0,
    };

    // Төлбөрийн суваг + юу зарагдсан (топ бараа) — Messenger/Test AI захиалга + вэбсайт худалдааг нэгтгэнэ
    const [paidOrders, paidStoreOrders] = await Promise.all([
      prisma.turuuOrder.findMany({ where: { orgId, status: "PAID", createdAt: { gte: since } }, select: { items: true, totalAmount: true, paymentMethod: true, customerPhone: true, psid: true, createdAt: true, qpayStatus: true, qpayInvoiceId: true } }),
      prisma.$queryRaw`SELECT items, "totalAmount", "customerPhone", "createdAt" FROM "StoreOrder" WHERE "orgId"=${orgId} AND "status"='PAID' AND "createdAt" >= ${since}`.catch(() => []),
    ]);

    const CHANNEL_LABEL = { qpay: "QPay", bank: "Дансаар", cash: "Бэлнээр", website: "Вэбсайт (QPay)", unknown: "Тодорхойгүй" };
    const channelAgg = {};
    const bumpChannel = (key, amount) => {
      if (!channelAgg[key]) channelAgg[key] = { amount: 0, count: 0 };
      channelAgg[key].amount += amount || 0;
      channelAgg[key].count += 1;
    };
    for (const ord of paidOrders) bumpChannel(ord.paymentMethod || "unknown", ord.totalAmount);
    for (const ord of paidStoreOrders) bumpChannel("website", ord.totalAmount);
    const revenueByChannel = Object.entries(channelAgg)
      .map(([key, v]) => ({ key, label: CHANNEL_LABEL[key] || key, amount: v.amount, count: v.count }))
      .sort((a, b) => b.amount - a.amount);

    const productAgg = {};
    const bumpProduct = (items) => {
      if (!Array.isArray(items)) return;
      for (const it of items) {
        const name = (it?.name || "").trim();
        if (!name) continue;
        const qty = Number(it.qty) || 0;
        const revenue = (Number(it.price) || 0) * qty;
        if (!productAgg[name]) productAgg[name] = { name, qty: 0, revenue: 0 };
        productAgg[name].qty += qty;
        productAgg[name].revenue += revenue;
      }
    };
    for (const ord of paidOrders) bumpProduct(ord.items);
    for (const ord of paidStoreOrders) bumpProduct(ord.items);
    const topProducts = Object.values(productAgg).sort((a, b) => b.revenue - a.revenue).slice(0, 20);

    // Манай платформд төлж буй сууриа зардал (автоматаар) — AI агентын багц + вэбсайтын
    // хураамж + token/мессежийн нэмэлт багц. Тайлант хугацаанд ороогүй ч ХАМГИЙН СҮҮЛД
    // төлсөн багцын (жилээр төлсөн бол жилийн хямдралтай) сарын үнийг ашиглана.
    const { PLAN_PERIOD_PRICE } = require("../lib/planPricing");
    const [org, lastSubPaid, topupPaidRows, webDeductRows, templatePaidRows] = await Promise.all([
      prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } }),
      prisma.auditLog.findFirst({ where: { orgId, action: "subscription.paid" }, orderBy: { createdAt: "desc" } }),
      prisma.auditLog.findMany({ where: { orgId, action: "topup.paid", createdAt: { gte: since } } }),
      prisma.webWalletTx.findMany({ where: { orgId, type: "deduct", qpayStatus: "PAID", createdAt: { gte: since } }, select: { amount: true } }).catch(() => []),
      prisma.templatePurchase.findMany({ where: { orgId, status: "PAID", updatedAt: { gte: since } }, select: { amount: true } }).catch(() => []),
    ]);
    const aiAgentEstimated = !lastSubPaid?.meta?.perMonth;
    const aiAgentPerMonth = lastSubPaid?.meta?.perMonth || PLAN_PERIOD_PRICE[org?.plan]?.monthly || 0;
    const aiAgentCost = aiAgentPerMonth * N;
    const tokenCost = topupPaidRows.reduce((s, r) => s + (r.meta?.amount || 0), 0);
    const websiteMonthlyCost = webDeductRows.reduce((s, r) => s + Math.abs(r.amount || 0), 0);
    const websiteTemplateCost = templatePaidRows.reduce((s, r) => s + (r.amount || 0), 0);
    const websiteCost = websiteMonthlyCost + websiteTemplateCost;
    const platformCost = {
      aiAgent: { amount: aiAgentCost, estimated: aiAgentEstimated, plan: org?.plan || null },
      website: { amount: websiteCost, monthly: websiteMonthlyCost, template: websiteTemplateCost },
      tokens: { amount: tokenCost },
      total: aiAgentCost + websiteCost + tokenCost,
    };

    // ===== НЭМЭЛТ ҮЗҮҮЛЭЛТ (KPI, ангилал, харилцагч, оргил цаг, цуцлалт, AI) =====
    const sincePrev = new Date(since); sincePrev.setMonth(sincePrev.getMonth() - N);
    const [kbRows, prevAgg, cancelAgg, pendAgg, storeCancel, storePend, unansweredCount, handoffCount] = await Promise.all([
      prisma.turuuKnowledge.findMany({ where: { orgId }, select: { question: true, category: true } }).catch(() => []),
      prisma.$queryRaw`SELECT COALESCE(SUM(amount),0)::float as revenue, COUNT(*)::int as orders FROM (
          SELECT "totalAmount" as amount FROM "TuruuOrder" WHERE "orgId"=${orgId} AND "status"='PAID' AND "createdAt" >= ${sincePrev} AND "createdAt" < ${since}
          UNION ALL
          SELECT "depositAmount" FROM "TuruuAppointment" WHERE "orgId"=${orgId} AND "depositStatus"='PAID' AND "createdAt" >= ${sincePrev} AND "createdAt" < ${since}
          UNION ALL
          SELECT "totalAmount" FROM "StoreOrder" WHERE "orgId"=${orgId} AND "status"='PAID' AND "createdAt" >= ${sincePrev} AND "createdAt" < ${since}
        ) x`.catch(() => [{ revenue: 0, orders: 0 }]),
      prisma.turuuOrder.aggregate({ where: { orgId, status: { in: ["CANCELLED", "REFUNDED"] }, createdAt: { gte: since } }, _sum: { totalAmount: true }, _count: true }),
      prisma.turuuOrder.aggregate({ where: { orgId, status: { notIn: ["PAID", "CANCELLED", "REFUNDED"] }, createdAt: { gte: since } }, _sum: { totalAmount: true }, _count: true }),
      prisma.$queryRaw`SELECT COALESCE(SUM("totalAmount"),0)::float as amount, COUNT(*)::int as cnt FROM "StoreOrder" WHERE "orgId"=${orgId} AND "status" IN ('CANCELLED','REFUNDED') AND "createdAt" >= ${since}`.catch(() => [{ amount: 0, cnt: 0 }]),
      prisma.$queryRaw`SELECT COALESCE(SUM("totalAmount"),0)::float as amount, COUNT(*)::int as cnt FROM "StoreOrder" WHERE "orgId"=${orgId} AND "status" NOT IN ('PAID','CANCELLED','REFUNDED') AND "createdAt" >= ${since}`.catch(() => [{ amount: 0, cnt: 0 }]),
      prisma.turuuUnanswered.count({ where: { orgId, createdAt: { gte: since } } }).catch(() => 0),
      prisma.turuuChat.count({ where: { orgId, handoffRequested: true, handoffAt: { gte: since } } }).catch(() => 0),
    ]);

    // Ангилалаар борлуулалт — KB question→category map ашиглан захиалгын items-ийг бүлэглэнэ
    const nameToCat = {};
    for (const k of kbRows) if (k.question) nameToCat[k.question.trim().toLowerCase()] = (k.category || "").trim();
    const catAgg = {};
    const bumpCat = (items) => {
      if (!Array.isArray(items)) return;
      for (const it of items) {
        const nm = (it?.name || "").trim().toLowerCase();
        const cat = nameToCat[nm] || "Ангилалгүй";
        if (!catAgg[cat]) catAgg[cat] = { category: cat, qty: 0, revenue: 0 };
        catAgg[cat].qty += Number(it?.qty) || 0;
        catAgg[cat].revenue += (Number(it?.price) || 0) * (Number(it?.qty) || 0);
      }
    };
    for (const o of paidOrders) bumpCat(o.items);
    for (const o of paidStoreOrders) bumpCat(o.items);
    const salesByCategory = Object.values(catAgg).sort((a, b) => b.revenue - a.revenue);

    // Шинэ vs давтан худалдан авагч (утас эсвэл psid-ээр)
    const custMap = {};
    for (const o of paidOrders) { const k = (o.customerPhone || o.psid || "").trim(); if (k) custMap[k] = (custMap[k] || 0) + 1; }
    for (const o of paidStoreOrders) { const k = (o.customerPhone || "").trim(); if (k) custMap[k] = (custMap[k] || 0) + 1; }
    const totalCustomers = Object.keys(custMap).length;
    const returningCustomers = Object.values(custMap).filter((c) => c > 1).length;
    const customers = { total: totalCustomers, returning: returningCustomers, new: totalCustomers - returningCustomers };

    // Оргил цаг / гараг — Улаанбаатар цаг (UTC+8)
    const hourAgg = new Array(24).fill(0);
    const dowAgg = new Array(7).fill(0);
    const shiftMn = (dt) => new Date(new Date(dt).getTime() + 8 * 3600 * 1000);
    for (const o of [...paidOrders, ...paidStoreOrders]) {
      if (!o.createdAt) continue;
      const d = shiftMn(o.createdAt);
      hourAgg[d.getUTCHours()] += 1;
      dowAgg[d.getUTCDay()] += 1;
    }
    const peak = {
      hour: hourAgg.some((x) => x > 0) ? hourAgg.indexOf(Math.max(...hourAgg)) : null,
      dow: dowAgg.some((x) => x > 0) ? dowAgg.indexOf(Math.max(...dowAgg)) : null,
      hourAgg, dowAgg,
    };

    // KPI — дундаж захиалга, хөрвөлт, өмнөх үетэй өсөлт
    const prevRevenue = prevAgg[0]?.revenue || 0;
    const prevOrders = prevAgg[0]?.orders || 0;
    const kpis = {
      aov: totals.orders > 0 ? totals.revenue / totals.orders : 0,
      conversionRate: totals.conversations > 0 ? (totals.orders / totals.conversations) * 100 : null,
      revenueGrowth: prevRevenue > 0 ? ((totals.revenue - prevRevenue) / prevRevenue) * 100 : null,
      ordersGrowth: prevOrders > 0 ? ((totals.orders - prevOrders) / prevOrders) * 100 : null,
      prevRevenue, prevOrders,
    };

    // Цуцлагдсан / хүлээгдэж буй (орлого болоогүй) захиалга
    const cancelled = { count: (cancelAgg._count || 0) + (storeCancel[0]?.cnt || 0), amount: (cancelAgg._sum.totalAmount || 0) + (storeCancel[0]?.amount || 0) };
    const pending = { count: (pendAgg._count || 0) + (storePend[0]?.cnt || 0), amount: (pendAgg._sum.totalAmount || 0) + (storePend[0]?.amount || 0) };

    // AI гүйцэтгэл
    const ai = { conversations: totals.conversations, leads: totals.leads, unanswered: unansweredCount, handoff: handoffCount };

    // БАТАЛГААЖУУЛАЛТ — Баталгаат (QPay/вэб гүйлгээ) vs Өөрийн мэдүүлсэн (данс/бэлэн гараар).
    // Банк зөвхөн баталгаатад итгэнэ; гараар тэмдэглэсэн орлого хуурамч байж болзошгүй.
    let verifiedRevenue = 0, verifiedOrders = 0, selfReportedRevenue = 0, selfReportedOrders = 0;
    for (const o of paidOrders) {
      const isVerified = o.paymentMethod === "qpay" || o.qpayStatus === "PAID" || !!o.qpayInvoiceId;
      const amt = o.totalAmount || 0;
      if (isVerified) { verifiedRevenue += amt; verifiedOrders += 1; }
      else { selfReportedRevenue += amt; selfReportedOrders += 1; }
    }
    for (const o of paidStoreOrders) { verifiedRevenue += o.totalAmount || 0; verifiedOrders += 1; } // вэбсайт = QPay
    verifiedRevenue += revenueBySource.appointments || 0; verifiedOrders += revenueBySource.appointmentsCount || 0; // цаг захиалгын урьдчилгаа = QPay
    const integrity = {
      verifiedRevenue, verifiedOrders,
      selfReportedRevenue, selfReportedOrders,
      totalRevenue: verifiedRevenue + selfReportedRevenue,
      totalOrders: verifiedOrders + selfReportedOrders,
      demo: false, // энэ endpoint demo байвал дээр буцсан тул энд үргэлж бодит өгөгдөл
    };

    const reportPayload = { months: N, monthly, totals, revenueBySource, revenueByChannel, topProducts, platformCost, kpis, salesByCategory, customers, peak, cancelled, pending, ai, integrity };
    cache.set(cacheKey, reportPayload, 30_000);
    res.json(reportPayload);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/report/pay — тайлан татах/хэвлэхийн өмнөх ₮5,000 QPay нэхэмжлэх
const REPORT_PRICE = 5000;
router.post("/report/pay", async (req, res) => {
  try {
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    // QPay creds байхгүй (local) → mock (туршихад флоуг харуулна)
    if (!process.env.PLATFORM_QPAY_MERCHANT_ID || !process.env.PLATFORM_ACCOUNT_NUMBER) {
      await prisma.turuuSettings.upsert({
        where: { orgId_key: { orgId, key: "pending_report" } },
        create: { orgId, key: "pending_report", value: JSON.stringify({ mock: true }) },
        update: { value: JSON.stringify({ mock: true }) },
      });
      return res.json({ ok: true, mock: true, amount: REPORT_PRICE, invoiceId: "MOCK", qrText: "MOCK-QPAY", urls: [] });
    }
    const subQpay = require("../services/subscription-qpay.service");
    const apiUrl = process.env.API_URL || "https://api.mongolagent.mn";
    const result = await subQpay.createInvoice({
      orgId, plan: "report", amount: REPORT_PRICE,
      description: "Mongol Agent — Санхүүгийн тайлан (PDF)",
      callbackUrl: `${apiUrl}/webhook/report-qpay/${orgId}`,
    });
    await prisma.turuuSettings.upsert({
      where: { orgId_key: { orgId, key: "pending_report" } },
      create: { orgId, key: "pending_report", value: JSON.stringify({ invoiceId: result.invoice_id }) },
      update: { value: JSON.stringify({ invoiceId: result.invoice_id }) },
    });
    res.json({ ok: true, amount: REPORT_PRICE, invoiceId: result.invoice_id, qrText: result.qr_text, qrImage: result.qr_image, urls: result.urls });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/report/pay/check — тайлангийн төлбөр төлөгдсөн эсэх
router.post("/report/pay/check", async (req, res) => {
  try {
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    const s = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key: "pending_report" } } });
    if (!s || !s.value) return res.json({ paid: false });
    let pending; try { pending = JSON.parse(s.value); } catch { return res.json({ paid: false }); }
    const clear = () => prisma.turuuSettings.delete({ where: { orgId_key: { orgId, key: "pending_report" } } }).catch(() => {});
    // Төлбөр төлөгдсөний дараа: pending цэвэрлэж, ӨӨРЧЛӨШГҮЙ snapshot үүсгэж, баталгаажуулах код буцаана
    const finalize = async (extra = {}) => {
      await clear();
      let verification = null;
      try { verification = await createReportSnapshot(prisma, orgId, req.body?.months); }
      catch (e) { console.error("[report-snapshot]", e && e.message); }
      return res.json({ paid: true, verification, ...extra });
    };
    if (pending.mock) return finalize({ mock: true });
    const subQpay = require("../services/subscription-qpay.service");
    const result = await subQpay.checkPayment(pending.invoiceId);
    const paid = result.invoice_status === "PAID" || (result.count != null && result.count > 0) || result.payment_status === "PAID";
    if (paid) return finalize();
    res.json({ paid: false });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── ORDERS ──────────────────────────────────────────────────────────────────

// GET /client/orders
router.get("/orders", async (req, res) => {
  try {
    const { page = 1, status, search, channel } = req.query;
    const take = 20;
    const orgId = req.org.orgId;
    const prisma = getPrisma();

    // Захиалгын суваг нэгтгэл: Messenger/гараар (TuruuOrder) + вэбсайт (StoreOrder)-ийг нэг
    // жагсаалтад channel тэмдэглэгээтэй нэгтгэнэ. Аль сувгаас ирснийг ялгаж харна.
    const textWhere = search ? {
      OR: [
        { customerName: { contains: search, mode: "insensitive" } },
        { customerPhone: { contains: search } },
      ],
    } : {};
    const statusWhere = status ? { status } : {};

    const wantMsg = !channel || channel === "messenger" || channel === "app";
    const wantWeb = !channel || channel === "website";
    const where = { orgId, ...statusWhere, ...textWhere };
    const skip = (Number(page) - 1) * take;
    const fetchLimit = skip + take; // нэгтгэсэн хуудсыг хангахад хүснэгт бүрээс хэрэгтэй мөрийн тоо

    // DB-түвшний хуудаслалт: БҮГДИЙГ биш, хүснэгт бүрээс зөвхөн skip+take татна. Нийт тоог count-оор.
    const [tOrders, wOrders, tCount, wCount] = await Promise.all([
      wantMsg ? prisma.turuuOrder.findMany({ where, orderBy: { createdAt: "desc" }, take: fetchLimit }) : [],
      wantWeb ? prisma.storeOrder.findMany({ where, orderBy: { createdAt: "desc" }, take: fetchLimit }).catch(() => []) : [],
      wantMsg ? prisma.turuuOrder.count({ where }) : 0,
      wantWeb ? prisma.storeOrder.count({ where }).catch(() => 0) : 0,
    ]);

    // Хоёуланг нэг хэлбэрт оруулж channel нэмнэ (TuruuOrder-ийн хэлбэрийг canonical болгоно)
    const tagged = [
      ...tOrders.map((o) => ({ ...o, channel: o.psid ? "messenger" : "app" })),
      ...wOrders.map((o) => ({
        id: o.id, orgId: o.orgId, customerName: o.customerName, customerPhone: o.customerPhone,
        customerEmail: o.customerEmail, deliveryAddress: o.deliveryAddress, items: o.items,
        totalAmount: o.totalAmount, status: o.status, notes: o.notes, psid: null,
        qpayInvoiceId: null, qpayQrText: null, qpayUrls: null, qpayStatus: o.qpayStatus,
        createdAt: o.createdAt, updatedAt: o.updatedAt, channel: "website",
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = tCount + wCount;
    const data = tagged.slice(skip, skip + take);
    res.json({ data, total, page: Number(page), pages: Math.ceil(total / take) || 1 });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/orders
router.post("/orders", requireFeature("orders"), async (req, res) => {
  try {
    const { customerName, customerPhone, customerEmail, deliveryAddress, items, totalAmount, notes, psid, status } = req.body;
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    const order = await prisma.turuuOrder.create({
      data: { orgId, customerName, customerPhone, customerEmail, deliveryAddress, items, totalAmount, notes, psid, ...(status && { status }) },
    });

    // Гараар үүсгэсэн захиалга ч AI-ийн захиалгатай адил нөөцөө хасна — эс тэгвэл dashboard-аас
    // үүсгэсэн захиалга бодит нөөцтэй зөрж, дараагийн худалдан авагчид байхгүй барааг санал болгодог.
    if (status !== "CANCELLED" && Array.isArray(items) && items.length > 0) {
      try {
        const kbItems = await prisma.turuuKnowledge.findMany({ where: { orgId, active: true }, select: { id: true, question: true, variants: true } });
        // KB бүрд хасалтыг НЭГТГЭНЭ (ижил барааны 2 variant нэг захиалгад орвол дарж бичихээс сэргийлнэ).
        const work = new Map(); // kbId -> variants (ажлын хувь)
        for (const it of items) {
          if (!it.name || !it.qty) continue;
          const match = kbItems.find((k) => normKB(k.question).includes(normKB(it.name)) || normKB(it.name).includes(normKB(k.question)));
          if (!match || !Array.isArray(match.variants) || match.variants.length === 0) continue;
          if (!work.has(match.id)) work.set(match.id, match.variants.map((v) => ({ ...v })));
          const variants = work.get(match.id);
          for (const v of variants) {
            const colorOk = !it.color || normKB(v.color || "").includes(normKB(it.color)) || normKB(it.color).includes(normKB(v.color || ""));
            const sizeOk = !it.size || String(v.size || "").toLowerCase() === String(it.size).toLowerCase();
            if (colorOk && sizeOk) v.stock = Math.max(0, (v.stock || 0) - (it.qty || 1));
          }
        }
        for (const [kbId, variants] of work) {
          await prisma.turuuKnowledge.update({ where: { id: kbId }, data: { variants } });
        }
      } catch (e) { console.error("[manual order auto-stock]", e.message); }
    }

    cache.invalidateOrg(orgId); // шинэ захиалга → dashboard/тайлан шууд шинэчлэгдэнэ
    res.json(order);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// PUT /client/orders/:id
router.put("/orders/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const order = await prisma.turuuOrder.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!order) return res.status(404).json({ error: "Not found" });
    const { status, notes, deliveryAddress } = req.body;
    const updated = await prisma.turuuOrder.update({
      where: { id: req.params.id },
      data: { ...(status && { status }), ...(notes !== undefined && { notes }), ...(deliveryAddress && { deliveryAddress }) },
    });
    cache.invalidateOrg(req.org.orgId); // төлөв өөрчлөгдвөл тайлан шинэчлэгдэнэ
    res.json(updated);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/orders/:id/confirm-payment — Эзэн төлбөр баталгаажуулах + хэрэглэгчид Messenger мэдэгдэл
router.post("/orders/:id/confirm-payment", async (req, res) => {
  try {
    const prisma = getPrisma();
    const order = await prisma.turuuOrder.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!order) return res.status(404).json({ error: "Not found" });
    // Эзэн гараар баталгаажуулахдаа "дансаар" эсвэл "бэлнээр" сонгоно (QPay биш үед)
    const { paymentMethod } = req.body;
    const updateData = { status: "PAID", paymentMethod: ["bank", "cash"].includes(paymentMethod) ? paymentMethod : "bank" };
    // QPay invoice байвал цуцлах — давхар төлбөр хийгдэхээс сэргийлнэ
    if (order.qpayInvoiceId && order.qpayStatus !== "PAID") {
      updateData.qpayStatus = "CANCELLED";
      try {
        const qpay = require("../services/qpay.service");
        await qpay.cancelInvoice(order.qpayInvoiceId);
      } catch { /* QPay цуцлалт амжилтгүй бол DB-д CANCELLED тэмдэглэнэ, webhook-д шалгагдана */ }
    }
    await prisma.turuuOrder.update({ where: { id: order.id }, data: updateData });
    cache.invalidateOrg(req.org.orgId); // төлбөр баталгаажвал орлого шууд шинэчлэгдэнэ
    // Messenger-ээр хэрэглэгчид мэдэгдэл
    if (order.psid) {
      try {
        const org = await prisma.organization.findUnique({ where: { id: req.org.orgId }, select: { fbPageToken: true } });
        const token = decrypt(org?.fbPageToken) || process.env.FB_PAGE_ACCESS_TOKEN;
        if (token) {
          const orderCode = order.id.slice(-6).toUpperCase();
          await sendText(order.psid, `✅ Таны төлбөр баталгаажлаа! Захиалга #${orderCode} батлагдлаа. Удахгүй хүргэлт хийгдэнэ 🙏`, token).catch(() => {});
        }
      } catch { /* non-blocking */ }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// DELETE /client/orders/:id
// DELETE /orders/:id — hard delete БИШ, зөвхөн CANCELLED болгоно (audit trail хадгалагдана;
// жишээ нь давхар дарагдсан захиалгыг цуцлахад ашиглана). Мөр DB-д үлдэж, тайланд орохгүй.
router.delete("/orders/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const order = await prisma.turuuOrder.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!order) return res.status(404).json({ error: "Not found" });
    await prisma.turuuOrder.update({ where: { id: req.params.id }, data: { status: "CANCELLED" } });
    await logAudit(prisma, req, "order.cancel", order.id, { previousStatus: order.status, totalAmount: order.totalAmount });
    cache.invalidateOrg(req.org.orgId); // цуцлагдсан захиалга тайланд тусгагдана
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── PASSWORD CHANGE ─────────────────────────────────────────────────────────

// PUT /client/profile/password
router.put("/profile/password", requireOwner, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "currentPassword, newPassword шаардлагатай" });
    if (newPassword.length < 6) return res.status(400).json({ error: "Нууц үг хамгийн багадаа 6 тэмдэгт байна" });
    const bcrypt = require("bcryptjs");
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId } });
    const valid = await bcrypt.compare(currentPassword, org.passwordHash);
    if (!valid) return res.status(400).json({ error: "Одоогийн нууц үг буруу байна" });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.organization.update({ where: { id: req.org.orgId }, data: { passwordHash } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// DELETE /client/account — бүртгэл болон холбогдох БҮХ мэдээллийг бүрмөсөн устгана.
// Нууцлалын бодлогод "устгуулах эрхтэй" гэж бичсэн тул энэ нь ажиллаж байх ЁСТОЙ.
// Хамгаалалт: зөвхөн эзэн, нууц үг + и-мэйлээ бичиж баталгаажуулна (санамсаргүй
// дарж устгахаас сэргийлнэ). Үйлдэл ЭРГЭШГҮЙ.
router.delete("/account", requireOwner, async (req, res) => {
  try {
    const { password, confirmEmail } = req.body || {};
    if (!password || !confirmEmail) {
      return res.status(400).json({ error: "password болон confirmEmail шаардлагатай" });
    }
    const bcrypt = require("bcryptjs");
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId } });
    if (!org) return res.status(404).json({ error: "Байгууллага олдсонгүй" });

    const valid = await bcrypt.compare(password, org.passwordHash);
    if (!valid) return res.status(400).json({ error: "Нууц үг буруу байна" });
    if (String(confirmEmail).trim().toLowerCase() !== String(org.email).toLowerCase()) {
      return res.status(400).json({ error: "И-мэйл таарахгүй байна" });
    }

    const { eraseOrganization } = require("../services/privacy.service");
    const removed = await eraseOrganization(prisma, req.org.orgId);
    console.log(`[privacy] Org ${req.org.orgId} бүрмөсөн устгав`, removed);
    res.json({ ok: true, removed });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── BILLING ─────────────────────────────────────────────────────────────────

// GET /client/billing
router.get("/billing", async (req, res) => {
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: req.org.orgId },
      select: { plan: true, messageUsed: true, quotaResetAt: true, createdAt: true, subscriptionEndsAt: true },
    });
    const quota = PLAN_QUOTA[org.plan] || 10000;
    const PLANS = {
      starter:    { name: "Starter",    price: 59900,  quota: 2300,  features: ["2,300 мессеж/сар", "Facebook Messenger AI", "Builder AI", "Мэдлэгийн сан (100)", "Lead цуглуулах", "И-мэйл мэдэгдэл"] },
      growth:     { name: "Growth",     price: 99900,  quota: 3800,  features: ["3,800 мессеж/сар", "Мэдлэгийн сан (500)", "Захиалга + QPay төлбөр", "Цаг захиалга + урьдчилгаа", "Instagram DM", "Хүн handoff", "Автомат comment", "PDF/Excel → Мэдлэгийн сан", "Funnel analytics"] },
      business:   { name: "Business",   price: 179900, quota: 6900,  features: ["6,900 мессеж/сар", "Custom keyword → DM", "AI тохиргоо (model/tone)", "Мэдлэгийн сан (2,000)", "Priority дэмжлэг", "Дэвшилтэт analytics"] },
      enterprise: { name: "Enterprise", price: 349900, quota: 13500, features: ["13,500 мессеж/сар", "Custom AI Chatbot", "Custom AI Agent", "Custom Website", "White label", "Олон хуудас + API"] },
    };
    // Хугацаа бүрийн үнэ (сар/6сар/жил) нэмнэ — frontend toggle-д ашиглана
    const { PLAN_PERIOD_PRICE, MESSAGE_TOPUP } = require("../lib/planPricing");
    for (const k of Object.keys(PLANS)) PLANS[k].periods = PLAN_PERIOD_PRICE[k];
    // Нэмэлт message багц + үлдсэн credit — limit тулбал "Нэмэлт message авах"-д ашиглана
    const { getTopupRemaining } = require("../lib/quota");
    const topup = await getTopupRemaining(req.org.orgId);
    const used = org.messageUsed || 0;
    const effectiveQuota = quota + topup;
    const topupPacks = Object.keys(MESSAGE_TOPUP).map((u) => ({ units: parseInt(u, 10), price: MESSAGE_TOPUP[u] }));
    res.json({
      ...org, quota, messageUsed: used, plans: PLANS, currentPlan: PLANS[org.plan],
      topup, effectiveQuota, remaining: Math.max(0, effectiveQuota - used), exhausted: used >= effectiveQuota,
      topupPacks,
    });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/billing/upgrade
router.post("/billing/upgrade", requireOwner, async (req, res) => {
  try {
    const { targetPlan } = req.body;
    const UPGRADE_ORDER = ["starter", "growth", "business", "enterprise"];
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId }, select: { plan: true, email: true, name: true } });
    if (UPGRADE_ORDER.indexOf(targetPlan) <= UPGRADE_ORDER.indexOf(org.plan)) {
      return res.status(400).json({ error: "Зөвхөн дээш ахиулах боломжтой" });
    }
    res.json({ ok: true, message: "Upgrade хүсэлт хүлээн авлаа. Манай баг тантай холбогдоно." });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/billing/pay — QPay subscription invoice үүсгэх
router.post("/billing/pay", requireOwner, async (req, res) => {
  try {
    const { plan, period = "monthly" } = req.body;
    if (!plan) return res.status(400).json({ error: "plan шаардлагатай" });

    const { PERIOD_MONTHS, PERIOD_LABEL, periodTotal } = require("../lib/planPricing");
    const PLAN_NAME  = { starter: "Starter", growth: "Growth", business: "Business", enterprise: "Enterprise" };
    const months = PERIOD_MONTHS[period];
    const amount = periodTotal(plan, period);
    if (!amount || !months) return res.status(400).json({ error: "Буруу план эсвэл хугацаа" });

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: req.org.orgId },
      select: { id: true, name: true, subInvoiceId: true, subQpayStatus: true },
    });

    // Хэрэв хүлээгдэж буй invoice байвал дахин ашиглана
    if (org.subInvoiceId && org.subQpayStatus !== "PAID") {
      return res.json({ ok: true, alreadyCreated: true, invoiceId: org.subInvoiceId });
    }

    const subQpay = require("../services/subscription-qpay.service");
    const result = await subQpay.createInvoice({
      orgId: org.id,
      plan,
      amount,
      description: `Mongol Agent — ${PLAN_NAME[plan]} план (${PERIOD_LABEL[period]})`,
    });

    await prisma.organization.update({
      where: { id: org.id },
      data: { subInvoiceId: result.invoice_id, subQpayStatus: "PENDING" },
    });

    // Хүлээгдэж буй план + хугацаа (сар)-ыг хадгална — төлбөр батлагдахад applySubscriptionPayment ашиглана
    await prisma.turuuSettings.upsert({
      where: { orgId_key: { orgId: org.id, key: "pending_subscription" } },
      create: { orgId: org.id, key: "pending_subscription", value: JSON.stringify({ plan, months }) },
      update: { value: JSON.stringify({ plan, months }) },
    });

    res.json({ ok: true, invoiceId: result.invoice_id, qrText: result.qr_text, qrImage: result.qr_image, urls: result.urls });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/billing/pay/check — Subscription төлбөр шалгах
router.post("/billing/pay/check", requireOwner, async (req, res) => {
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: req.org.orgId },
      select: { id: true, subInvoiceId: true, subQpayStatus: true, subscriptionEndsAt: true },
    });
    // webhook аль хэдийн боловсруулсан (subInvoiceId-г null болгож, PAID болгосон) бол
    // амжилттай гэж шууд буцаана — "Invoice байхгүй" гэж буруу алдаа гаргахгүй.
    if (org.subQpayStatus === "PAID") return res.json({ paid: true, alreadyPaid: true });
    if (!org.subInvoiceId) return res.status(400).json({ error: "Invoice байхгүй" });

    const subQpay = require("../services/subscription-qpay.service");
    const result = await subQpay.checkPayment(org.subInvoiceId);
    const paid = result.invoice_status === "PAID" || (result.count != null && result.count > 0) || result.payment_status === "PAID";

    if (paid) {
      // webhook-тэй ИЖИЛ shared helper-ээр эрхийг 30 хоног сунгана.
      // (өмнө энд зөвхөн subQpayStatus="PAID" тавьдаг байсан тул эрх сунгагдахгүй,
      //  улмаар дараагийн webhook count=0 болж сунгалт үүрд алдагддаг байсан.)
      await applySubscriptionPayment(prisma, org);
    }

    res.json({ paid, result });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/billing/topup — Нэмэлт message багц (top-up) QPay invoice үүсгэх
router.post("/billing/topup", requireOwner, async (req, res) => {
  try {
    const { size } = req.body;
    const { topupPack } = require("../lib/planPricing");
    const pack = topupPack(size);
    if (!pack) return res.status(400).json({ error: "Буруу багц" });

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId }, select: { id: true } });
    const subQpay = require("../services/subscription-qpay.service");
    const apiUrl = process.env.API_URL || "https://api.mongolagent.mn";
    const result = await subQpay.createInvoice({
      orgId: org.id,
      plan: "topup",
      amount: pack.price,
      description: `Mongol Agent — Нэмэлт ${pack.units.toLocaleString()} мессеж`,
      callbackUrl: `${apiUrl}/webhook/topup-qpay/${org.id}`, // subscription callback-аас ТУСДАА
    });

    // Хүлээгдэж буй топ-ап (invoiceId + units + amount)-ыг хадгална — төлбөр батлагдахад applyTopupPayment ашиглана
    await prisma.turuuSettings.upsert({
      where: { orgId_key: { orgId: org.id, key: "pending_topup" } },
      create: { orgId: org.id, key: "pending_topup", value: JSON.stringify({ invoiceId: result.invoice_id, units: pack.units, amount: pack.price }) },
      update: { value: JSON.stringify({ invoiceId: result.invoice_id, units: pack.units, amount: pack.price }) },
    });

    res.json({ ok: true, invoiceId: result.invoice_id, qrText: result.qr_text, qrImage: result.qr_image, urls: result.urls, units: pack.units, amount: pack.price });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/billing/topup/check — Нэмэлт message төлбөр шалгах
router.post("/billing/topup/check", requireOwner, async (req, res) => {
  try {
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    const s = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key: "pending_topup" } } });
    // pending байхгүй → webhook аль хэдийн боловсруулж credit нэмсэн байх магадлалтай
    if (!s || !s.value) return res.json({ paid: true, alreadyApplied: true });
    let pending;
    try { pending = JSON.parse(s.value); } catch { return res.status(400).json({ error: "Буруу төлөв" }); }
    if (!pending.invoiceId) return res.status(400).json({ error: "Invoice байхгүй" });

    const subQpay = require("../services/subscription-qpay.service");
    const result = await subQpay.checkPayment(pending.invoiceId);
    const paid = result.invoice_status === "PAID" || (result.count != null && result.count > 0) || result.payment_status === "PAID";

    if (paid) {
      const { applied, added, remaining } = await applyTopupPayment(prisma, orgId);
      return res.json({ paid: true, applied, added, remaining });
    }
    res.json({ paid: false });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/assistant — Dashboard дотор ажиллах ЗААВАР AI (борлуулалтын чатаас ТУСДАА).
// Merchant-т програмаа хэрхэн ашиглахыг заана. Мессежийн эрхээс ХАСАХГҮЙ (blockIfExpired-гүй) —
// эрх дууссан ч хэрэглэгч заавар авах, төлбөрөө хэрхэн цэнэглэхийг мэдэх ёстой.
// Спамаас сэргийлж энгийн rate-limit (org-д минутанд 15 асуулт).
const _assistantHits = new Map(); // orgId -> { count, resetAt }
// GET /client/assistant/usage — чат нээхэд үлдсэн эрхийг харуулна (app + website нийлмэл)
router.get("/assistant/usage", async (req, res) => {
  try {
    const { getAssistantUsage } = require("../lib/quota");
    res.json(await getAssistantUsage(req.org.orgId));
  } catch { res.json({ used: 0, remaining: 50, limit: 50 }); }
});

router.post("/assistant", async (req, res) => {
  try {
    const { message, history = [], route, surface, imageUrl } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message шаардлагатай" });
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "AI туслах идэвхгүй байна" });
    // Зураг зөвхөн http(s) эсвэл base64 data URL байх ёстой (буруу оролтоос сэргийлнэ)
    const hasImage = typeof imageUrl === "string" && /^(https?:|data:image\/)/.test(imageUrl);

    const orgId = req.org.orgId;
    const { getAssistantUsage, bumpAssistantUsage } = require("../lib/quota");

    // Сарын хязгаар: app + website ХОЁУЛАА энэ endpoint дуудна → нэг org сард 50 нийт.
    // OpenAI дуудахаас ӨМНӨ шалгана (хязгаар хүрсэн бол дэмий дуудахгүй).
    const usage = await getAssistantUsage(orgId);
    if (usage.remaining <= 0) {
      return res.status(429).json({ error: "Энэ сарын заавар авах эрх (50) дууслаа. Дараа сард шинэчлэгдэнэ.", remaining: 0, limit: usage.limit });
    }

    // Спамаас сэргийлэх минутын rate-limit (org-д минутанд 15 асуулт)
    const now = Date.now();
    const hit = _assistantHits.get(orgId);
    if (!hit || now > hit.resetAt) {
      _assistantHits.set(orgId, { count: 1, resetAt: now + 60_000 });
    } else {
      hit.count += 1;
      if (hit.count > 15) return res.status(429).json({ error: "Түр хүлээгээд дахин оролдоно уу", remaining: usage.remaining, limit: usage.limit });
    }

    const { buildAssistantPrompt } = require("../lib/helpDocs");
    const OpenAI = require("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Зураг хавсаргасан бол vision content (gpt-4o-mini зураг харна) — хэрэглэгч section-ий
    // screenshot дараад "энэ icon-ийг яаж солих вэ" гэх мэт асууж болно.
    const userContent = hasImage
      ? [{ type: "text", text: message.trim() }, { type: "image_url", image_url: { url: imageUrl } }]
      : message.trim();

    const messages = [
      { role: "system", content: buildAssistantPrompt(route, surface) },
      ...(Array.isArray(history) ? history.slice(-8) : []),
      { role: "user", content: userContent },
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",     // заавар туслах — зардал багатай; лийн prompt + текст мэдлэг
      messages,
      temperature: 0.3,
      max_tokens: 600,
    });

    const reply = response.choices?.[0]?.message?.content?.trim()
      || "Уучлаарай, дахин асууж үзээрэй.";
    // Амжилттай хариултын ДАРАА л эрх зарцуулна (алдаа гарвал эрх хорогдохгүй)
    const after = await bumpAssistantUsage(orgId);
    res.json({ reply, remaining: after.remaining, limit: after.limit });
  } catch (e) {
    console.error("[assistant]", e && e.message);
    res.status(500).json({ error: "Серверийн алдаа гарлаа" });
  }
});

// POST /client/chat
router.post("/chat", blockIfExpired, async (req, res) => {
  try {
    const { message, history = [], imageUrl } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message шаардлагатай" });

    const orgId = req.org.orgId;
    const { buildSystemPrompt } = require("../lib/prompt");
    const OpenAI = require("openai");

    const prisma = getPrisma();
    let aiSettings = { model: "gpt-4o-mini", temperature: 0.4, max_tokens: 1024 };
    try {
      const rows = await prisma.turuuSettings.findMany({
        where: { orgId, key: { in: ["ai_model", "ai_temperature", "ai_max_tokens"] } },
      });
      const s = {};
      rows.forEach((r) => { s[r.key] = r.value; });
      if (s.ai_model) aiSettings.model = s.ai_model;
      if (s.ai_temperature) aiSettings.temperature = parseFloat(s.ai_temperature);
      if (s.ai_max_tokens) aiSettings.max_tokens = parseInt(s.ai_max_tokens);
    } catch {}

    const systemPrompt = await buildSystemPrompt(false, orgId, !!imageUrl);
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Тест чат ЖИНХЭНЭ Messenger AI-тай ЯГ ИЖИЛ гол tool-уудтай байх ёстой — эс тэгвэл AI
    // "захиалга амжилттай!" гэж ХУДАЛ хэлж болзошгүй (tool байхгүй тул зөвхөн текстээр "зохиодог").
    let testBusinessType = "other";
    try {
      const btSetting = await prisma.turuuSettings.findFirst({ where: { orgId, key: "business_type" } });
      if (btSetting?.value) testBusinessType = btSetting.value;
    } catch { /* non-blocking */ }
    const supportsOrder = ["shop", "restaurant"].includes(testBusinessType);

    // Tool ТОДОРХОЙЛОЛТ нь Messenger-тэй нэг эх сурвалжаас (lib/aiTools) — 2 газар давхар
    // бичихээ больсон. Тест-чат нь ЗӨВХӨН доор handler-тэй tool-уудаа сонгож авна;
    // save_order-г зөвхөн shop/restaurant төрөлд нээнэ (Messenger-ийн parity).
    const { pickTools } = require("../lib/aiTools");
    const chatToolNames = ["search_knowledge", "check_menu", "flag_unanswered", "save_lead", "save_consultation", "request_handoff"];
    if (supportsOrder) chatToolNames.push("save_order");
    const CHAT_TOOLS = pickTools(chatToolNames);

    const userContent = imageUrl
      ? [{ type: "image_url", image_url: { url: imageUrl } }, { type: "text", text: message.trim() }]
      : message.trim();

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-20),
      { role: "user", content: userContent },
    ];

    const response = await openai.chat.completions.create({
      model: aiSettings.model,
      messages,
      tools: CHAT_TOOLS,
      tool_choice: "auto",
      temperature: aiSettings.temperature,
      max_tokens: aiSettings.max_tokens,
    });

    const choice = response.choices[0];
    let reply = "";
    let replyImageUrl = null;

    const { isGeneralInfoQuery, KB_NOT_FOUND_TEXTS } = require("../services/ai.service");
    let flagUnansweredCalled = false;
    const notFoundGeneralQueries = [];

    if (choice.finish_reason === "tool_calls") {
      const toolResults = [];
      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.function.name === "search_knowledge") {
          const { query } = JSON.parse(toolCall.function.arguments);
          const items = await prisma.turuuKnowledge.findMany({
            where: { orgId, active: true },
            select: { question: true, answer: true, category: true, variants: true, imageUrl: true, attributes: true },
          });
          let result = "Мэдлэгийн санд тохирох мэдээлэл олдсонгүй.";
          if (items.length > 0) {
            const qWords = normKB(query).split(" ").filter((w) => w.length > 1);
            const scored = items
              .map((item) => ({
                item,
                score: qWords.filter((w) => normKB(`${item.question} ${item.answer} ${item.category || ""}`).includes(w)).length,
              }))
              .filter((s) => s.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5);
            if (scored.length > 0) {
              const qNorm = normKB(query);
              result = scored.map((s, idx) => {
                let text = `А: ${s.item.question}\nХ: ${s.item.answer}`;
                const attrs = s.item.attributes && typeof s.item.attributes === "object" ? s.item.attributes : null;
                if (attrs) {
                  const attrStr = Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join(", ");
                  if (attrStr) text += `\nҮзүүлэлт: ${attrStr}`;
                }
                const vars = Array.isArray(s.item.variants) ? s.item.variants : [];
                const inStock = vars.filter((v) => v.stock == null || v.stock > 0);
                const colors = [...new Set(inStock.filter((v) => v.color).map((v) => v.color))];
                if (colors.length > 0) text += `\nБайгаа өнгөнүүд: ${colors.join(", ")}`;
                const sizes = [...new Set(inStock.filter((v) => v.size).map((v) => v.size))];
                if (sizes.length > 0) text += `\nБайгаа размерүүд: ${sizes.join(", ")}`;
                const colorsWithImages = [...new Set(vars.filter((v) => v.color && v.imageUrl).map((v) => v.color))];
                if (colorsWithImages.length > 0) text += `\nЗурагтай өнгөнүүд: ${colorsWithImages.join(", ")}`;
                // Хайлтын query-д дурдсан өнгөтэй variant-ын зургийг тэргүүлж сонгоно, тохирохгүй бол top result-ийн ерөнхий imageUrl
                if (idx === 0 && !replyImageUrl) {
                  const matchedVariant = vars.find((v) => v.color && v.imageUrl && qNorm.includes(normKB(v.color)));
                  replyImageUrl = matchedVariant?.imageUrl || s.item.imageUrl || null;
                }
                return text;
              }).join("\n\n");
            }
          }
          if (KB_NOT_FOUND_TEXTS.has(result) && isGeneralInfoQuery(query)) notFoundGeneralQueries.push(query);
          toolResults.push({ tool_call_id: toolCall.id, content: result });
        } else if (toolCall.function.name === "check_menu") {
          const { category } = JSON.parse(toolCall.function.arguments || "{}");
          const kbItems = await prisma.turuuKnowledge.findMany({
            where: { orgId, active: true, category: { startsWith: "Бүтээгдэхүүн" } },
            select: { question: true, answer: true, category: true },
            orderBy: { category: "asc" },
          });
          if (kbItems.length === 0) {
            toolResults.push({ tool_call_id: toolCall.id, content: "Одоогоор бүртгэлтэй бараа алга." });
          } else {
            const byCat = {};
            for (const item of kbItems) {
              const cat = (item.category || "").replace("Бүтээгдэхүүн / ", "").replace("Бүтээгдэхүүн", "Бусад") || "Бусад";
              if (!byCat[cat]) byCat[cat] = [];
              const price = (item.answer.match(/Үнэ:\s*([\d,]+)/) || [])[1];
              const priceNum = price ? parseInt(price.replace(/,/g, ""), 10) : Infinity;
              byCat[cat].push({ text: `${item.question}${price ? ` — ${price}₮` : ""}`, price: priceNum });
            }
            const allCategories = Object.keys(byCat);
            // Ангилал шүүлт — Messenger-тэй ижил: хэрэглэгч тодорхой ангилал асуувал зөвхөн тэрийг
            // буцаана (token хэмнэнэ). Монгол үндсээр тулгана ("пүүз"→"гутал" гэх мэт синоним).
            let categories = allCategories;
            if (category && category.trim()) {
              const { normalizeMongol, wordMatch } = require("../lib/mongolStem");
              const want = normalizeMongol(category);
              const matched = allCategories.filter((c) => {
                const cw = normalizeMongol(c);
                return want.some((q) => cw.some((k) => wordMatch(q, k)));
              });
              if (matched.length > 0) categories = matched; // тааралгүй бол бүгдийг үлдээнэ (fallback)
            }
            // Ангилал доторх барааг үнээр өсөхөөр эрэмбэлнэ — "хамгийн хямд/үнэтэй" асуултад найдвартай
            const menu = categories.map((cat) => `【${cat}】\n${byCat[cat].sort((a, b) => a.price - b.price).map((x) => x.text).join("\n")}`).join("\n\n");
            const header = categories.length < allCategories.length
              ? `${categories.join(", ")} ангилал (бусад: ${allCategories.filter((c) => !categories.includes(c)).join(", ")}):`
              : `Ангилалууд: ${allCategories.join(", ")}`;
            toolResults.push({ tool_call_id: toolCall.id, content: `${header}\n\n${menu}` });
          }
        } else if (toolCall.function.name === "flag_unanswered") {
          flagUnansweredCalled = true;
          const args = JSON.parse(toolCall.function.arguments || "{}");
          try {
            await prisma.turuuUnanswered.create({ data: { orgId: orgId || "default", question: args.question, psid: "test-chat" } });
          } catch { /* non-blocking */ }
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ flagged: true }) });
        } else if (toolCall.function.name === "request_handoff") {
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ handoff: true }) });
        } else if (toolCall.function.name === "save_lead") {
          const args = JSON.parse(toolCall.function.arguments || "{}");
          try {
            await saveLead({ psid: null, orgId, ...args });
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: true }) });
          } catch (e) {
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: false, error: e.message }) });
          }
        } else if (toolCall.function.name === "save_consultation") {
          const args = JSON.parse(toolCall.function.arguments || "{}");
          try {
            await saveConsultation({ psid: null, orgId, ...args });
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: true }) });
          } catch (e) {
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: false, error: e.message }) });
          }
        } else if (toolCall.function.name === "save_order") {
          const args = JSON.parse(toolCall.function.arguments || "{}");
          // ХАМГААЛАЛТ: хүргэлттэй захиалгыг ХАЯГГҮЙГЭЭР үүсгэхгүй — эхлээд хаягийг ав
          // (Messenger урсгалтай ижил — нэр+утас дээр эрт үүсгэхээс сэргийлнэ).
          if (!args.payOnPickup && !(args.deliveryAddress || "").trim()) {
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({
              success: false, needAddress: true,
              message: "Захиалга хараахан үүсгэсэнгүй. Хүргэлттэй захиалгад дэлгэрэнгүй ХАЯГ (дүүрэг, хороо, байр/тоот) шаардлагатай. Хэрэглэгчээс хаягийг асууж аваад, баталгаажуулсны дараа save_order-г ДАХИН дуудна уу.",
            }) });
            continue;
          }
          try {
            const notes = args.notes ? `${args.notes} | [Тест чат]` : "[Тест чат]";
            // Тогтмол psid — нэг яриан дотор save_order давхар дуудагдвал (жишээ нь
            // "баталгаажуулъя" гэсний дараа AI дахин дуудвал) lead.service-ийн idempotency
            // шалгалт ажиллаж, давхардсан бодит захиалга үүсэхээс сэргийлнэ.
            const order = await saveOrder({ psid: `test-chat-${orgId}`, orgId, ...args, notes });
            if (order?.id) cache.invalidateOrg(orgId); // тест чат захиалга → тайлан шинэчлэгдэнэ
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: true, orderId: order.id }) });
          } catch (e) {
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: false, error: e.message }) });
          }
        }
      }
      const followUp = await openai.chat.completions.create({
        model: aiSettings.model,
        messages: [
          ...messages,
          choice.message,
          ...toolResults.map((r) => ({ role: "tool", tool_call_id: r.tool_call_id, content: r.content })),
        ],
        temperature: aiSettings.temperature,
        max_tokens: 512,
      });
      reply = followUp.choices[0].message.content?.trim() || "";
    } else {
      reply = choice.message.content?.trim() || "";
    }

    if (!flagUnansweredCalled && notFoundGeneralQueries.length > 0) {
      try {
        await prisma.turuuUnanswered.create({ data: { orgId: orgId || "default", question: notFoundGeneralQueries[0], psid: "test-chat" } });
      } catch { /* non-blocking */ }
    }

    // Тест чат: сард эхний 100 мессеж ҮНЭГҮЙ, дараа нь 1 мессеж = 1 эрх
    try {
      const { bumpTestChatUsage, incrementMessageUsedBy } = require("../lib/quota");
      const t = await bumpTestChatUsage(orgId);
      if (!t.free) await incrementMessageUsedBy(orgId, 1);
    } catch { /* non-blocking */ }

    res.json({ reply, ...(replyImageUrl ? { imageUrl: replyImageUrl } : {}) });
  } catch (e) {
    res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") });
  }
});

// PUT /client/profile/name
router.put("/profile/name", requireOwner, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "name шаардлагатай" });
    const prisma = getPrisma();
    await prisma.organization.update({ where: { id: req.org.orgId }, data: { name: name.trim() } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/profile/email/request — шинэ email рүү код илгээх
router.post("/profile/email/request", requireOwner, async (req, res) => {
  try {
    const { newEmail } = req.body;
    if (!newEmail?.trim()) return res.status(400).json({ error: "Шинэ имэйл шаардлагатай" });
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) return res.status(400).json({ error: "Имэйл формат буруу байна" });

    const prisma = getPrisma();
    const existing = await prisma.organization.findUnique({ where: { email: newEmail.toLowerCase() } });
    if (existing) return res.status(400).json({ error: "Энэ имэйл аль хэдийн бүртгэлтэй байна" });

    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId }, select: { email: true, name: true } });

    // Хуучин code-уудыг устгана
    await prisma.emailChangeToken.deleteMany({ where: { orgId: req.org.orgId } });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.emailChangeToken.create({ data: { orgId: req.org.orgId, newEmail: newEmail.toLowerCase(), code, expiresAt } });

    await resend.emails.send({
      from: FROM_EMAIL,
      to: org.email,
      subject: "Mongol Agent — Имэйл солих баталгаажуулалт",
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#07070e;color:#f1f5f9;border-radius:12px">
        <div style="margin-bottom:24px"><span style="font-size:20px;font-weight:800;color:#818cf8">Mongol</span><span style="font-size:20px;font-weight:800;color:#94a3b8">Agent</span></div>
        <h2 style="font-size:18px;font-weight:700;margin-bottom:12px">Имэйл солих баталгаажуулалт</h2>
        <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin-bottom:24px">Шинэ имэйл хаяг: <strong style="color:#f1f5f9">${newEmail}</strong></p>
        <div style="background:#1e1b4b;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#818cf8">${code}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:8px">10 минутын дотор ашиглана уу</div>
        </div>
        <p style="color:#64748b;font-size:12px">Хэрэв та энэ хүсэлт илгээгээгүй бол энэ имэйлийг үл тоомсорлоно уу.</p>
      </div>`,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/profile/email/verify — код баталгаажуулж имэйл солих
router.post("/profile/email/verify", requireOwner, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Код шаардлагатай" });

    const prisma = getPrisma();
    const token = await prisma.emailChangeToken.findFirst({
      where: { orgId: req.org.orgId, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });

    if (!token) return res.status(400).json({ error: "Код хүчингүй эсвэл хугацаа дууссан байна" });
    if (token.code !== code.toString()) return res.status(400).json({ error: "Код буруу байна" });

    // Email шинэчлэх
    await prisma.organization.update({ where: { id: req.org.orgId }, data: { email: token.newEmail } });
    await prisma.emailChangeToken.update({ where: { id: token.id }, data: { used: true } });

    res.json({ ok: true, newEmail: token.newEmail });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/profile
router.get("/profile", async (req, res) => {
  try {
    const prisma = getPrisma();
    const [org, btSetting] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: req.org.orgId },
        select: { id: true, name: true, slug: true, email: true, plan: true, status: true, logoUrl: true, fbPageId: true, fbPageToken: true, createdAt: true },
      }),
      prisma.turuuSettings.findUnique({
        where: { orgId_key: { orgId: req.org.orgId, key: "business_type" } },
      }),
    ]);
    res.json({ ...org, businessType: btSetting?.value || null });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/setup-status — AI бүрэн ажиллахад шаардлагатай алхмуудын төлөв (checklist)
router.get("/setup-status", async (req, res) => {
  try {
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    const [org, aiSettings, btSetting, productsCount, knowledgeCount, staffCount] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: orgId },
        select: { fbPageId: true, qpayMerchantId: true, qpayAccountNumber: true },
      }),
      prisma.turuuSettings.findMany({
        where: { orgId, key: { in: ["ai_profile", "system_prompt", "ai_company"] } },
        select: { value: true },
      }),
      prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key: "business_type" } }, select: { value: true } }),
      // Бараа/меню = "Бүтээгдэхүүн" ангиллын KB зүйл (check_menu-тэй ижил шалгуур)
      prisma.turuuKnowledge.count({ where: { orgId, active: true, category: { startsWith: "Бүтээгдэхүүн" } } }),
      // Нийт KB (business_type=other-д ашиглана)
      prisma.turuuKnowledge.count({ where: { orgId, active: true } }),
      // Бүртгэлтэй эмч/мастер/ажилтан (цаг захиалгатай бизнест ашиглана)
      prisma.turuuStaff.count({ where: { orgId, isActive: true } }),
    ]);
    const aiConfigured = aiSettings.some((s) => s.value && s.value.trim().length > 0);
    res.json({
      businessType: btSetting?.value || null,
      aiConfigured,
      facebookConnected: !!org?.fbPageId,
      qpayConnected: !!(org?.qpayMerchantId && org?.qpayAccountNumber),
      productsCount,
      knowledgeCount,
      staffCount,
    });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// PUT /client/profile/facebook
router.put("/profile/facebook", requireOwner, async (req, res) => {
  try {
    const { fbPageId, fbPageToken } = req.body;
    if (!fbPageId || !fbPageToken) return res.status(400).json({ error: "fbPageId, fbPageToken шаардлагатай" });
    const prisma = getPrisma();
    await prisma.organization.update({
      where: { id: req.org.orgId },
      data: { fbPageId, fbPageToken },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── UNANSWERED QUESTIONS ─────────────────────────────────────────────────────

// GET /client/unanswered
router.get("/unanswered", async (req, res) => {
  try {
    const prisma = getPrisma();
    const { resolved } = req.query;
    const where = { orgId: req.org.orgId };
    if (resolved === "true") where.resolved = true;
    else where.resolved = false;
    const items = await prisma.turuuUnanswered.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 });
    res.json(items);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/unanswered/:id/resolve — KB-д нэм + resolved болго
router.post("/unanswered/:id/resolve", async (req, res) => {
  try {
    const { answer, category } = req.body;
    if (!answer?.trim()) return res.status(400).json({ error: "answer шаардлагатай" });
    const prisma = getPrisma();
    const item = await prisma.turuuUnanswered.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!item) return res.status(404).json({ error: "Not found" });
    await Promise.all([
      prisma.turuuKnowledge.create({
        data: { orgId: req.org.orgId, question: item.question, answer: answer.trim(), category: category || "FAQ" },
      }),
      prisma.turuuUnanswered.update({ where: { id: req.params.id }, data: { resolved: true } }),
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// DELETE /client/unanswered/:id — dismiss
router.delete("/unanswered/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const item = await prisma.turuuUnanswered.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!item) return res.status(404).json({ error: "Not found" });
    await prisma.turuuUnanswered.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── PDF IMPORT ───────────────────────────────────────────────────────────────

const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function handlePdfUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "PDF файлын хэмжээ хэтэрсэн байна (дээд тал нь 10MB)" });
    }
    return res.status(400).json({ error: "Файл хүлээн авахад алдаа гарлаа" });
  }
  next(err);
}

// POST /client/upload/pdf — PDF-аас Q&A автоматаар гаргаж KB-д нэмнэ
router.post("/upload/pdf", blockIfExpired, requireFeature("fileImport"), pdfUpload.single("file"), handlePdfUploadError, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file шаардлагатай" });
    if (req.file.mimetype !== "application/pdf") return res.status(400).json({ error: "Зөвхөн PDF файл оруулна уу" });

    const pdfParse = require("pdf-parse");
    const parsed = await pdfParse(req.file.buffer);
    const text = parsed.text?.slice(0, 12000) || "";
    if (!text.trim()) return res.status(400).json({ error: "PDF-аас текст гарсангүй" });

    const OpenAI = require("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const aiRes = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Та дараах бичвэрийг уншаад бизнесийн мэдлэгийн санд тохирох Q&A хосуудыг гаргана уу.
JSON массив хэлбэрт буцаана: [{"question":"...","answer":"...","category":"..."}]
Category: Бүтээгдэхүүн | Үнэ | Хүргэлт | Процесс | Компани | FAQ
Хамгийн багадаа 5, хамгийн ихдээ 30 Q&A гарга.
Зөвхөн JSON буцаа — тайлбар нэмэхгүй.`,
        },
        { role: "user", content: text },
      ],
      temperature: 0.2,
      max_tokens: 2048,
    });

    let items = [];
    try {
      const content = aiRes.choices[0].message.content?.trim() || "[]";
      const cleaned = content.replace(/^```json\n?/, "").replace(/\n?```$/, "");
      items = JSON.parse(cleaned);
    } catch { return res.status(500).json({ error: "AI хариулт задлахад алдаа гарлаа" }); }

    const prisma = getPrisma();
    const orgId = req.org.orgId;
    for (const item of items) {
      if (item.question && item.answer) {
        await prisma.turuuKnowledge.create({
          data: { orgId, question: item.question, answer: item.answer, category: item.category || "FAQ" },
        });
      }
    }
    // PDF → KB импорт — тогтмол тоогоор квотоос хасна
    try { const q = require("../lib/quota"); await q.incrementMessageUsedBy(orgId, q.PDF_IMPORT_COST); } catch { /* non-blocking */ }
    res.json({ ok: true, count: items.length });
  } catch (e) {
    console.error("[client/upload/pdf] Error:", e.message);
    res.status(500).json({ error: "PDF боловсруулахад серверийн алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу." });
  }
});

// ─── EXCEL PRODUCT IMPORT ───────────────────────────────────────────────────

const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function handleExcelUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Файлын хэмжээ хэтэрсэн байна (дээд тал нь 10MB)" });
    }
    return res.status(400).json({ error: "Файл хүлээн авахад алдаа гарлаа" });
  }
  next(err);
}

const EXCEL_HEADERS = ["Нэр", "Үнэ", "Ангилал", "Тайлбар", "Размер", "Өнгө", "Үлдэгдэл", "ЗурагURL"];
const EXCEL_MAX_ROWS = 500;

// "Үнэ: X₮. <тайлбар>" хэлбэрийн KB answer текст үүсгэнэ (knowledge/page.tsx-ийн formatProductAnswer-тэй ижил)
function formatProductAnswerSrv(price, description) {
  const trimmedPrice = String(price ?? "").trim().replace(/,/g, "");
  const trimmedDesc = String(description ?? "").trim();
  if (!trimmedPrice || isNaN(Number(trimmedPrice))) return trimmedDesc;
  const formatted = Number(trimmedPrice).toLocaleString("mn-MN");
  return `Үнэ: ${formatted}₮.${trimmedDesc ? ` ${trimmedDesc}` : ""}`;
}

// GET /client/upload/excel/template — бараа импортын загвар .xlsx татах
router.get("/upload/excel/template", async (req, res) => {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Бараа");
  ws.addRow(EXCEL_HEADERS);
  ws.addRow(["Эрэгтэй футболк", 35000, "Цамц", "100% хөнгөн даавуу", "M", "Цагаан", 10, ""]);
  ws.addRow(["Эрэгтэй футболк", 35000, "Цамц", "100% хөнгөн даавуу", "L", "Цагаан", 5, ""]);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=baraa-import-zagvar.xlsx");
  await wb.xlsx.write(res);
  res.end();
});

// POST /client/upload/excel — Excel-ээс бараа бөөнөөр KB-д импортлоно (шинэ нэмэх / ижил нэртэйг шинэчлэх)
router.post("/upload/excel", blockIfExpired, requireFeature("fileImport"), excelUpload.single("file"), handleExcelUploadError, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file шаардлагатай" });

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(req.file.buffer);
    } catch {
      return res.status(400).json({ error: "Excel (.xlsx) файл уншихад алдаа гарлаа" });
    }
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: "Excel-д хуудас олдсонгүй" });
    if (ws.rowCount - 1 > EXCEL_MAX_ROWS) {
      return res.status(400).json({ error: `Excel-д хэт олон мөр байна (дээд тал нь ${EXCEL_MAX_ROWS} мөр)` });
    }

    const headerRow = ws.getRow(1);
    const colIndex = {};
    headerRow.eachCell((cell, colNumber) => {
      const key = String(cell.value ?? "").trim().toLowerCase();
      if (key) colIndex[key] = colNumber;
    });
    const nameCol = colIndex["нэр"];
    const priceCol = colIndex["үнэ"];
    if (!nameCol || !priceCol) {
      return res.status(400).json({ error: `Excel-д "Нэр" болон "Үнэ" багана заавал байх ёстой. Загвар татаж ашиглана уу.` });
    }
    const catCol = colIndex["ангилал"];
    const descCol = colIndex["тайлбар"];
    const sizeCol = colIndex["размер"];
    const colorCol = colIndex["өнгө"];
    const stockCol = colIndex["үлдэгдэл"];
    const imageCol = colIndex["зурагurl"];

    const cellText = (row, col) => {
      if (!col) return "";
      const v = row.getCell(col).value;
      if (v == null) return "";
      if (typeof v === "object" && "result" in v) return String(v.result ?? "").trim();
      if (typeof v === "object" && "text" in v) return String(v.text ?? "").trim();
      return String(v).trim();
    };

    // "Нэр"-ээр бүлэглэнэ — ижил нэртэй мөрүүд нэг барааны хувилбарууд (Размер/Өнгө/Үлдэгдэл) болно
    const groups = new Map();
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const name = cellText(row, nameCol);
      if (!name) continue;
      const key = name.trim().toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { name: name.trim(), price: "", category: "", description: "", variants: [] });
      }
      const g = groups.get(key);
      const price = cellText(row, priceCol);
      const category = cellText(row, catCol);
      const description = cellText(row, descCol);
      const size = cellText(row, sizeCol);
      const color = cellText(row, colorCol);
      const stock = cellText(row, stockCol);
      const imageUrl = cellText(row, imageCol);
      if (!g.price && price) g.price = price;
      if (!g.category && category) g.category = category;
      if (!g.description && description) g.description = description;
      if (size || color || imageUrl || stock) {
        g.variants.push({ size, color, stock: parseInt(stock, 10) || 0, ...(imageUrl ? { imageUrl } : {}) });
      }
    }
    if (groups.size === 0) return res.status(400).json({ error: "Excel-д бараа олдсонгүй" });

    const prisma = getPrisma();
    const orgId = req.org.orgId;
    const currentKB = await prisma.turuuKnowledge.findMany({
      where: { orgId }, select: { id: true, question: true, answer: true, category: true, variants: true },
    });
    const productKB = currentKB.filter((k) => k.category?.startsWith(PRODUCT_PREFIX));

    // Тус бүрд одоо байгаа бараатай таарч байгаа эсэхийг тодорхойлно (нэрийн дагуу, 60%+ ижил бол шинэчлэх)
    // Группуудыг хамгийн өндөр score-той нь ЭХЛЭЭД боловсруулна — нэг KB item-ийг ЗӨВХӨН НЭГ удаа claim хийнэ
    // (хоёр өөр бараа ижил KB item-д давхар update хийж нэг нь нөгөөгөө дарахаас сэргийлнэ)
    const scored = [];
    for (const g of groups.values()) {
      let bestMatch = null, bestScore = 0;
      for (const kb of productKB) {
        const score = productSimilarity(g.name, kb.question);
        if (score > bestScore) { bestScore = score; bestMatch = kb; }
      }
      scored.push({ g, bestMatch, bestScore });
    }
    scored.sort((a, b) => b.bestScore - a.bestScore);
    const claimedKbIds = new Set();
    for (const s of scored) {
      if (s.bestScore >= 0.6 && s.bestMatch && !claimedKbIds.has(s.bestMatch.id)) {
        s.g.bestMatch = s.bestMatch;
        claimedKbIds.add(s.bestMatch.id);
      } else {
        s.g.bestMatch = null; // claim хийгдсэн эсвэл доогуур score — шинээр үүсгэнэ
      }
    }

    // "Ангилал" хоосон, шинээр үүсгэх бараануудыг AI-аар дэд ангилалд хуваарилна
    const existingSubCats = [...new Set(
      productKB.map((k) => k.category.slice(PRODUCT_PREFIX.length).trim()).filter(Boolean)
    )];
    const unclassified = [...groups.values()].filter((g) => !g.category.trim() && !g.bestMatch).map((g) => g.name);
    const aiCategoryMap = {};
    if (unclassified.length > 0) {
      try {
        const OpenAI = require("openai");
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const aiRes = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Та барааны нэрсийн жагсаалтыг уншаад тус бүрд тохирох ДЭД АНГИЛАЛ нэрийг гаргана уу.${existingSubCats.length > 0 ? ` Боломжтой бол дараах одоо байгаа ангилалуудаас сонго: ${existingSubCats.join(", ")}. Тохирохгүй бол шинэ ангилал нэр санал болго.` : " Тохирох богино, ойлгомжтой ангилал нэр санал болго."}
JSON object хэлбэрт буцаа: {"<барааны нэр>": "<дэд ангилал>"}. Зөвхөн JSON буцаа — тайлбар нэмэхгүй.`,
            },
            { role: "user", content: unclassified.join("\n") },
          ],
          temperature: 0.2,
          max_tokens: 1024,
        });
        const content = aiRes.choices[0].message.content?.trim() || "{}";
        const cleaned = content.replace(/^```json\n?/, "").replace(/\n?```$/, "");
        Object.assign(aiCategoryMap, JSON.parse(cleaned));
        // Excel импорт (AI ангилал ажилласан үед) — тогтмол тоогоор квотоос хасна
        try { const q = require("../lib/quota"); await q.incrementMessageUsedBy(orgId, q.EXCEL_IMPORT_COST); } catch { /* non-blocking */ }
      } catch (e) {
        console.error("[client/upload/excel] AI category error:", e.message);
      }
    }

    let created = 0, updated = 0;
    const touchedIds = []; // вэбсайт руу sync хийх KB мөрүүд
    for (const g of groups.values()) {
      const answer = formatProductAnswerSrv(g.price, g.description) || g.name;
      const variants = g.variants.length > 0 ? g.variants : null;

      if (g.bestMatch) {
        const mergedVariants = mergeVariants(g.bestMatch.variants, variants);
        const categoryUpdate = g.category.trim() ? { category: normalizeProductCategory(g.category.trim()) } : {};
        await prisma.turuuKnowledge.update({
          where: { id: g.bestMatch.id },
          data: { answer, ...categoryUpdate, ...(mergedVariants ? { variants: mergedVariants } : {}) },
        });
        touchedIds.push(g.bestMatch.id);
        updated++;
      } else {
        const subCat = g.category.trim() || aiCategoryMap[g.name] || "Бусад";
        const newItem = await prisma.turuuKnowledge.create({
          data: { orgId, question: g.name, answer, category: normalizeProductCategory(subCat), variants },
        });
        touchedIds.push(newItem.id);
        created++;
      }
    }

    // Excel-ээр импортолсон бүх барааг вэбсайтын Product руу тусгана
    if (touchedIds.length > 0) {
      const touched = await prisma.turuuKnowledge.findMany({ where: { id: { in: touchedIds } } });
      await storeSync.syncManyKnowledgeToStore(orgId, touched);
    }

    res.json({ ok: true, created, updated, total: groups.size });
  } catch (e) {
    console.error("[client/upload/excel] Error:", e.message);
    res.status(500).json({ error: "Excel боловсруулахад серверийн алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу." });
  }
});

// ─── FUNNEL ANALYTICS ────────────────────────────────────────────────────────

// GET /client/analytics/funnel
router.get("/analytics/funnel", async (req, res) => {
  try {
    const demo = require("../lib/demoAnalytics");
    if (demo.DEMO_ON()) return res.json(demo.demoFunnel());
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    const cacheKeyF = `funnel:${orgId}`;
    const cachedFunnel = cache.get(cacheKeyF);
    if (cachedFunnel !== undefined) return res.json(cachedFunnel);
    const [conversations, leads, consultations, orders] = await Promise.all([
      prisma.turuuChat.count({ where: { orgId } }),
      prisma.turuuLead.count({ where: { orgId } }),
      prisma.turuuConsultation.count({ where: { orgId } }),
      prisma.turuuOrder.count({ where: { orgId } }),
    ]);
    const unanswered = await prisma.turuuUnanswered.count({ where: { orgId, resolved: false } });
    const funnelPayload = {
      conversations,
      leads,
      consultations,
      orders,
      unanswered,
      convRate: conversations > 0 ? Math.round((leads / conversations) * 100) : 0,
      closeRate: leads > 0 ? Math.round((orders / leads) * 100) : 0,
    };
    cache.set(cacheKeyF, funnelPayload, 30_000);
    res.json(funnelPayload);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── HANDOFF ─────────────────────────────────────────────────────────────────

// POST /client/conversations/:psid/handoff-clear
router.post("/conversations/:psid/handoff-clear", async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.turuuChat.updateMany({
      where: { psid: req.params.psid, orgId: req.org.orgId },
      data: { handoffRequested: false },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// ─── QPAY ────────────────────────────────────────────────────────────────────

// GET /client/profile/qpay — QPay тохиргоо харах
router.get("/profile/qpay", async (req, res) => {
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: req.org.orgId },
      select: {
        qpayMerchantId: true,
        qpayBankCode: true,
        qpayAccountNumber: true,
        qpayAccountName: true,
        qpayBranchCode: true,
      },
    });
    const { BANK_CODES } = require("../services/qpay.service");
    res.json({ ...org, bankCodes: BANK_CODES });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// PUT /client/profile/qpay/bank — банкны данс хадгалах
router.put("/profile/qpay/bank", requireOwner, async (req, res) => {
  try {
    const { bankCode, accountNumber, accountName, branchCode } = req.body;
    if (!bankCode || !accountNumber || !accountName) {
      return res.status(400).json({ error: "bankCode, accountNumber, accountName шаардлагатай" });
    }
    const prisma = getPrisma();
    await prisma.organization.update({
      where: { id: req.org.orgId },
      data: {
        qpayBankCode: bankCode,
        qpayAccountNumber: accountNumber,
        qpayAccountName: accountName,
        qpayBranchCode: branchCode || "BRANCH_001",
      },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/profile/qpay/register — QPay sub-merchant болгох
router.post("/profile/qpay/register", requireOwner, async (req, res) => {
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId } });
    if (org.qpayMerchantId) {
      return res.status(400).json({ error: "Аль хэдийн QPay merchant болсон байна", merchantId: org.qpayMerchantId });
    }

    const { type, ...data } = req.body; // type: "company" | "person"
    if (!type || !["company", "person"].includes(type)) {
      return res.status(400).json({ error: "type: 'company' эсвэл 'person' байх ёстой" });
    }

    const qpay = require("../services/qpay.service");
    const result = type === "company"
      ? await qpay.createMerchantCompany(data)
      : await qpay.createMerchantPerson(data);

    const merchantId = result.id || result.merchant_id;
    if (!merchantId) return res.status(500).json({ error: "QPay-аас merchant_id ирсэнгүй", result });

    await prisma.organization.update({
      where: { id: req.org.orgId },
      data: { qpayMerchantId: merchantId },
    });

    res.json({ ok: true, merchantId, result });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/profile/qpay/cities — QPay хот/аймгийн жагсаалт
router.get("/profile/qpay/cities", async (req, res) => {
  try {
    const qpay = require("../services/qpay.service");
    const result = await qpay.getCities();
    res.json(result);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/profile/qpay/districts/:cityCode — QPay дүүрэг/сумын жагсаалт
router.get("/profile/qpay/districts/:cityCode", async (req, res) => {
  try {
    const qpay = require("../services/qpay.service");
    const result = await qpay.getDistricts(req.params.cityCode);
    res.json(result);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// GET /client/profile/qpay/merchant — QPay-аас merchant мэдээлэл авах
router.get("/profile/qpay/merchant", async (req, res) => {
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: req.org.orgId },
      select: { qpayMerchantId: true },
    });
    if (!org.qpayMerchantId) return res.status(400).json({ error: "QPay merchant бүртгэлгүй" });
    const qpay = require("../services/qpay.service");
    const result = await qpay.getMerchant(org.qpayMerchantId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/orders/:id/invoice — QPay invoice + QR үүсгэх
router.post("/orders/:id/invoice", async (req, res) => {
  try {
    const prisma = getPrisma();
    const order = await prisma.turuuOrder.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });

    if (order.qpayInvoiceId) {
      return res.json({
        ok: true,
        alreadyCreated: true,
        invoiceId: order.qpayInvoiceId,
        qrText: order.qpayQrText,
        urls: order.qpayUrls,
        qpayStatus: order.qpayStatus,
      });
    }

    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId } });
    if (!org.qpayMerchantId) return res.status(400).json({ error: "QPay merchant бүртгэлгүй. Эхлээд /profile/qpay/register дуудна уу." });
    if (!org.qpayAccountNumber) return res.status(400).json({ error: "Банкны дансны мэдээлэл оруулаагүй. /profile/qpay/bank дуудна уу." });

    const qpay = require("../services/qpay.service");
    const result = await qpay.createInvoice({
      merchantId: org.qpayMerchantId,
      branchCode: org.qpayBranchCode || "BRANCH_001",
      amount: order.totalAmount || 0,
      description: `Захиалга #${order.id.slice(-6).toUpperCase()}`,
      customerName: order.customerName || "Хэрэглэгч",
      bankAccounts: [{
        default: true,
        account_bank_code: org.qpayBankCode,
        account_number: org.qpayAccountNumber,
        account_name: org.qpayAccountName,
        is_default: true,
      }],
      callbackUrl: `${process.env.API_URL || "https://api.mongolagent.mn"}/webhook/qpay/${order.id}`,
    });

    await prisma.turuuOrder.update({
      where: { id: order.id },
      data: {
        qpayInvoiceId: result.invoice_id,
        qpayQrText: result.qr_text,
        qpayUrls: result.urls || [],
        qpayStatus: "PENDING",
      },
    });

    res.json({ ok: true, invoiceId: result.invoice_id, qrText: result.qr_text, urls: result.urls });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

// POST /client/orders/:id/check-payment — QPay төлбөр шалгах
router.post("/orders/:id/check-payment", async (req, res) => {
  try {
    const prisma = getPrisma();
    const order = await prisma.turuuOrder.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });
    if (!order.qpayInvoiceId) return res.status(400).json({ error: "Invoice үүсгэгдээгүй байна" });

    const qpay = require("../services/qpay.service");
    const result = await qpay.checkPayment(order.qpayInvoiceId);

    const paid = result.invoice_status === "PAID";

    if (paid && order.qpayStatus !== "PAID") {
      await prisma.turuuOrder.update({
        where: { id: order.id },
        data: { qpayStatus: "PAID", status: "PAID", paymentMethod: "qpay" },
      });
      // Messenger мэдэгдэл (callback алдагдсан тохиолдолд)
      if (order.psid) {
        try {
          const org = await prisma.organization.findUnique({ where: { id: req.org.orgId }, select: { fbPageToken: true } });
          const token = decrypt(org?.fbPageToken) || process.env.FB_PAGE_ACCESS_TOKEN;
          if (token) {
            const orderCode = order.id.slice(-6).toUpperCase();
            await sendText(order.psid, `✅ Таны төлбөр амжилттай хийгдлээ! Захиалга #${orderCode} батлагдлаа 🙏`, token).catch(() => {});
          }
        } catch { /* non-blocking */ }
      }
    }

    res.json({ paid, qpayStatus: paid ? "PAID" : "PENDING", result });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

module.exports = router;
