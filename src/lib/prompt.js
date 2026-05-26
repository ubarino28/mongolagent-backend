"use strict";
const { getPrisma } = require("./db");

// ─── DEFAULT (Türüü AI өөрийн chatbot) ───────────────────────────────────────

function getDefaultBody() {
  return `Чи Түрүү AI компанийн туслах Аги.
Монголын бизнесүүдэд AI шийдэл нэвтрүүлэхэд тусалдаг мэргэжлийн, найрсаг туслах.

━━━━━━━━━━━━━━━━━━━━━━━━━
КОМПАНИ
━━━━━━━━━━━━━━━━━━━━━━━━━
Нэр: Түрүү AI
Чиглэл: AI автоматжуулалт, chatbot хөгжүүлэлт, сургалт, зөвлөгөө
Зорилт: Монголын бизнесүүдийг AI-аар хүчирхэгжүүлэх

━━━━━━━━━━━━━━━━━━━━━━━━━
ҮЙЛЧИЛГЭЭ БА ҮНЭ
━━━━━━━━━━━━━━━━━━━━━━━━━
1. 🤖 AI CHATBOT — Starter 500,000₮+100,000₮/сар · Business 1,000,000₮+150,000₮/сар · Premium 2,000,000₮+
2. ⚙️ БИЗНЕС АВТОМАТЖУУЛАЛТ — 800,000₮–2,000,000₮
3. 📚 AI СУРГАЛТ — 500,000₮/бүлэг (хагас өдөр) · 250,000₮/хүн (онлайн)
4. 🎯 AI ЗӨВЛӨГӨӨ — 150,000₮/цаг · 500,000₮/сар retainer

━━━━━━━━━━━━━━━━━━━━━━━━━
ЯРИА УДИРДАХ ЗАРЧИМ
━━━━━━━━━━━━━━━━━━━━━━━━━
— Хэрэглэгчийн хэрэгцээг ойлгоод тохирох үйлчилгээ санал болго
— Үйлчилгээ, үнэ мэдээлэл асуухад ЗААВАЛ search_knowledge дуудна — таамаглахгүй
— Холбоо барих мэдээлэл (нэр, утас) авахад save_lead дуудна
— Consultation хүсвэл save_consultation дуудна
— Монгол хэлээр хариул, богино тодорхой байлга
— Нэг мессежид нэг л асуулт`;
}

// ─── НАРИЙН NARRATIVE PROMPT (Builder AI-ийн үүсгэсэн) ──────────────────────

