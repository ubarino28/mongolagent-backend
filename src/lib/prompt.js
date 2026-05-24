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

async function buildSystemPrompt(isNew, orgId = null) {
  let customBody = null;
  let knowledgeItems = [];

  try {
    const prisma = getPrisma();
    const [customRow, knowledge] = await Promise.all([
      prisma.turuuSettings.findFirst({ where: { orgId, key: "system_prompt" } }),
      prisma.turuuKnowledge.findMany({ where: { orgId, active: true }, orderBy: { createdAt: "asc" } }),
    ]);
    customBody = customRow?.value || null;
    knowledgeItems = knowledge;
  } catch {
    // DB unavailable — use defaults
  }

  const newConvLine = isNew
    ? `ШИНЭ ЯРИА: Товч мэндэл ("Сайн байна уу? 😊"), дараа нь хэрэглэгчийн мессежийн агуулгад ШУУД хариул.\nЗөвхөн цэвэр мэндлэл ("сайн уу", "hi") ирвэл "Танд юугаар туслах вэ?" гэж асуу.`
    : `ҮРГЭЛЖИЛЖ БУЙ ЯРИА: Яриагаа үргэлжлүүл. "Сайн байна уу?" давтахгүй.`;

  const body = customBody || getDefaultBody();

  let knowledge = "";
  if (knowledgeItems.length > 0) {
    knowledge = "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\nМЭДЛЭГИЙН САН\n━━━━━━━━━━━━━━━━━━━━━━━━━\n";
    knowledgeItems.forEach((k) => {
      knowledge += `Асуулт: ${k.question}\nХариулт: ${k.answer}\n`;
    });
  }

  return `${body}\n\n${newConvLine}${knowledge}`;
}

module.exports = { buildSystemPrompt };
