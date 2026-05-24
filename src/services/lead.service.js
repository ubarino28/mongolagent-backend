"use strict";
const { getPrisma } = require("../lib/db");
const axios = require("axios");

async function saveLead({ psid, name, phone, email, company, serviceInterest, budget, notes }) {
  const prisma = getPrisma();
  const lead = await prisma.turuuLead.create({
    data: { psid, name, phone, email, company, serviceInterest, budget, notes },
  });
  await notifyTelegram("💼 Шинэ Lead", { name, phone, email, company, serviceInterest, budget, notes });
  return lead;
}

async function saveConsultation({ psid, name, phone, email, serviceInterest, preferredTime }) {
  const prisma = getPrisma();
  const c = await prisma.turuuConsultation.create({
    data: { psid, name, phone, email, serviceInterest, preferredTime },
  });
  await notifyTelegram("📅 Consultation захиалга", { name, phone, email, serviceInterest, preferredTime });
  return c;
}

async function notifyTelegram(title, data) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const lines = Object.entries(data)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const text = `${title}\n━━━━━━━━━━━━\n${lines}`;
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
  }).catch(err => console.error("[TG] notify error:", err.message));
}

module.exports = { saveLead, saveConsultation };
