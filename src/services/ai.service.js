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

const PLAN_QUOTA = { starter: 10000, growth: 15000, business: 15000, enterprise: 17000 };
const PLAN_NEXT  = { starter: "Growth", growth: "Business", business: "Enterprise" };

// Текстийг normalize хийх (тэмдэгт арилгах, жижиглэх)
function normalizeText(s) {
  return s.toLowerCase().trim().replace(/[?!。？！.,;:]/g, "").replace(/\s+/g, " ").trim();
}

// KB-с яг таарах хариулт хайна — таарвал OpenAI дуудахгүй
async function findExactMatch(orgId, userText) {
  if (!orgId || !userText || userText.length < 3) return null;
  try {
    const prisma = getPrisma();
    const userNorm = normalizeText(userText);
    if (userNorm.length < 3) return null;

    const items = await prisma.turuuKnowledge.findMany({
      where: { orgId, active: true },
      select: { question: true, answer: true },
    });

    for (const item of items) {
      const qNorm = normalizeText(item.question);
      if (qNorm === userNorm) return item.answer;

      // Нэг нь нөгөөгөө агуулж, урт нь 80%+ таарах бол
      const longer = Math.max(qNorm.length, userNorm.length);
      const shorter = Math.min(qNorm.length, userNorm.length);
      if (shorter > 4 && shorter / longer > 0.8) {
        if (qNorm.includes(userNorm) || userNorm.includes(qNorm)) return item.answer;
      }
    }
  } catch { /* non-blocking */ }
  return null;
}

// Message тоолох — cache hit болон normal дуудлага хоёуланд ашиглана
async function incrementMessageUsed(orgId, prisma) {
  try {
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

// KB-с хайлт хийх — GPT query-г normalize хийсний дараа дуудна
async function searchKnowledge(orgId, query) {
  try {
    const prisma = getPrisma();
    const items = await prisma.turuuKnowledge.findMany({
      where: { orgId: orgId || undefined, active: true },
      select: { question: true, answer: true, category: true },
    });

    if (items.length === 0) return "Мэдлэгийн сан хоосон байна.";

    const qWords = normalizeText(query).split(" ").filter((w) => w.length > 1);

    const scored = items
      .map((item) => {
        const text = normalizeText(`${item.question} ${item.answer}`);
        const score = qWords.filter((w) => text.includes(w)).length;
        return { item, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (scored.length === 0) return "Мэдлэгийн санд тохирох мэдээлэл олдсонгүй.";

    return scored.map((s) => `А: ${s.item.question}\nХ: ${s.item.answer}`).join("\n\n");
  } catch {
    return "Мэдлэгийн санд хандахад алдаа гарлаа.";
  }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "Хэрэглэгчийн асуултад хамаарах мэдээллийг мэдлэгийн сангаас хайна. Бүтээгдэхүүн, үнэ, хүргэлт, буцаалт, ажлын цаг болон компанийн мэдээлэл авахад ашиглана.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Хайх үгс — монгол хэлээр, тодорхой" },
        },
        required: ["query"],
      },
    },
  },
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
      description: "Хэрэглэгч захиалгаа баталгаажуулж нэр, утас, хаяг өгсний дараа дуудна.",
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
  {
    type: "function",
    function: {
      name: "flag_unanswered",
      description: "Хэрэглэгчийн асуултад мэдлэгийн санд хариулт байхгүй бол энэ tool-ийг ЭХЛЭЭД дуудна, дараа нь contact fallback хариулт өг.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Хариулагдаагүй хэрэглэгчийн асуулт" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_handoff",
      description: "Хэрэглэгч хүнтэй ярихыг хүсвэл эсвэл AI шийдэж чадахгүй нөхцөл үүсвэл дуудна.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Handoff хүссэн шалтгаан" },
        },
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
      model:       s.ai_model       || "gpt-4o-mini",
      temperature: parseFloat(s.ai_temperature  || "0.4"),
      max_tokens:  parseInt(s.ai_max_tokens || "1024"),
    };
  } catch {
    return { model: "gpt-4o-mini", temperature: 0.4, max_tokens: 1024 };
  }
}

