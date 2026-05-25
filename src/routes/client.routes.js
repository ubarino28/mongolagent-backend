"use strict";
const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
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

// POST /client/settings/builder — Builder AI: бизнесийн мэдээллээс мэдлэгийн сан үүсгэнэ
router.post("/settings/builder", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message шаардлагатай" });

    const orgId = req.org.orgId;
    const prisma = getPrisma();
    const OpenAI = require("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const BUILDER_SYSTEM = `Чи Монголын бизнес эздэд AI chatbot тохируулахад туслах мэргэжилтэн.
Зорилго: бизнесийн бүрэн дүр төрхийг ойлгож, НАРИЙН, ХУВИЙН AI persona үүсгэх.

━━━━━━━━━━━━━━━━━━━━━━━━━
ЭХЛЭХ (__INIT__)
━━━━━━━━━━━━━━━━━━━━━━━━━
Яг ийм хариул:
"Сайн байна уу! 😊 Би таны AI chatbot-ыг мэргэжлийн түвшинд тохируулахад туслах болно.

5 үе шаттайгаар мэдээлэл цуглуулна:
1️⃣ Компанийн онцлог, зорилтот үйлчлүүлэгч
2️⃣ Бүтээгдэхүүн/үйлчилгээний дэлгэрэнгүй
3️⃣ Үйлчилгээний процесс, цаг хуваарь
4️⃣ AI-ийн зан чанар, харилцааны хэв маяг
5️⃣ Амжилтын жишээ (заавал биш)

**Эхлэхийн тулд:** Компанийнхаа нэр болон юу хийдгийг товч хэлнэ үү?"

━━━━━━━━━━━━━━━━━━━━━━━━━
ҮЕ ШАТ 1 — КОМПАНИЙН ДНА
━━━━━━━━━━━━━━━━━━━━━━━━━
Мэдэж авах (1-2 асуулт):
— Компанийн нэр, юу хийдэг, хэзээ үүссэн
— Голлох хэрэглэгч: нас, хэрэгцээ, байршил
— Өрсөлдөгчдөөс юугаараа ялгардаг

Асуух жишээ: "Танай гол хэрэглэгчид хэн бэ — нас, хэрэгцээ? Бусдаас юугаараа ялгардаг вэ?"

━━━━━━━━━━━━━━━━━━━━━━━━━
ҮЕ ШАТ 2 — БҮТЭЭГДЭХҮҮН/ҮЙЛЧИЛГЭЭ
━━━━━━━━━━━━━━━━━━━━━━━━━
Мэдэж авах:
— Нэр, үнэ, хэнд зориулагдсан
— Гол 2-3 онцлог, давуу тал
— Хэрэглэгчид хамгийн ихэвчлэн тавьдаг 3-5 асуулт
— Яагаад авахаас татгалздаг → та тэд рүү юу хэлдэг?

Асуух жишээ:
"Хамгийн их зарагддаг бүтээгдэхүүнээсээ эхлэе. Нэр, үнэ, хэнд зориулагдсан болохыг хэлнэ үү?"
"Хэрэглэгч 'үнэтэй байна', 'бодоод үзье' гэвэл та ямар хариулт өгдөг вэ?"

━━━━━━━━━━━━━━━━━━━━━━━━━
ҮЕ ШАТ 3 — ПРОЦЕСС
━━━━━━━━━━━━━━━━━━━━━━━━━
— Захиалгаас хүргэлт хүртэл хугацаа, процесс
— Буцаалт, гомдолд хандах байдал
— Ажлын цаг, байршил, хүргэлтийн нөхцөл

━━━━━━━━━━━━━━━━━━━━━━━━━
ҮЕ ШАТ 4 — ЗАН ЧАНАР
━━━━━━━━━━━━━━━━━━━━━━━━━
— "Та" эсвэл "чи" хэлэх
— Emoji ашиглах уу
— Хориглох сэдэв, forbidden topics
— Нэмэлт онцгой дүрэм (жишээ: "хямдрал өгөхгүй", "зөвхөн UB хүргэнэ")

━━━━━━━━━━━━━━━━━━━━━━━━━
ҮЕ ШАТ 5 — ҮР ДҮН (заавал биш)
━━━━━━━━━━━━━━━━━━━━━━━━━
— "Манай нэг клиент..." хэлбэрт амжилтын жишээ
— Тоон үр дүн, гэрчлэл

━━━━━━━━━━━━━━━━━━━━━━━━━
МЭДЭЭЛЭЛ ЦУГЛУУЛАХ ЗАРЧИМ
━━━━━━━━━━━━━━━━━━━━━━━━━
— Клиент нэгэн зэрэг олон зүйл өгч болно — бүгдийг хүлээн ав
— Авсан зүйлийг ДАВТАН АСУУХГҮЙ
— Байхгүй/мэдэхгүй зүйлийг шаардахгүй — алгасна
— Min шаардлага: Үе шат 1 + Үе шат 2 дуусвал tool дуудаж болно
— Төлбөрийн хэлбэр АСУУХГҮЙ

━━━━━━━━━━━━━━━━━━━━━━━━━
TOOL ДУУДАХ
━━━━━━━━━━━━━━━━━━━━━━━━━
Мэдээлэл хангалттай болмогц ЗЭРЭГ дуудна:
→ save_knowledge_items: Q&A хэлбэрт, category-тай
→ save_business_profile: бүх профайл (narrative prompt үүснэ)

AI нэр: өгөөгүй бол компани нэрнээс үүсгэ ("Номин" → "Номин туслах")

━━━━━━━━━━━━━━━━━━━━━━━━━
ДУУСГАХ
━━━━━━━━━━━━━━━━━━━━━━━━━
Хадгалсны дараа яг ийм хариул:
"✅ Таны AI chatbot бэлэн боллоо!

🤖 [aiName] — [company]-ийн AI зөвлөх
📚 Мэдлэгийн санд [тоо] зүйл нэмэгдлээ

'AI Чат' хэсэгт орж туршиж үзнэ үү 🚀"

Дахин эхлүүлэхийг хүсвэл clear_knowledge дуудна.`;

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
                  taOrChi:  { type: "string", enum: ["та", "чи"] },
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
          for (const item of args.items) {
            await prisma.turuuKnowledge.create({
              data: { orgId, question: item.question, answer: item.answer, category: item.category || null },
            });
          }
          savedItems += args.items.length;
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ saved: args.items.length }) });
        }

        if (toolCall.function.name === "save_business_profile") {
          const { buildNarrativePrompt } = require("../lib/prompt");
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
          promptUpdated = true;
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ ok: true, aiName: autoAiName, company: args.company }) });
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

const PLAN_QUOTA = { starter: 10000, business: 15000, growth: 15000, enterprise: 17000 };

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
      select: { plan: true, messageUsed: true, quotaResetAt: true, createdAt: true },
    });
    const quota = PLAN_QUOTA[org.plan] || 10000;
    const PLANS = {
      starter:    { name: "Starter",    price: 79900,  quota: 10000, features: ["10,000 мессеж/сар", "AI Chatbot", "Мэдлэгийн сан", "Тайлан"] },
      growth:     { name: "Growth",     price: 149900, quota: 15000, features: ["15,000 мессеж/сар", "QPay төлбөр", "Цаг захиалга", "Telegram мэдэгдэл"] },
      enterprise: { name: "Enterprise", price: 399000, quota: 17000, features: ["17,000 мессеж/сар", "Website хөгжүүлэлт", "Custom AI", "SLA баталгаа"] },
    };
    res.json({ ...org, quota, messageUsed: org.messageUsed || 0, plans: PLANS, currentPlan: PLANS[org.plan] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /client/billing/upgrade
router.post("/billing/upgrade", async (req, res) => {
  try {
    const { targetPlan } = req.body;
    const UPGRADE_ORDER = ["starter", "growth", "enterprise"];
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId }, select: { plan: true, email: true, name: true } });
    if (UPGRADE_ORDER.indexOf(targetPlan) <= UPGRADE_ORDER.indexOf(org.plan)) {
      return res.status(400).json({ error: "Зөвхөн дээш ахиулах боломжтой" });
    }
    // TODO: QPay integration — одоогоор хүсэлт бүртгэж имэйл явуулна
    res.json({ ok: true, message: "Upgrade хүсэлт хүлээн авлаа. Манай баг тантай холбогдоно." });
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

    const response = await openai.chat.completions.create({
      model: aiSettings.model,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.slice(-20),
        { role: "user", content: message.trim() },
      ],
      temperature: aiSettings.temperature,
      max_tokens: aiSettings.max_tokens,
    });

    const reply = response.choices[0].message.content?.trim() || "";
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

module.exports = router;