function buildNarrativePrompt(profile) {
  const {
    company, aiName, contact,
    description, targetCustomers, differentiators,
    productDetails, orderProcess, returnPolicy, workingHours,
    tone, caseStudy, forbiddenTopics, extraRules,
  } = profile;

  const taChi = tone?.taOrChi || "та";
  const emojiOk = tone?.useEmoji !== false;
  const emojiRule = emojiOk ? "Emoji умаар хэрэглэж болно 😊" : "Emoji ашиглахгүй — ёсчлол, мэргэжлийн хэв маяг баримтал.";
  const contactFallback = contact
    ? `"${contact}-д холбогдоно уу"`
    : `"Менежер тантай удахгүй холбогдно — утасны дугаараа үлдээнэ үү?"`;

  let p = `Чи ${company}-ийн AI зөвлөх ${aiName}.
${taChi === "чи" ? "Хэрэглэгчтэй 'чи' хэлж харилц — дотно, найрсаг." : "Хэрэглэгчтэй 'та' хэлж харилц — мэргэжлийн, найрсаг."} ${emojiRule}`;

  // Компанийн ДНА
  if (description || targetCustomers || differentiators) {
    p += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\nКОМПАНИ ТУХАЙ\n━━━━━━━━━━━━━━━━━━━━━━━━━`;
    if (description) p += `\n${description}`;
    if (targetCustomers) p += `\nМанай гол хэрэглэгчид: ${targetCustomers}.`;
    if (differentiators) p += `\nБид ялгардаг зүйл: ${differentiators}.`;
  }

  // Бүтээгдэхүүн матриц
  if (productDetails?.length > 0) {
    p += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\nБҮТЭЭГДЭХҮҮН / ҮЙЛЧИЛГЭЭ\n━━━━━━━━━━━━━━━━━━━━━━━━━`;
    for (const prod of productDetails) {
      p += `\n\n📦 ${prod.name}${prod.price ? ` — ${prod.price}₮` : ""}`;
      if (prod.targetUser) p += `\n   Хэнд: ${prod.targetUser}`;
      if (prod.features) p += `\n   Онцлог: ${prod.features}`;
      if (prod.objection && prod.objectionResponse) {
        p += `\n   "${prod.objection}" гэвэл → "${prod.objectionResponse}"`;
      }
    }
  }

  // Процесс
  if (orderProcess || workingHours || returnPolicy) {
    p += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\nҮЙЛЧИЛГЭЭНИЙ МЭДЭЭЛЭЛ\n━━━━━━━━━━━━━━━━━━━━━━━━━`;
    if (orderProcess) p += `\n${orderProcess}`;
    if (workingHours) p += `\nАжлын цаг: ${workingHours}`;
    if (returnPolicy) p += `\nБуцаалт/гомдол: ${returnPolicy}`;
  }

  // Захиалгын стандарт урсгал
  p += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\nЗАХИАЛГЫН ПРОЦЕСС\n━━━━━━━━━━━━━━━━━━━━━━━━━
Захиалга хийхэд дараалал:
1. Бүтээгдэхүүн → тоо ширхэг → нийт дүн тооцоол
2. Хаяг, нэр, утас ав
3. БАТАЛГААЖУУЛ — "Захиалгаа баталгаажуулна уу:\\n📦 [жагсаалт]\\n💰 Нийт: [дүн]₮\\n📍 [хаяг]\\nЗөв үү?"
4. Зөвшөөрвөл save_order дуудна → "Захиалга хүлээн авлаа! QPay холбоос удахгүй ирнэ 🧾"
— ТӨЛБӨРИЙН ХЭЛБЭР асуухгүй — QPay-аар автоматаар шийднэ`;

  // Амжилтын жишээ
  if (caseStudy) {
    p += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\nАМЖИЛТЫН ЖИШЭЭ\n━━━━━━━━━━━━━━━━━━━━━━━━━\n${caseStudy}`;
  }

  // Харилцааны дүрэм
  p += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\nХАРИЛЦААНЫ ДҮРЭМ\n━━━━━━━━━━━━━━━━━━━━━━━━━
— Мэндлэлийг хариулттай нэгэн зэрэг нэг мессежид бич
— Нэг мессежид нэг л асуулт
— Бүтээгдэхүүн, үнэ, хүргэлт, буцаалт мэдээлэл асуухад ЗААВАЛ search_knowledge дуудна — таамаглахгүй
— search_knowledge "олдсонгүй" буцаавал ЭХЛЭЭД flag_unanswered дуудна, дараа нь: ${contactFallback}
— Хэрэглэгч хүнтэй ярихыг хүсвэл request_handoff дуудна
— Холбогдох бүтээгдэхүүн байвал нэг л удаа санал болго
— Өрсөлдөгч компани дурдахгүй
— Чиглэлтэй огт холбоогүй асуултад: "Энэ асуулт манай чиглэлд хамаарахгүй байна 😊"`;

  if (forbiddenTopics) p += `\n— Хориглосон сэдэв: ${forbiddenTopics}`;

  if (extraRules) {
    p += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\nНЭМЭЛТ ДҮРЭМ\n━━━━━━━━━━━━━━━━━━━━━━━━━\n${extraRules}`;
  }

  return p;
}

// ─── ХУУЧИН CORE TEMPLATE (backwards compat) ─────────────────────────────────

function buildCoreTemplate({ company, aiName, contact, extraRules }) {
  const contactFallback = contact
    ? `"${contact}-д холбогдоно уу"`
    : `"Менежер тантай удахгүй холбогдно — утасны дугаараа үлдээнэ үү?"`;

  return `Чи ${company}-ийн AI туслах ${aiName}.
Монгол хэлээр найрсаг, товч тодорхой хариулна.

━━━━━━━━━━━━━━━━━━━━━━━━━
МЭНДЛЭХ ДҮРЭМ
━━━━━━━━━━━━━━━━━━━━━━━━━
— Мэндлэлийг хариулттай НЭГЭН ЗЭРЭГ нэг мессежид бич
— Давтан мэндлэхгүй

━━━━━━━━━━━━━━━━━━━━━━━━━
ЗАХИАЛГЫН ПРОЦЕСС
━━━━━━━━━━━━━━━━━━━━━━━━━
1. Бараа → тоо → нийт дүн → хаяг/нэр/утас
2. БАТАЛГААЖУУЛ → save_order → "QPay холбоос удахгүй 🧾"
— ТӨЛБӨР асуухгүй — QPay-аар шийднэ

━━━━━━━━━━━━━━━━━━━━━━━━━
ДҮРЭМ
━━━━━━━━━━━━━━━━━━━━━━━━━
— Бүтээгдэхүүн, үнэ, хүргэлт, буцаалт мэдээлэл асуухад ЗААВАЛ search_knowledge дуудна — таамаглахгүй
— Нэг мессежид нэг л асуулт
— Мэдэхгүй бол ЭХЛЭЭД flag_unanswered дуудна, дараа нь: ${contactFallback}
— Хэрэглэгч хүн хүсвэл request_handoff дуудна
— Өрсөлдөгч дурдахгүй${extraRules ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\nНЭМЭЛТ ДҮРЭМ\n━━━━━━━━━━━━━━━━━━━━━━━━━\n${extraRules}` : ""}`;
}

// ─── SYSTEM PROMPT BUILDER ────────────────────────────────────────────────────

async function buildSystemPrompt(isNew, orgId = null) {
  let bodyPrompt = null;

  try {
    const prisma = getPrisma();
    const settings = await prisma.turuuSettings.findMany({
      where: {
        orgId,
        key: { in: ["system_prompt", "ai_profile", "ai_company", "ai_name", "ai_contact", "ai_extra_rules"] },
      },
    });

    const s = {};
    settings.forEach((r) => { s[r.key] = r.value; });

    // Priority: ai_profile (narrative) → system_prompt (custom) → ai_company (old)
    if (s.ai_profile) {
      try {
        const profile = JSON.parse(s.ai_profile);
        bodyPrompt = buildNarrativePrompt(profile);
      } catch { /* fallback */ }
    }

    if (!bodyPrompt && s.system_prompt) {
      bodyPrompt = s.system_prompt;
    }

    if (!bodyPrompt && s.ai_company) {
      bodyPrompt = buildCoreTemplate({
        company:    s.ai_company,
        aiName:     s.ai_name || "AI туслах",
        contact:    s.ai_contact || "",
        extraRules: s.ai_extra_rules || "",
      });
    }
  } catch {
    // DB unavailable — defaults
  }

  const newConvLine = isNew
    ? `ШИНЭ ЯРИА: Мэндлэлийг хариулттай НЭГЭН ЗЭРЭГ нэг мессежид бич. Зөвхөн "сайн уу"/"hi" ирвэл "Сайн байна уу! 😊 Танд юугаар туслах вэ?" гэ.`
    : `ҮРГЭЛЖИЛЖ БУЙ ЯРИА: Яриагаа үргэлжлүүл. "Сайн байна уу?" давтахгүй.`;

  const body = bodyPrompt || getDefaultBody();

  return `${body}\n\n${newConvLine}`;
}

module.exports = { buildSystemPrompt, buildNarrativePrompt, buildCoreTemplate };
