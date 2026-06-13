"use strict";
const { getPrisma } = require("./db");

const MAX_MESSAGES = 40; // ~20 харилцан яриа (нэг захиалгад хангалттай)
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000; // 6 цаг идэвхгүй бол хуучин түүхийг мартаж шинэ яриа гэж үзнэ

function isStale(row) {
  return !row || Date.now() - new Date(row.updatedAt).getTime() > HISTORY_TTL_MS;
}

async function getHistory(psid, orgId = null) {
  const prisma = getPrisma();
  const row = await prisma.turuuChat.findFirst({ where: { psid, orgId } });
  if (!row || isStale(row)) return [];
  return row.messages;
}

async function saveHistory(psid, messages, orgId = null) {
  const prisma = getPrisma();
  const trimmed = messages.slice(-MAX_MESSAGES);
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
