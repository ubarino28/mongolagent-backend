"use strict";
const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Resend } = require("resend");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { getPrisma } = require("../lib/db");
const { clientAuthMiddleware } = require("../middleware/clientAuth");
const { sendText } = require("../services/facebook.service");

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
      create: { psid: req.params.psid, orgId: req.org.orgId, messages, handoffRequested: true, handoffAt: new Date() },
      update: { messages, handoffRequested: true, handoffAt: new Date() },
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
    const { question, answer, category, imageUrl, variants } = req.body;
    if (!question || !answer) return res.status(400).json({ error: "question, answer шаардлагатай" });
    const prisma = getPrisma();
    const item = await prisma.turuuKnowledge.create({
      data: { orgId: req.org.orgId, question, answer, category, imageUrl: imageUrl || null, variants: variants ?? null },
    });
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /client/knowledge/:id
router.put("/knowledge/:id", async (req, res) => {
  try {
    const { question, answer, category, active, imageUrl, variants } = req.body;
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
      },
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

// DELETE /client/knowledge — бүх мэдлэгийн санг устгана (frontend-ийн "Дахин эхлүүлэх" товчинд)
router.delete("/knowledge", async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.turuuKnowledge.deleteMany({ where: { orgId: req.org.orgId } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
router.post("/settings/builder", async (req, res) => {
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
→ save_knowledge_items дуудаж хадгал.
→ 🏷️ CATEGORY ШИЙДВЭР (заавал дагах):
   • Хэрэв энэ бол тодорхой БҮТЭЭГДЭХҮҮН/БАРАА тухай мэдээлэл (нэр + үнэ/размер/өнгө/зураг зэрэг тодорхой нэг бараанд хамаарах) бол category-г ЗААВАЛ "Бүтээгдэхүүн / <дэд ангилал>" хэлбэрээр бич.
   • <дэд ангилал>-ыг ЗААВАЛ Монгол КИРИЛЛ бичгээр бич — хэрэглэгч латин үсгээр ("tsamts", "gutal") бичсэн ч кирилл рүү хөрвүүлж бич ("Цамц", "Гутал").
   • Дээрх "ОДОО БАЙГАА МЭДЛЭГИЙН САН"-д "Бүтээгдэхүүн / ..." эхэлсэн ижил төстэй дэд ангилал байвал яг тэр нэрийг давтан ашигла — шинэ хувилбар (өөр бичигдэлтэй ижил утгатай) бүү үүсгэ.
   • Бизнесийн ерөнхий мэдээлэл (компани, хүргэлт, цаг, FAQ, бодлого г.м.) бол "Бүтээгдэхүүн / ..." АШИГЛАХГҮЙ — ердийн category (Компани, Хүргэлт, FAQ г.м.) ашигла.
   • Мэдээлэл нь СЭДВИЙН дагуу: хүргэлттэй холбоотой бол category "Хүргэлт", буцаалт/солилт/гомдлын журамтай холбоотой бол category "Буцаалт", төлбөртэй холбоотой бол category "Төлбөр" гэж ангилж хадгал — "Үйлчилгээ" гэх мэт ерөнхий category-д хольж хадгалахгүй. Эдгээр нь зөвхөн жишээ — category-н тоо ХЯЗГААРГҮЙ, агуулгад хамгийн тохирох category нэрийг чи өөрөө шийдэж ашиглана.
   • ⚠️ Аль хэдийн "Бүтээгдэхүүн / ..." гэж тогтсон бараанд НЭМЭЛТ мэдээлэл (размер, өнгө, үлдэгдэл, нэмэлт зураг г.м.) өгч байгаа бол category-г ХЭВЭЭР "Бүтээгдэхүүн / <ижил дэд ангилал>" гэж бич — ердийн category руу СОЛИХГҮЙ.
   • Хэрэв БҮТЭЭГДЭХҮҮНИЙ мэдээлэлд размер/өнгө/үлдэгдлийн тоо орсон бол (жишээ: "M размер, улаан өнгөтэй, нийт 50 ширхэг") — энэ мэдээллийг variants массивт {size, color, stock} хэлбэрээр оруул. "answer" (тайлбар) дотор тоо хэмжээгээ ДАВТАН БИЧИХГҮЙ — зөвхөн үнэ/материал/онцлог зэрэг тайлбарыг бич.
   • 📌 ЖИШЭЭ: хэрэглэгч "цамц категори нээгээд 50 ширхэг нэмээрэй, нэр нь Свитер, өнгө нь улаан, M размер" гэвэл →
     save_knowledge_items({ items: [{ question: "Свитер", answer: "Хөнгөн даавуу", category: "Бүтээгдэхүүн / Цамц", variants: [{ size: "M", color: "Улаан", stock: 50 }] }] })
     (category-д ЗААВАЛ "Бүтээгдэхүүн / " угтвар орно, "answer"-д хэмжээ/тоо ДАВТАГДАХГҮЙ, variants-д size/color/stock тусдаа орно.)
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

5️⃣ АЖЛЫН ЦАГ + ХҮРГЭЛТ
"Ажлын цаг хэд вэ? Мөн хүргэлтийн нөхцөлөө дэлгэрэнгүй хэлнэ үү — хамрах хүрээ (аль хот/дүүрэг), хүргэлтийн төлбөр хэд вэ, хэдэн хоногт хүргэдэг, ямар үнийн дүнгээс дээш захиалгад хүргэлт үнэгүй болохыг хэлнэ үү?
Нийтлэг жишээ: "Да-Ба 9:00-20:00, Ня 10:00-18:00. Зөвхөн УБ хот, захиалгаас 1-2 хоногт хүргэнэ. Хүргэлт 6,000₮, 100,000₮-аас дээш захиалгад үнэгүй.""

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
⚠️ "А. ЕРӨНХИЙ" багцын 5️⃣ асуулт (АЖЛЫН ЦАГ + ХҮРГЭЛТ): хэрэглэгч хүргэлтийн мэдээлэл (төлбөр/хамрах хүрээ/хугацаа/үнэгүй болох босго) өгвөл category-г ЗААВАЛ "Хүргэлт" гэж хадгал — захиалгын процессын тооцоолол search_knowledge("хүргэлт")-ээр яг энэ category-г хайдаг.
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
          let created = 0, merged = 0;
          // Шинэ save бүрт existingKB-г refresh хийнэ
          const currentKB = await prisma.turuuKnowledge.findMany({
            where: { orgId }, select: { id: true, question: true, answer: true, category: true, variants: true },
          });

          for (const item of args.items) {
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
              created++;
            }
          }
          savedItems += args.items.length;
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ created, merged }) });
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

// ─── QUOTA ───────────────────────────────────────────────────────────────────

const PLAN_QUOTA = { starter: 7000, growth: 15000, business: 30000, enterprise: 70000 };

// GET /client/quota
router.get("/quota", async (req, res) => {
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: req.org.orgId },
      select: { plan: true, messageUsed: true, quotaResetAt: true },
    });
    const quota = PLAN_QUOTA[org.plan] || 10000;
    res.json({ plan: org.plan, quota, messageUsed: org.messageUsed || 0, quotaResetAt: org.quotaResetAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ANALYTICS ───────────────────────────────────────────────────────────────

// GET /client/analytics
router.get("/analytics", async (req, res) => {
  try {
    const prisma = getPrisma();
    const orgId = req.org.orgId;

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

    // Орлогын тооцоолол — хугацаагаар (today / 7d / 30d / all)
    const period = req.query.period || "all";
    const periodFilter = period === "today" ? { gte: new Date(new Date().setHours(0,0,0,0)) }
      : period === "7d" ? { gte: new Date(Date.now() - 7 * 86400000) }
      : period === "30d" ? { gte: new Date(Date.now() - 30 * 86400000) }
      : undefined;
    const dateWhere = periodFilter ? { createdAt: periodFilter } : {};

    const [orderRevenue, appointmentRevenue, storeRevenue, dailyRevenue] = await Promise.all([
      prisma.turuuOrder.aggregate({ where: { orgId, status: "PAID", ...dateWhere }, _sum: { totalAmount: true }, _count: true }),
      prisma.turuuAppointment.aggregate({ where: { orgId, depositStatus: "PAID", ...dateWhere }, _sum: { depositAmount: true }, _count: true }),
      prisma.$queryRaw`SELECT COALESCE(SUM("totalAmount"), 0)::float as total, COUNT(*)::int as cnt FROM "StoreOrder" WHERE "orgId" = ${orgId} AND "status" = 'PAID' ${periodFilter ? prisma.$queryRaw` AND "createdAt" >= ${periodFilter.gte}` : prisma.$queryRaw``}`.catch(() => [{ total: 0, cnt: 0 }]),
      prisma.$queryRaw`
        SELECT d.date, COALESCE(SUM(d.amount), 0)::float as amount FROM (
          SELECT DATE("createdAt") as date, "totalAmount" as amount FROM "TuruuOrder" WHERE "orgId" = ${orgId} AND "status" = 'PAID' AND "createdAt" >= NOW() - INTERVAL '30 days'
          UNION ALL
          SELECT DATE("createdAt") as date, "depositAmount" as amount FROM "TuruuAppointment" WHERE "orgId" = ${orgId} AND "depositStatus" = 'PAID' AND "createdAt" >= NOW() - INTERVAL '30 days'
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

    res.json({ totalConversations, totalLeads, totalConsultations, totalOrders, newLeads, dailyMessages, dailyLeads, revenue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ORDERS ──────────────────────────────────────────────────────────────────

// GET /client/orders
router.get("/orders", async (req, res) => {
  try {
    const { page = 1, status, search } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;
    const orgId = req.org.orgId;
    const where = { orgId };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { customerName: { contains: search, mode: "insensitive" } },
        { customerPhone: { contains: search } },
      ];
    }
    const prisma = getPrisma();
    const [data, total] = await Promise.all([
      prisma.turuuOrder.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
      prisma.turuuOrder.count({ where }),
    ]);
    res.json({ data, total, page: Number(page), pages: Math.ceil(total / take) || 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/orders
router.post("/orders", async (req, res) => {
  try {
    const { customerName, customerPhone, customerEmail, deliveryAddress, items, totalAmount, notes, psid } = req.body;
    const prisma = getPrisma();
    const order = await prisma.turuuOrder.create({
      data: { orgId: req.org.orgId, customerName, customerPhone, customerEmail, deliveryAddress, items, totalAmount, notes, psid },
    });
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/orders/:id/confirm-payment — Эзэн төлбөр баталгаажуулах + хэрэглэгчид Messenger мэдэгдэл
router.post("/orders/:id/confirm-payment", async (req, res) => {
  try {
    const prisma = getPrisma();
    const order = await prisma.turuuOrder.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!order) return res.status(404).json({ error: "Not found" });
    const updateData = { status: "PAID" };
    // QPay invoice байвал цуцлах — давхар төлбөр хийгдэхээс сэргийлнэ
    if (order.qpayInvoiceId && order.qpayStatus !== "PAID") {
      updateData.qpayStatus = "CANCELLED";
      try {
        const qpay = require("../services/qpay.service");
        await qpay.cancelInvoice(order.qpayInvoiceId);
      } catch { /* QPay цуцлалт амжилтгүй бол DB-д CANCELLED тэмдэглэнэ, webhook-д шалгагдана */ }
    }
    await prisma.turuuOrder.update({ where: { id: order.id }, data: updateData });
    // Messenger-ээр хэрэглэгчид мэдэгдэл
    if (order.psid) {
      try {
        const org = await prisma.organization.findUnique({ where: { id: req.org.orgId }, select: { fbPageToken: true } });
        const token = org?.fbPageToken || process.env.FB_PAGE_ACCESS_TOKEN;
        if (token) {
          const orderCode = order.id.slice(-6).toUpperCase();
          await sendText(order.psid, `✅ Таны төлбөр баталгаажлаа! Захиалга #${orderCode} батлагдлаа. Удахгүй хүргэлт хийгдэнэ 🙏`, token).catch(() => {});
        }
      } catch { /* non-blocking */ }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /client/orders/:id
router.delete("/orders/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const order = await prisma.turuuOrder.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!order) return res.status(404).json({ error: "Not found" });
    await prisma.turuuOrder.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PASSWORD CHANGE ─────────────────────────────────────────────────────────

// PUT /client/profile/password
router.put("/profile/password", async (req, res) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      starter:    { name: "Starter",    price: 79900,  quota: 7000,  features: ["7,000 мессеж/сар", "Facebook Messenger AI", "Builder AI", "Мэдлэгийн сан (30)", "Lead цуглуулах", "Telegram мэдэгдэл"] },
      growth:     { name: "Growth",     price: 149900, quota: 15000, features: ["15,000 мессеж/сар", "Захиалга + QPay", "Consultation захиалга", "+1 → DM автоматжуулалт", "PDF → KB", "Funnel analytics"] },
      business:   { name: "Business",   price: 249900, quota: 30000, features: ["30,000 мессеж/сар", "Instagram канал", "Custom keyword → DM", "Хүний handoff", "AI тохиргоо", "Telegram дэмжлэг"] },
      enterprise: { name: "Enterprise", price: 499900, quota: 70000, features: ["70,000 мессеж/сар", "Custom AI Chatbot", "Custom AI Agent", "Custom Website", "White label", "Олон хуудас + API"] },
    };
    res.json({ ...org, quota, messageUsed: org.messageUsed || 0, plans: PLANS, currentPlan: PLANS[org.plan] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/billing/upgrade
router.post("/billing/upgrade", async (req, res) => {
  try {
    const { targetPlan } = req.body;
    const UPGRADE_ORDER = ["starter", "growth", "business", "enterprise"];
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId }, select: { plan: true, email: true, name: true } });
    if (UPGRADE_ORDER.indexOf(targetPlan) <= UPGRADE_ORDER.indexOf(org.plan)) {
      return res.status(400).json({ error: "Зөвхөн дээш ахиулах боломжтой" });
    }
    res.json({ ok: true, message: "Upgrade хүсэлт хүлээн авлаа. Манай баг тантай холбогдоно." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/billing/pay — QPay subscription invoice үүсгэх
router.post("/billing/pay", async (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan) return res.status(400).json({ error: "plan шаардлагатай" });

    const PLAN_PRICE = { starter: 79900, growth: 149900, business: 249900, enterprise: 499900 };
    const PLAN_NAME  = { starter: "Starter", growth: "Growth", business: "Business", enterprise: "Enterprise" };
    const amount = PLAN_PRICE[plan];
    if (!amount) return res.status(400).json({ error: "Буруу план" });

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
      description: `Mongol Agent — ${PLAN_NAME[plan]} план (1 сар)`,
    });

    await prisma.organization.update({
      where: { id: org.id },
      data: { subInvoiceId: result.invoice_id, subQpayStatus: "PENDING" },
    });

    res.json({ ok: true, invoiceId: result.invoice_id, qrText: result.qr_text, qrImage: result.qr_image, urls: result.urls });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/billing/pay/check — Subscription төлбөр шалгах
router.post("/billing/pay/check", async (req, res) => {
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: req.org.orgId },
      select: { subInvoiceId: true, subQpayStatus: true },
    });
    if (!org.subInvoiceId) return res.status(400).json({ error: "Invoice байхгүй" });

    const subQpay = require("../services/subscription-qpay.service");
    const result = await subQpay.checkPayment(org.subInvoiceId);
    const paid = result.invoice_status === "PAID";

    if (paid && org.subQpayStatus !== "PAID") {
      await prisma.organization.update({
        where: { id: req.org.orgId },
        data: { subQpayStatus: "PAID" },
      });
    }

    res.json({ paid, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/chat
router.post("/chat", async (req, res) => {
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

    const systemPrompt = await buildSystemPrompt(false, orgId);
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const CHAT_TOOLS = [
      {
        type: "function",
        function: {
          name: "search_knowledge",
          description: "Хэрэглэгчийн асуултад хамаарах мэдээллийг мэдлэгийн сангаас хайна. Бүтээгдэхүүн, үнэ, хүргэлт, буцаалт, ажлын цаг болон компанийн мэдээлэл авахад ашиглана.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Хайх үгс — монгол хэлээр, тодорхой" },
            },
            required: ["query"],
          },
        },
      },
    ];

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

    if (choice.finish_reason === "tool_calls") {
      const toolResults = [];
      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.function.name === "search_knowledge") {
          const { query } = JSON.parse(toolCall.function.arguments);
          const items = await prisma.turuuKnowledge.findMany({
            where: { orgId, active: true },
            select: { question: true, answer: true, category: true, variants: true, imageUrl: true },
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
                const vars = Array.isArray(s.item.variants) ? s.item.variants : [];
                const colors = [...new Set(vars.filter((v) => v.color && (v.stock == null || v.stock > 0)).map((v) => v.color))];
                if (colors.length > 0) text += `\nБайгаа өнгөнүүд: ${colors.join(", ")}`;
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
          toolResults.push({ tool_call_id: toolCall.id, content: result });
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

    res.json({ reply, ...(replyImageUrl ? { imageUrl: replyImageUrl } : {}) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /client/profile/name
router.put("/profile/name", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "name шаардлагатай" });
    const prisma = getPrisma();
    await prisma.organization.update({ where: { id: req.org.orgId }, data: { name: name.trim() } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/profile/email/request — шинэ email рүү код илгээх
router.post("/profile/email/request", async (req, res) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/profile/email/verify — код баталгаажуулж имэйл солих
router.post("/profile/email/verify", async (req, res) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /client/profile
router.get("/profile", async (req, res) => {
  try {
    const prisma = getPrisma();
    const [org, btSetting] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: req.org.orgId },
        select: { id: true, name: true, slug: true, email: true, plan: true, status: true, logoUrl: true, fbPageId: true, fbPageToken: true, telegramBotToken: true, telegramChatId: true, createdAt: true },
      }),
      prisma.turuuSettings.findUnique({
        where: { orgId_key: { orgId: req.org.orgId, key: "business_type" } },
      }),
    ]);
    res.json({ ...org, businessType: btSetting?.value || null });
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /client/unanswered/:id — dismiss
router.delete("/unanswered/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const item = await prisma.turuuUnanswered.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!item) return res.status(404).json({ error: "Not found" });
    await prisma.turuuUnanswered.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
router.post("/upload/pdf", pdfUpload.single("file"), handlePdfUploadError, async (req, res) => {
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
router.post("/upload/excel", excelUpload.single("file"), handleExcelUploadError, async (req, res) => {
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
    for (const g of groups.values()) {
      let bestMatch = null, bestScore = 0;
      for (const kb of productKB) {
        const score = productSimilarity(g.name, kb.question);
        if (score > bestScore) { bestScore = score; bestMatch = kb; }
      }
      g.bestMatch = bestScore >= 0.6 ? bestMatch : null;
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
      } catch (e) {
        console.error("[client/upload/excel] AI category error:", e.message);
      }
    }

    let created = 0, updated = 0;
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
        updated++;
      } else {
        const subCat = g.category.trim() || aiCategoryMap[g.name] || "Бусад";
        await prisma.turuuKnowledge.create({
          data: { orgId, question: g.name, answer, category: normalizeProductCategory(subCat), variants },
        });
        created++;
      }
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
    const prisma = getPrisma();
    const orgId = req.org.orgId;
    const [conversations, leads, consultations, orders] = await Promise.all([
      prisma.turuuChat.count({ where: { orgId } }),
      prisma.turuuLead.count({ where: { orgId } }),
      prisma.turuuConsultation.count({ where: { orgId } }),
      prisma.turuuOrder.count({ where: { orgId } }),
    ]);
    const unanswered = await prisma.turuuUnanswered.count({ where: { orgId, resolved: false } });
    res.json({
      conversations,
      leads,
      consultations,
      orders,
      unanswered,
      convRate: conversations > 0 ? Math.round((leads / conversations) * 100) : 0,
      closeRate: leads > 0 ? Math.round((orders / leads) * 100) : 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /client/profile/qpay/bank — банкны данс хадгалах
router.put("/profile/qpay/bank", async (req, res) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/profile/qpay/register — QPay sub-merchant болгох
router.post("/profile/qpay/register", async (req, res) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /client/profile/qpay/cities — QPay хот/аймгийн жагсаалт
router.get("/profile/qpay/cities", async (req, res) => {
  try {
    const qpay = require("../services/qpay.service");
    const result = await qpay.getCities();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /client/profile/qpay/districts/:cityCode — QPay дүүрэг/сумын жагсаалт
router.get("/profile/qpay/districts/:cityCode", async (req, res) => {
  try {
    const qpay = require("../services/qpay.service");
    const result = await qpay.getDistricts(req.params.cityCode);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        data: { qpayStatus: "PAID", status: "PAID" },
      });
      // Messenger мэдэгдэл (callback алдагдсан тохиолдолд)
      if (order.psid) {
        try {
          const org = await prisma.organization.findUnique({ where: { id: req.org.orgId }, select: { fbPageToken: true } });
          const token = org?.fbPageToken || process.env.FB_PAGE_ACCESS_TOKEN;
          if (token) {
            const orderCode = order.id.slice(-6).toUpperCase();
            await sendText(order.psid, `✅ Таны төлбөр амжилттай хийгдлээ! Захиалга #${orderCode} батлагдлаа 🙏`, token).catch(() => {});
          }
        } catch { /* non-blocking */ }
      }
    }

    res.json({ paid, qpayStatus: paid ? "PAID" : "PENDING", result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /client/staff/:id
router.delete("/staff/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.turuuStaff.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!existing) return res.status(404).json({ error: "Олдсонгүй" });
    await prisma.turuuStaff.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── RESTAURANT: MENU ────────────────────────────────────────────────────────

router.get("/menu", async (req, res) => {
  try {
    const prisma = getPrisma();
    const items = await prisma.turuuMenuItem.findMany({ where: { orgId: req.org.orgId, isActive: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/menu/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.turuuMenuItem.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!existing) return res.status(404).json({ error: "Олдсонгүй" });
    await prisma.turuuMenuItem.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── RESTAURANT: TABLES ──────────────────────────────────────────────────────

router.get("/tables", async (req, res) => {
  try {
    const prisma = getPrisma();
    const tables = await prisma.turuuTable.findMany({ where: { orgId: req.org.orgId, isActive: true }, orderBy: { tableNumber: "asc" } });
    res.json(tables);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/tables/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.turuuTable.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!existing) return res.status(404).json({ error: "Олдсонгүй" });
    await prisma.turuuTable.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
