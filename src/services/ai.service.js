"use strict";
const OpenAI = require("openai");
const { buildSystemPrompt } = require("../lib/prompt");
const { getHistory, saveHistory, isNewConversation } = require("../lib/history");
const { saveLead, saveConsultation } = require("./lead.service");

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

async function processMessage(psid, userText) {
  const isNew = await isNewConversation(psid);
  const history = await getHistory(psid);

  const messages = [
    { role: "system", content: buildSystemPrompt(isNew) },
    ...history,
    { role: "user", content: userText },
  ];

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    tools: TOOLS,
    tool_choice: "auto",
    temperature: 0.4,
    max_tokens: 1024,
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

    // Tool call-ийн дараа AI-г үргэлжлүүлэхэд tool result нэмнэ
    const updatedMessages = [
      ...messages,
      choice.message,
      { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ success: true }) },
    ];

    // Хэрэв AI нэмэлт текст хариулт гаргавал авна
    const followUp = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: updatedMessages,
      temperature: 0.4,
      max_tokens: 512,
    });
    const followText = followUp.choices[0].message.content?.trim();
    if (followText && followText.length > 5) replyText = followText;

  } else {
    replyText = choice.message.content?.trim() || "";
  }

  // Яриа түүх хадгал
  const newHistory = [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: replyText },
  ];
  await saveHistory(psid, newHistory);

  return replyText;
}

module.exports = { processMessage };
