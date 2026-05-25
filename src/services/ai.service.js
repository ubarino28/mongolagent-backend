"use strict";
const OpenAI = require("openai");
const { buildSystemPrompt } = require("../lib/prompt");
const { getHistory, saveHistory, isNewConversation } = require("../lib/history");
const { saveLead, saveConsultation, saveOrder } = require("./lead.service");
const { getPrisma } = require("../lib/db");

let openai;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "save_lead",
      description: "Хэрэглэгч үйлчилгээ сонирхоход нэр, холбоо барих мэдээлэл хадгална.",
      parameters: {
        type: "object",
        properties: {
          name:            { type: "string" },
          phone:           { type: "string" },
          email:           { type: "string" },
          company:         { type: "string" },
          serviceInterest: { type: "string" },
          budget:          { type: "string" },
          notes:           { type: "string" },
        },
        required: ["phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_consultation",
      description: "Хэрэглэгч consultation цаг захиалахыг хүсэхэд дуудна.",
      parameters: {
        type: "object",
        properties: {
          name:            { type: "string" },
          phone:           { type: "string" },
          email:           { type: "string" },
          serviceInterest: { type: "string" },
          preferredTime:   { type: "string" },
        },
        required: ["phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_order",
      description: "Хэрэглэгч захиалгаа баталгаажуулж нэр, утас, хүргэлтийн хаяг өгсний дараа дуудна. Захиалга DB-д хадгалж QPay холбоос илгээгдэх болно.",
      parameters: {
        type: "object",
        properties: {
          customerName:    { type: "string" },
          customerPhone:   { type: "string" },
          customerEmail:   { type: "string" },
          deliveryAddress: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name:  { type: "string" },
                qty:   { type: "number" },
                price: { type: "number" },
              },
              required: ["name", "qty", "price"],
            },
          },
          totalAmount: { type: "number" },
          notes:       { type: "string" },
        },
        required: ["customerPhone", "items", "totalAmount"],
      },
    },
  },
];

async function loadAISettings(orgId = null) {
  try {
    const prisma = getPrisma();
    const rows = await prisma.turuuSettings.findMany({
      where: { orgId, key: { in: ["ai_model", "ai_temperature", "ai_max_tokens"] } },
    });
    const s = {};
    rows.forEach((r) => { s[r.key] = r.value; });
    return {
      model: s.ai_model || "gpt-4o-mini",
      temperature: parseFloat(s.ai_temperature || "0.4"),
      max_tokens: parseInt(s.ai_max_tokens || "1024"),
    };
  } catch {
    return { model: "gpt-4o-mini", temperature: 0.4, max_tokens: 1024 };
  }
}

async function processMessage(psid, userText, orgId = null) {
  // Check if blocked
  try {
    const prisma = getPrisma();
    const chatRecord = await prisma.turuuChat.findFirst({ where: { psid, orgId } });
    if (chatRecord?.blocked) return null;
  } catch { /* proceed */ }

  const [isNew, history, aiSettings] = await Promise.all([
    isNewConversation(psid, orgId),
    getHistory(psid, orgId),
    loadAISettings(orgId),
  ]);

  const systemPrompt = await buildSystemPrompt(isNew, orgId);

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userText },
  ];

  const response = await getOpenAI().chat.completions.create({
    model: aiSettings.model,
    messages,
    tools: TOOLS,
    tool_choice: "auto",
    temperature: aiSettings.temperature,
    max_tokens: aiSettings.max_tokens,
  });

  const choice = response.choices[0];
  let replyText = "";

  if (choice.finish_reason === "tool_calls") {
    const toolCall = choice.message.tool_calls[0];
    const args = JSON.parse(toolCall.function.arguments);

    if (toolCall.function.name === "save_lead") {
      await saveLead({ psid, orgId, ...args });
      replyText = `Баярлалаа 😊 Таны мэдээллийг хүлээн авлаа. Манай мэргэжилтэн удахгүй тантай холбогдоно.`;
    } else if (toolCall.function.name === "save_consultation") {
      await saveConsultation({ psid, orgId, ...args });
      replyText = `Consultation захиалга амжилттай бүртгэгдлээ 😊 Бид тантай ${args.preferredTime ? args.preferredTime + " орчим" : "удахгүй"} холбогдоно.`;
    } else if (toolCall.function.name === "save_order") {
      await saveOrder({ psid, orgId, ...args });
      replyText = `Захиалга амжилттай бүртгэгдлээ! 🎉 QPay төлбөрийн холбоос удахгүй илгээнэ. Баярлалаа 😊`;
    }

    const followUp = await getOpenAI().chat.completions.create({
      model: aiSettings.model,
      messages: [
        ...messages,
        choice.message,
        { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ success: true }) },
      ],
      temperature: aiSettings.temperature,
      max_tokens: 512,
    });
    const followText = followUp.choices[0].message.content?.trim();
    if (followText && followText.length > 5) replyText = followText;

  } else {
    replyText = choice.message.content?.trim() || "";
  }

  await saveHistory(psid, [...history, { role: "user", content: userText }, { role: "assistant", content: replyText }], orgId);

  // Track message usage
  if (orgId) {
    try {
      const prisma = getPrisma();
      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { quotaResetAt: true } });
      const now = new Date();
      const needsReset = !org?.quotaResetAt || now >= new Date(org.quotaResetAt);
      if (needsReset) {
        const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        await prisma.organization.update({ where: { id: orgId }, data: { messageUsed: 1, quotaResetAt: nextReset } });
      } else {
        await prisma.organization.update({ where: { id: orgId }, data: { messageUsed: { increment: 1 } } });
      }
    } catch { /* non-blocking */ }
  }

  return replyText;
}

module.exports = { processMessage };
