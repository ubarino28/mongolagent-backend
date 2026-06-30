"use strict";
const { getPrisma } = require("./db");

const MAX_MESSAGES = 40; // ~20 харилцан яриа (нэг захиалгад хангалттай)
const MAX_HISTORY_TOKENS = 6000; // token-оор дээд хязгаар — урт яриа OpenAI зардлыг бялхуулахаас сэргийлнэ
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000; // 6 цаг идэвхгүй бол хуучин түүхийг мартаж шинэ яриа гэж үзнэ

function isStale(row) {
  return !row || Date.now() - new Date(row.updatedAt).getTime() > HISTORY_TTL_MS;
}

// Ойролцоо token тоо (≈ 4 тэмдэгт = 1 token)
function estTokens(m) { try { return Math.ceil(JSON.stringify(m).length / 4); } catch { return 50; } }

// Мессежийн тоо БА token-оор хязгаарлана — хамгийн сүүлийнхийг үлдээж эхнээс хасна
function capHistory(messages) {
  let arr = messages.slice(-MAX_MESSAGES);
  let total = arr.reduce((s, m) => s + estTokens(m), 0);
  while (arr.length > 2 && total > MAX_HISTORY_TOKENS) { total -= estTokens(arr[0]); arr = arr.slice(1); }
  return arr;
}

async function getHistory(psid, orgId = null) {
  const prisma = getPrisma();
  const row = await prisma.turuuChat.findFirst({ where: { psid, orgId } });
  if (!row || isStale(row)) return [];
  return row.messages;
}

async function saveHistory(psid, messages, orgId = null) {
  const prisma = getPrisma();
  const trimmed = capHistory(messages);
  await prisma.turuuChat.upsert({
    where: { orgId_psid: { orgId, psid } },
    create: { psid, orgId, messages: trimmed },
    update: { messages: trimmed },
  });
  return trimmed;
}

async function isNewConversation(psid, orgId = null) {
  const prisma = getPrisma();
  const row = await prisma.turuuChat.findFirst({ where: { psid, orgId } });
  return !row || !Array.isArray(row.messages) || row.messages.length === 0 || isStale(row);
}

module.exports = { getHistory, saveHistory, isNewConversation };
