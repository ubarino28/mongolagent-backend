"use strict";
// Telegram мэдэгдлийн НЭГ цэг — org-ийн bot token/chatId (байвал) эсвэл глобал env ашиглана.
// Webhook/AI кодын давхардсан Telegram блокуудыг энэ helper-ээр сольсон.
const axios = require("axios");
const { getPrisma } = require("../lib/db");
const { decrypt } = require("../lib/secretCrypto");

async function getTelegramConfig(orgId) {
  try {
    if (orgId) {
      const org = await getPrisma().organization.findUnique({
        where: { id: orgId },
        select: { telegramBotToken: true, telegramChatId: true },
      });
      // decrypt — ENCRYPTION_KEY-гүй эсвэл plaintext бол passthrough (зан өөрчлөгдөхгүй)
      const botToken = decrypt(org?.telegramBotToken);
      const chatId = decrypt(org?.telegramChatId);
      if (botToken && chatId) return { botToken, chatId };
    }
  } catch { /* fallback to env */ }
  return { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID };
}

// Бэлэн текстийг илгээнэ (org байвал org-ийн бот, эс бол платформын env бот).
async function notifyText(orgId, text) {
  const { botToken, chatId } = await getTelegramConfig(orgId);
  if (!botToken || !chatId) return;
  await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text })
    .catch((err) => console.error("[TG] notify error:", err.message));
}

module.exports = { getTelegramConfig, notifyText };
