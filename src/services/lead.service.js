"use strict";
const { getPrisma } = require("../lib/db");
const axios = require("axios");

async function saveLead({ psid, orgId = null, name, phone, email, company, serviceInterest, budget, notes }) {
  const prisma = getPrisma();
  const lead = await prisma.turuuLead.create({
    data: { psid, orgId, name, phone, email, company, serviceInterest, budget, notes },
  });

  // Telegram мэдэгдэл — org-ийн token эсвэл глобал token ашиглана
  const { botToken, chatId } = await getTelegramConfig(orgId);
  await notifyTelegram("💼 Шинэ Lead", { name, phone, email, company, serviceInterest, budget, notes }, botToken, chatId);
  return lead;
}

async function saveConsultation({ psid, orgId = null, name, phone, email, serviceInterest, preferredTime }) {
  const prisma = getPrisma();
  const c = await prisma.turuuConsultation.create({
    data: { psid, orgId, name, phone, email, serviceInterest, preferredTime },
  });

  const { botToken, chatId } = await getTelegramConfig(orgId);
  await notifyTelegram("📅 Consultation захиалга", { name, phone, email, serviceInterest, preferredTime }, botToken, chatId);
  return c;
}

async function getTelegramConfig(orgId) {
  try {
    if (orgId) {
      const prisma = getPrisma();
      const org = await prisma.organization.findUnique({ where: { id: orgId } });
      if (org?.telegramBotToken && org?.telegramChatId) {
        return { botToken: org.telegramBotToken, chatId: org.telegramChatId };
      }
    }
  } catch { /* fallback */ }
  return { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID };
}

async function notifyTelegram(title, data, botToken, chatId) {
  if (!botToken || !chatId) return;
  const lines = Object.entries(data).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
  const text = `${title}\n━━━━━━━━━━━━\n${lines}`;
  await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text })
    .catch((err) => console.error("[TG] notify error:", err.message));
}

async function saveOrder({ psid, orgId = null, customerName, customerPhone, customerEmail, deliveryAddress, items, totalAmount, notes }) {
  const prisma = getPrisma();

  // Idempotency: AI ижил захиалгад save_order-ыг давтан дуудвал (жишээ нь "дансаар төлье" гэсний дараа)
  // сүүлийн 30 минутад ижил psid+totalAmount-тай NEW захиалга байгаа бол давтахгүй
  if (psid) {
    const recent = await prisma.turuuOrder.findFirst({
      where: {
        psid, orgId, status: "NEW", totalAmount,
        createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (recent) return { ...recent, duplicate: true };
  }

  const order = await prisma.turuuOrder.create({
    data: { psid, orgId, customerName, customerPhone, customerEmail, deliveryAddress, items, totalAmount, notes },
  });

  const { botToken, chatId } = await getTelegramConfig(orgId);
  const itemsSummary = Array.isArray(items) ? items.map((i) => {
    const variant = [i.color, i.size].filter(Boolean).join(" / ");
    return `${i.name}${variant ? ` (${variant})` : ""} x${i.qty} — ₮${(i.price * i.qty).toLocaleString()}`;
  }).join("\n") : "";
  await notifyTelegram("🛒 Шинэ захиалга", { customerName, customerPhone, deliveryAddress, items: itemsSummary, totalAmount: `₮${totalAmount?.toLocaleString()}`, notes }, botToken, chatId);
  return order;
}

module.exports = { saveLead, saveConsultation, saveOrder };