async function processMessage(psid, userText, orgId = null) {
  const prisma = getPrisma();

  // Block шалгах
  try {
    const chatRecord = await prisma.turuuChat.findFirst({ where: { psid, orgId } });
    if (chatRecord?.blocked) return null;
  } catch { /* proceed */ }

  // KB exact match cache — таарвал OpenAI дуудахгүй, хямд бөгөөд хурдан
  if (orgId) {
    const cached = await findExactMatch(orgId, userText);
    if (cached) {
      const hist = await getHistory(psid, orgId);
      await saveHistory(psid, [...hist, { role: "user", content: userText }, { role: "assistant", content: cached }], orgId);
      await incrementMessageUsed(orgId, prisma);
      return cached;
    }
  }

  const [isNew, history, aiSettings] = await Promise.all([
    isNewConversation(psid, orgId),
    getHistory(psid, orgId),
    loadAISettings(orgId),
  ]);

  let systemPrompt = await buildSystemPrompt(isNew, orgId);

  // Upsell hint — квот 80%+ бол нэмэх
  if (orgId) {
    try {
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { plan: true, messageUsed: true },
      });
      const quota = PLAN_QUOTA[org.plan] || 10000;
      const pct = Math.round(((org.messageUsed || 0) / quota) * 100);
      const nextPlan = PLAN_NEXT[org.plan];
      if (pct >= 80 && nextPlan) {
        systemPrompt += `\n\n[ДОТООД: Энэ org-ийн мессежийн эрх ${pct}% дүүрсэн. Байгалийн яриа дотор боломжтой үед ${nextPlan} план руу upgrade хийхийг зөөлнөөр санал болго.]`;
      }
    } catch { /* non-blocking */ }
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userText },
  ];

  const response = await getOpenAI().chat.completions.create({
    model:       aiSettings.model,
    messages,
    tools:       TOOLS,
    tool_choice: "auto",
    temperature: aiSettings.temperature,
    max_tokens:  aiSettings.max_tokens,
  });

  const choice = response.choices[0];
  let replyText = "";

  if (choice.finish_reason === "tool_calls") {
    const toolCalls = choice.message.tool_calls;
    const toolResults = [];

    for (const toolCall of toolCalls) {
      const args = JSON.parse(toolCall.function.arguments);

      if (toolCall.function.name === "save_lead") {
        await saveLead({ psid, orgId, ...args });
        toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: true }) });

      } else if (toolCall.function.name === "save_consultation") {
        await saveConsultation({ psid, orgId, ...args });
        toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: true }) });

      } else if (toolCall.function.name === "save_order") {
        await saveOrder({ psid, orgId, ...args });
        toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: true }) });

      } else if (toolCall.function.name === "search_knowledge") {
        const result = await searchKnowledge(orgId, args.query);
        toolResults.push({ tool_call_id: toolCall.id, content: result });

      } else if (toolCall.function.name === "flag_unanswered") {
        // Хариулагдаагүй асуултыг DB-д хадгала
        try {
          await prisma.turuuUnanswered.create({
            data: { orgId: orgId || "default", question: args.question, psid },
          });
        } catch { /* non-blocking */ }
        toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ flagged: true }) });

      } else if (toolCall.function.name === "request_handoff") {
        // Handoff flag TuruuChat-т тэмдэглэ
        try {
          await prisma.turuuChat.updateMany({
            where: { psid, orgId },
            data: { handoffRequested: true },
          });
        } catch { /* non-blocking */ }
        toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ handoff: true }) });
      }
    }

    // Follow-up: tool үр дүнтэй дахин дуудна
    const followUp = await getOpenAI().chat.completions.create({
      model: aiSettings.model,
      messages: [
        ...messages,
        choice.message,
        ...toolResults.map((r) => ({ role: "tool", tool_call_id: r.tool_call_id, content: r.content })),
      ],
      temperature: aiSettings.temperature,
      max_tokens:  512,
    });
    replyText = followUp.choices[0].message.content?.trim() || "";

  } else {
    replyText = choice.message.content?.trim() || "";
  }

  await saveHistory(psid, [...history, { role: "user", content: userText }, { role: "assistant", content: replyText }], orgId);

  // Мессежийн квот тоолох
  if (orgId) await incrementMessageUsed(orgId, prisma);

  return replyText;
}

module.exports = { processMessage };
