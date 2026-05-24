"use strict";
const { getPrisma } = require("./db");

const MAX_MESSAGES = 20;

async function getHistory(psid, orgId = null) {
  const prisma = getPrisma();
  const row = await prisma.turuuChat.findFirst({ where: { psid, orgId } });
  return row ? row.messages : [];
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
  return !row || !Array.isArray(row.messages) || row.messages.length === 0;
}

module.exports = { getHistory, saveHistory, isNewConversation };
