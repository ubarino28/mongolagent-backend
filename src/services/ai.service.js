"use strict";
const OpenAI = require("openai");
const { buildSystemPrompt } = require("../lib/prompt");
const { getHistory, saveHistory, isNewConversation } = require("../lib/history");
const { saveLead, saveConsultation } = require("./lead.service");
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
      description: "Хэрэглэгч үйлчилгээ сонирхоход нэр, холбоо барих мэдээлэл хадгална. Дараа нь манай баг холбогдоно.",
      parameters: {
        type: "object",
        properties: {
          name:            { type: "string", description: "Хэрэглэгчийн нэр" },
          phone:           { type: "string", description: "Утасны дугаар" },
          email:           { type: "string", description: "Имэйл хаяг" },
          company:         { type: "string", description: "Компани/бизнесийн нэр" },
          serviceInterest: { type: "string", description: "Сонирхож буй үйлчилгээ" },
          budget:          { type: "string", description: "Төсөв (хэрэв дурдсан бол)" },
          notes:           { type: "string", description: "Нэмэлт мэдээлэл" },
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
          name:            { type: "string", description: "Хэрэглэгчийн нэр" },
          phone:           { type: "string", description: "Утасны дугаар" },
          email:           { type: "string", description: "Имэйл хаяг" },
          serviceInterest: { type: "string", description: "Ямар үйлчилгээний талаар ярилцахыг хүсэж байна" },
          preferredTime:   { type: "string", description: "Хүссэн цаг/өдөр" },
        },
        required: ["phone"],
      },
    },
  },
];

async function loadAISettings() {
  try {
    const prisma = getPrisma();
    const rows = await prisma.turuuSettings.findMany({
      where: { key: { in: ["ai_model", "ai_temperature", "ai_max_tokens"] } },
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

async function processMessage(psid, userText) {
  // Check if user is blocked
  try {
    const prisma = getPrisma();
    const chatRecord = await prisma.turuuChat.findUnique({ where: { psid } });
    if (chatRecord?.blocked) return null;
  } catch {
    // proceed if DB check fails
  }

  const [isNew, history, aiSettings] = await Promise.all([
    isNewConversation(psid),
    getHistory(psid),
    loadAISettings(),
  ]);

  const systemPrompt = await buildSystemPrompt(isNew);

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
      await saveLead({ psid, ...args });
      replyText = `Баярлалаа 😊 Таны мэдээллийг хүлээн авлаа. Манай мэргэжилтэн удахгүй тантай холбогдоно.`;
    } else if (toolCall.function.name === "save_consultation") {
      await saveConsultation({ psid, ...args });
      replyText = `Consultation захиалга амжилттай бүртгэгдлээ 😊 Бид тантай ${args.preferredTime ? args.preferredTime + " орчим" : "удахгүй"} холбогдоно. Баярлалаа!`;
    }

    const updatedMessages = [
      ...messages,
      choice.message,
      { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ success: true }) },
    ];

    const followUp = await getOpenAI().chat.completions.create({
      model: aiSettings.model,
      messages: updatedMessages,
      temperature: aiSettings.temperature,
      max_tokens: 512,
    });
    const followText = followUp.choices[0].message.content?.trim();
    if (followText && followText.length > 5) replyText = followText;

  } else {
    replyText = choice.message.content?.trim() || "";
  }

  const newHistory = [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: replyText },
  ];
  await saveHistory(psid, newHistory);

  return replyText;
}

module.exports = { processMessage };
