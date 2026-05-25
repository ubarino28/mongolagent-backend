"use strict";
const { getPrisma } = require("./db");

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

1. 🤖 AI CHATBOT ХӨГЖҮҮЛЭЛТ
— Starter: 500,000₮ + 100,000₮/сар
— Business: 1,000,000₮ + 150,000₮/сар (захиалга, QPay)
— Premium: 2,000,000₮+ + 250,000₮/сар

2. ⚙️ БИЗНЕС АВТОМАТЖУУЛАЛТ
— Consultation: 150,000₮/цаг
— Хэрэгжүүлэлт: 800,000₮–2,000,000₮

3. 📚 AI СУРГАЛТ
— Хагас өдөр: 500,000₮/бүлэг
— Бүтэн өдөр: 800,000₮/бүлэг
— Онлайн курс: 250,000₮/хүн

4. 🎯 AI ЗӨВЛӨГӨӨ
— Нэг удаа: 150,000₮/цаг
— Сарын retainer: 500,000₮/сар

━━━━━━━━━━━━━━━━━━━━━━━━━
ЯРИА УДИРДАХ ЗАРЧИМ
━━━━━━━━━━━━━━━━━━━━━━━━━
— Хэрэглэгчийн хэрэгцээг ойлгоод тохирох үйлчилгээ санал болго
— Холбоо барих мэдээлэл (нэр, утас) аваад save_lead дуудна
— Consultation хүсвэл save_consultation дуудна
— Үнийг ЗААВАЛ хэлнэ — нуухгүй
— Монгол хэлээр хариул, богино тодорхой байлга
— Нэг мессежид нэг л асуулт`;
}

function buildCoreTemplate({ company, aiName, contact, extraRules }) {
  return `Чи ${company}-ийн AI туслах ${aiName} юм.
Монгол хэлээр найрсаг, товч тодорхой хариулна.

━━━━━━━━━━━━━━━━━━━━━━━━━
МЭНДЛЭХ ДҮРЭМ
━━━━━━━━━━━━━━━━━━━━━━━━━
— Шинэ яриа: "Сайн байна уу 😊" гэж мэндлэж хэрэглэгчийн мессежийн агуулгад ШУУД хариул
— Хэрэглэгч шууд асуулт эсвэл захиалга бичвэл мэндлэж тэр даруй хариул
— Давтан мэндлэхгүй

━━━━━━━━━━━━━━━━━━━━━━━━━
ЗАХИАЛГЫН ПРОЦЕСС
━━━━━━━━━━━━━━━━━━━━━━━━━
Хэрэглэгч захиалга өгөхийг хүсвэл дараах дарааллаар яв:
1. Бүтээгдэхүүний жагсаалт болон үнийг харуулна
2. Хэрэглэгч барааг сонгоход тоо ширхэгийг асуу
3. Нийт дүнг тооцоолж харуул
4. Хүргэлтийн хаяг, нэр, утас авна
5. "Захиалга хүлээн авлаа, QPay төлбөрийн холбоос удахгүй илгээнэ 🧾" гэж мэдэгдэж save_order дуудна

━━━━━━━━━━━━━━━━━━━━━━━━━
ХАРИУЛАХ ДҮРЭМ
━━━━━━━━━━━━━━━━━━━━━━━━━
— Мэдлэгийн санд байгаа мэдээлэлд ЗААВАЛ тулгуурла
— Нэг мессежид нэг л асуулт
— Товч, тодорхой — урт тайлбар бичихгүй
— Мэдэхгүй бол: "Менежертэй холбогдъё — ${contact || "манай менежертэй холбогдоно уу"}" гэ
— Үнийг нуухгүй, үргэлж хэлнэ${extraRules ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\nНЭМЭЛТ ДҮРЭМ\n━━━━━━━━━━━━━━━━━━━━━━━━━\n${extraRules}` : ""}`;
}

async function buildSystemPrompt(isNew, orgId = null) {
  let bodyPrompt = null;
  let knowledgeItems = [];

  try {
    const prisma = getPrisma();
    const [settings, knowledge] = await Promise.all([
      prisma.turuuSettings.findMany({
        where: { orgId, key: { in: ["system_prompt", "ai_company", "ai_name", "ai_contact", "ai_extra_rules"] } },
      }),
      prisma.turuuKnowledge.findMany({ where: { orgId, active: true }, orderBy: { createdAt: "asc" } }),
    ]);

    const s = {};
    settings.forEach((r) => { s[r.key] = r.value; });

    if (s.system_prompt) {
      bodyPrompt = s.system_prompt;
    } else if (s.ai_company) {
      bodyPrompt = buildCoreTemplate({
        company: s.ai_company,
        aiName: s.ai_name || "AI туслах",
        contact: s.ai_contact || "",
        extraRules: s.ai_extra_rules || "",
      });
    }

    knowledgeItems = knowledge;
  } catch {
    // DB unavailable — use defaults
  }

  const newConvLine = isNew
    ? `ШИНЭ ЯРИА: Товч мэндэл ("Сайн байна уу? 😊"), дараа нь хэрэглэгчийн мессежийн агуулгад ШУУД хариул.\nЗөвхөн цэвэр мэндлэл ("сайн уу", "hi") ирвэл "Танд юугаар туслах вэ?" гэж асуу.`
    : `ҮРГЭЛЖИЛЖ БУЙ ЯРИА: Яриагаа үргэлжлүүл. "Сайн байна уу?" давтахгүй.`;

  const body = bodyPrompt || getDefaultBody();

  let knowledgeSection = "";
  if (knowledgeItems.length > 0) {
    knowledgeSection = "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\nМЭДЛЭГИЙН САН\n━━━━━━━━━━━━━━━━━━━━━━━━━\n";
    knowledgeItems.forEach((k) => {
      knowledgeSection += `Асуулт: ${k.question}\nХариулт: ${k.answer}\n`;
    });
  }

  return `${body}\n\n${newConvLine}${knowledgeSection}`;
}

module.exports = { buildSystemPrompt, buildCoreTemplate };
