"use strict";
const { getPrisma } = require("./db");

const MAX_MESSAGES = 20;

async function getHistory(psid) {
  const prisma = getPrisma();
  const row = await prisma.turuuChat.findUnique({ where: { psid } });
  return row ? row.messages : [];
}

async function saveHistory(psid, messages) {
  const prisma = getPrisma();
  const trimmed = messages.slice(-MAX_MESSAGES);
  await prisma.turuuChat.upsert({
    where: { psid },
    create: { psid, messages: trimmed },
    update: { messages: trimmed },
  });
  return trimmed;
}

async function isNewConversation(psid) {
  const prisma = getPrisma();
  const row = await prisma.turuuChat.findUnique({ where: { psid } });
  return !row || !Array.isArray(row.messages) || row.messages.length === 0;
}

module.exports = { getHistory, saveHistory, isNewConversation };
