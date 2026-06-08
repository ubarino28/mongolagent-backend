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

// POST /client/upload — зураг Supabase Storage-д байршуулна
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file шаардлагатай" });
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: "Зөвхөн зураг (jpg, png, webp, gif) оруулна уу" });

    const ext = req.file.originalname.split(".").pop().toLowerCase();
    const filename = `${req.org.orgId}/${Date.now()}.${ext}`;
    const supabase = getSupabase();

    const { error } = await supabase.storage.from("turuuai-assets").upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) return res.status(500).json({ error: error.message });

    const { data } = supabase.storage.from("turuuai-assets").getPublicUrl(filename);
    res.json({ url: data.publicUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
function normKB(s) {
  return s.toLowerCase().replace(/[?!。？！.,;:]/g, "").replace(/\s+/g, " ").trim();
}

function kbSimilarity(a, b) {
  const wa = new Set(normKB(a).split(" ").filter((w) => w.length > 1));
  const wb = new Set(normKB(b).split(" ").filter((w) => w.length > 1));
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

// POST /client/settings/builder — Builder AI: бизнесийн мэдээллээс мэдлэгийн сан үүсгэнэ
router.post("/settings/builder", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message шаардлагатай" });

    const orgId = req.org.orgId;
    const prisma = getPrisma();
    const OpenAI = require("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Одоо байгаа KB-г ачаалж Builder-д мэдүүлнэ
    const existingKB = await prisma.turuuKnowledge.findMany({
      where: { orgId },
      select: { id: true, question: true, answer: true },
    });

    const existingKBSummary = existingKB.length > 0
      ? existingKB.map((k) => `— ${k.question}: ${k.answer.slice(0, 80)}${k.answer.length > 80 ? "..." : ""}`).join("\n")
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

    const RESTART_BLOCK = existingKB.length <= 15
      ? `━━━━━━━━━━━━━━━━━━━━━━━━━
ДАХИН ЭХЛҮҮЛЭХ — БАТАЛГААЖУУЛАЛТГҮЙГЭЭР ШУУД ХИЙНЭ
━━━━━━━━━━━━━━━━━━━━━━━━━
Одоогийн мэдлэгийн санд ердөө ${existingKB.length} зүйл байна (анхны автомат тохиргооноос өөр чухал зүйл хуримтлагдаагүй магадлалтай хэмжээ). Тиймээс хэрэглэгч "эхнээс эхлүүлэх", "дахин тохируулах", "бүгдийг устгаад шинээр эхэл" гэх мэт хүсэлт гаргамагц — баталгаажуулах асуулт ОГТ АСУУХГҮЙГЭЭР шууд clear_knowledge функцийг дуудаад "Эхнээс эхэллээ ✅ Одоо дахин асуултуудыг асууя." гэж хариулж, "Эхний асуулт"-аас үргэлжлүүл.`
      : `━━━━━━━━━━━━━━━━━━━━━━━━━
ДАХИН ЭХЛҮҮЛЭХ — БАТАЛГААЖУУЛАЛТ ШААРДЛАГАТАЙ
━━━━━━━━━━━━━━━━━━━━━━━━━
Хэрэглэгч "эхнээс эхлүүлэх", "дахин тохируулах", "бүгдийг устгаад шинээр эхэл" гэх мэт хүсэлт гаргавал clear_knowledge-г ШУУД бүү дуудаарай — эхлээд заавал баталгаажуулах асуулт асууж, тодорхой "Тийм" хариулт авсны дараа л дуудна.

Одоогийн мэдлэгийн санд ${existingKB.length} зүйл байна. Энэ нь анхны 8 асуултаас гадна гар аргаар нэмэгдсэн чухал зүйлс агуулж байж магадгүй тул баталгаажуулалт ОНЦГОЙ чухал.

Яг дараах байдлаар асуу:
"⚠️ Танай мэдлэгийн санд одоогоор ${existingKB.length} зүйл байгаа. Үүнийг бүгдийг нь устгаад эхнээс тохируулахад итгэлтэй байна уу?
— Тийм гэвэл бүх мэдлэгийн сан устаж, шинээр тохиргоо эхэлнэ
— Үгүй гэвэл одоогийн тохиргоо хэвээр хадгалагдана"

→ Хэрэглэгч "Тийм", "за", "тийм ээ", "устга", "эхэл" гэх мэт ИЛТ ЗӨВШӨӨРСӨН хариулт өгсний ДАРАА Л clear_knowledge функцийг дуудна.
→ "Үгүй", "болих", "хэрэггүй", "болио" гэвэл clear_knowledge ТАСРАЛТГҮЙ ДУУДАХГҮЙ — "Ойлголоо, тохиргоо хэвээрээ үлдлээ 👍" гэж хариулаад ямар ч өөрчлөлт хийхгүйгээр хэвийн харилцаагаа үргэлжлүүл.`;

    const BUILDER_SYSTEM = `Чи Монголын бизнес эздэд AI chatbot тохируулахад туслах мэргэжилтэн.
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

3️⃣ БҮТЭЭГДЭХҮҮН / ҮЙЛЧИЛГЭЭ
"Хамгийн их зарагддаг бүтээгдэхүүн эсвэл үйлчилгээнийхээ нэр, үнэ, онцлогийг хэлнэ үү?
Нийтлэг жишээ: "Студи цэвэрлэгээ — 45,000₮, 2-3 цаг. 1 өрөө байр цэвэрлэнэ. Химийн бодис хэрэглэхгүй.""

4️⃣ БАЙНГА АСУУДАГ АСУУЛТУУД (FAQ)
"Хэрэглэгчид хамгийн ихэвчлэн ямар асуулт тавьдаг вэ? 3-5 асуулт хариулттай нь бичнэ үү.
Нийтлэг жишээ: "Хүргэлт хэдэн хоногт ирдэг? — УБ-т 1-2 хоног. / Баталгаат хугацаа хэд вэ? — 1 жил. / Хэмжээ буруу бол солидог уу? — Тийм, 7 хоногийн дотор авчирвал солино.""

5️⃣ АЖЛЫН ЦАГ + ХҮРГЭЛТ
"Ажлын цаг болон үйлчилгээний хамрах хүрээг хэлнэ үү?
Нийтлэг жишээ: "Да-Ба 9:00-20:00, Ня 10:00-18:00. Зөвхөн УБ хот. Захиалгаас 24 цагийн дотор очино.""

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

3️⃣ ТУСЛАМЖ ҮЙЛЧИЛГЭЭ + ҮНЭ
"Үндсэн тусламж үйлчилгээнүүдээ нэр, үнэ, агуулгын хамт хэлнэ үү?
Жишээ: "Шүд цэвэрлэлт — 80,000₮, 30 минут / Шүд авах — 100,000₮-аас / Гажиг засал (брекет) — 1,500,000₮-аас, 12-24 сар.""

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

3️⃣ ҮЙЛЧИЛГЭЭ + ҮНЭ
"Гол үйлчилгээнүүдээ нэр, үнэ, үргэлжлэх хугацааны хамт хэлнэ үү?
Жишээ: "Үс засалт — 35,000₮, 40 минут / Будалт — 120,000₮-аас, 2-3 цаг / Маникюр+гель — 45,000₮, 1 цаг.""

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
МЭДЭЭЛЭЛ ЦУГЛУУЛАХ ЗАРЧИМ
━━━━━━━━━━━━━━━━━━━━━━━━━
— Клиент нэгэн зэрэг олон зүйл өгч болно — бүгдийг хүлээн ав, давтан асуухгүй
— "Мэдэхгүй", "байхгүй" гэвэл алгасаж дараагийнхыг асуу
— ТАНИХ асуулт болон 1️⃣-3️⃣ дуусвал tool дуудаж болно (4️⃣-7️⃣ заавал биш)
— Төлбөрийн хэлбэр АСУУХГҮЙ

━━━━━━━━━━━━━━━━━━━━━━━━━
TOOL ДУУДАХ
━━━━━━━━━━━━━━━━━━━━━━━━━
Мэдээлэл хангалттай болмогц ЗЭРЭГ дуудна:
→ save_knowledge_items — цуглуулсан мэдээллээс Q&A хосуудыг гаргаж KB-д хадгалах
→ save_business_profile — бүх профайл (system prompt + KB автоматаар үүснэ)

AI нэр: өгөөгүй бол компани нэрнээс үүсгэ ("Номин" → "Номин туслах")

━━━━━━━━━━━━━━━━━━━━━━━━━
ДУУСГАХ
━━━━━━━━━━━━━━━━━━━━━━━━━
Хадгалсны дараа яг ийм хариул:
"✅ Таны AI chatbot бэлэн боллоо!

🤖 [aiName] — [company]-ийн AI зөвлөх
📚 Мэдлэгийн санд [тоо] зүйл нэмэгдлээ

'AI Чат' хэсэгт орж туршиж үзнэ үү 🚀"

${RESTART_BLOCK}`;

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
    ];

    const messages = [
      { role: "system", content: BUILDER_SYSTEM },
      ...history.slice(-20),
      { role: "user", content: message.trim() },
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools: BUILDER_TOOLS,
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 1024,
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
        const args = JSON.parse(toolCall.function.arguments);

        if (toolCall.function.name === "save_knowledge_items") {
          let created = 0, merged = 0;
          // Шинэ save бүрт existingKB-г refresh хийнэ
          const currentKB = await prisma.turuuKnowledge.findMany({
            where: { orgId }, select: { id: true, question: true, answer: true },
          });

          for (const item of args.items) {
            // Ижил утгатай KB хайна (60%+ word overlap)
            let bestMatch = null;
            let bestScore = 0;
            for (const kb of currentKB) {
              const score = kbSimilarity(item.question, kb.question);
              if (score > bestScore) { bestScore = score; bestMatch = kb; }
            }

            if (bestMatch && bestScore >= 0.6) {
              // Байгаа KB-тэй нэгтгэнэ
              const mergedAnswer = mergeAnswers(bestMatch.answer, item.answer);
              await prisma.turuuKnowledge.update({
                where: { id: bestMatch.id },
                data: { answer: mergedAnswer },
              });
              // currentKB-д шинэчилнэ (дараагийн item-д нөлөөлнө)
              bestMatch.answer = mergedAnswer;
              merged++;
            } else {
              // Шинэ KB үүсгэнэ
              const newItem = await prisma.turuuKnowledge.create({
                data: { orgId, question: item.question, answer: item.answer, category: item.category || null },
              });
              currentKB.push({ id: newItem.id, question: item.question, answer: item.answer });
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
          await prisma.turuuKnowledge.deleteMany({ where: { orgId } });
          cleared = true;
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ ok: true }) });
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

    res.json({ totalConversations, totalLeads, totalConsultations, totalOrders, newLeads, dailyMessages, dailyLeads });
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
    const paid = (result.count != null ? result.count > 0 : false) || result.payment_status === "PAID";

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
    const { message, history = [] } = req.body;
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

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-20),
      { role: "user", content: message.trim() },
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

    if (choice.finish_reason === "tool_calls") {
      const toolResults = [];
      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.function.name === "search_knowledge") {
          const { query } = JSON.parse(toolCall.function.arguments);
          const items = await prisma.turuuKnowledge.findMany({
            where: { orgId, active: true },
            select: { question: true, answer: true },
          });
          let result = "Мэдлэгийн санд тохирох мэдээлэл олдсонгүй.";
          if (items.length > 0) {
            const qWords = normKB(query).split(" ").filter((w) => w.length > 1);
            const scored = items
              .map((item) => ({
                item,
                score: qWords.filter((w) => normKB(`${item.question} ${item.answer}`).includes(w)).length,
              }))
              .filter((s) => s.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5);
            if (scored.length > 0) {
              result = scored.map((s) => `А: ${s.item.question}\nХ: ${s.item.answer}`).join("\n\n");
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

    res.json({ reply });
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
    const org = await prisma.organization.findUnique({
      where: { id: req.org.orgId },
      select: { id: true, name: true, slug: true, email: true, plan: true, status: true, logoUrl: true, fbPageId: true, fbPageToken: true, telegramBotToken: true, telegramChatId: true, createdAt: true },
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

// POST /client/upload/pdf — PDF-аас Q&A автоматаар гаргаж KB-д нэмнэ
router.post("/upload/pdf", pdfUpload.single("file"), async (req, res) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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

    // count > 0 эсвэл payment_status === "PAID" бол төлсөн
    const paid = (result.count != null ? result.count > 0 : false) || result.payment_status === "PAID";

    if (paid && order.qpayStatus !== "PAID") {
      await prisma.turuuOrder.update({
        where: { id: order.id },
        data: { qpayStatus: "PAID", status: "PAID" },
      });
    }

    res.json({ paid, qpayStatus: paid ? "PAID" : "PENDING", result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
