"use strict";
const OpenAI = require("openai");
const { buildSystemPrompt } = require("../lib/prompt");
const { getHistory, saveHistory, isNewConversation } = require("../lib/history");
const { saveLead, saveConsultation, saveOrder, saveAppointment } = require("./lead.service");
const { getPrisma } = require("../lib/db");

let openai;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

const PLAN_QUOTA = { starter: 7000, growth: 15000, business: 30000, enterprise: 70000 };
const PLAN_NEXT  = { starter: "Growth", growth: "Business", business: "Enterprise" };

// Текстийг normalize хийх (тэмдэгт арилгах, жижиглэх)
function normalizeText(s) {
  return s.toLowerCase().trim().replace(/[?!。？！.,;:]/g, "").replace(/\s+/g, " ").trim();
}

// Ажлын цагийн хугацаанд duration-тай slot үүсгэх
function buildSlots(workStart, workEnd, durationMinutes) {
  const slots = [];
  const [sh, sm] = workStart.split(":").map(Number);
  const [eh, em] = workEnd.split(":").map(Number);
  let cur = sh * 60 + sm;
  const end = eh * 60 + em;
  while (cur + durationMinutes <= end) {
    const h = Math.floor(cur / 60).toString().padStart(2, "0");
    const m = (cur % 60).toString().padStart(2, "0");
    slots.push(`${h}:${m}`);
    cur += durationMinutes;
  }
  return slots;
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
// Буцаах нь { text, variantImages } — text нь tool-result-д, variantImages нь
// хэрэглэгч зураг илгээсэн үед vision харьцуулалтад ашиглагдана
async function searchKnowledge(orgId, query) {
  try {
    const prisma = getPrisma();
    const items = await prisma.turuuKnowledge.findMany({
      where: { orgId: orgId || undefined, active: true },
      select: { question: true, answer: true, category: true, variants: true },
    });

    if (items.length === 0) return { text: "Мэдлэгийн сан хоосон байна.", variantImages: [] };

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

    if (scored.length === 0) return { text: "Мэдлэгийн санд тохирох мэдээлэл олдсонгүй.", variantImages: [] };

    const variantImages = [];
    const text = scored.map((s) => {
      let t = `А: ${s.item.question}\nХ: ${s.item.answer}`;
      const vars = Array.isArray(s.item.variants) ? s.item.variants : [];
      if (vars.length > 0) {
        // Тоо хэмжээ биш зөвхөн байгаа/байхгүй эсэхийг л дамжуулна — хэрэглэгчид үлдэгдлийн тоог илчлэхгүй
        const variantStr = vars.map((v) => `${[v.size, v.color].filter(Boolean).join("/")}: ${(v.stock ?? 0) > 0 ? "байгаа" : "байхгүй"}`).join(", ");
        t += `\nХувилбарууд (размер/өнгө): ${variantStr}`;
        vars.forEach((v) => {
          if (v.imageUrl) variantImages.push({ label: [v.size, v.color].filter(Boolean).join("/"), imageUrl: v.imageUrl });
        });
      }
      return t;
    }).join("\n\n");

    return { text, variantImages };
  } catch {
    return { text: "Мэдлэгийн санд хандахад алдаа гарлаа.", variantImages: [] };
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
      description: "Хэрэглэгч захиалгаа баталгаажуулж нэр, утас, хаяг өгсний дараа дуудна. ЧУХАЛ: бараа нь өнгө/размер-тэй (variant) бол заавал хэрэглэгчийн СОНГОСОН өнгө болон размерийг тодруулсны дараа л дуудна — мэдэхгүй байхад дуудаж болохгүй.",
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
                name:  { type: "string", description: "Барааны нэр" },
                color: { type: "string", description: "Сонгосон өнгө (variant байвал заавал)" },
                size:  { type: "string", description: "Сонгосон размер (variant байвал заавал)" },
                qty:   { type: "number" },
                price: { type: "number" },
              },
              required: ["name", "qty", "price"],
            },
          },
          totalAmount: { type: "number" },
          notes:       { type: "string" },
        },
        required: ["customerName", "customerPhone", "items", "totalAmount"],
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
  {
    type: "function",
    function: {
      name: "check_staff",
      description: "Байгаа мастеруудын жагсаалтыг авна — нэр, үйлчилгээ, ажлын цаг. Цаг захиалах яриа эхлэхэд эхлээд дуудна.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Тухайн мастерын тодорхой өдрийн боломжит цагуудыг авна. staffId болон date YYYY-MM-DD форматаар заавал дамжуулна.",
      parameters: {
        type: "object",
        properties: {
          staffId:     { type: "string", description: "Мастерын ID (check_staff-с авна)" },
          date:        { type: "string", description: "Огноо YYYY-MM-DD форматаар" },
          serviceName: { type: "string", description: "Үйлчилгээний нэр (байвал тэрнийх duration ашиглана)" },
        },
        required: ["staffId", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_appointment",
      description: "Хэрэглэгч цаг захиалгаа баталгаажуулсны дараа хадгалах. customerName болон customerPhone ЗААВАЛ авсан байна.",
      parameters: {
        type: "object",
        properties: {
          staffId:         { type: "string" },
          staffName:       { type: "string" },
          serviceName:     { type: "string" },
          durationMinutes: { type: "number" },
          date:            { type: "string", description: "YYYY-MM-DD" },
          timeSlot:        { type: "string", description: "HH:MM" },
          customerName:    { type: "string" },
          customerPhone:   { type: "string" },
          depositAmount:   { type: "number" },
          notes:           { type: "string" },
        },
        required: ["staffId", "serviceName", "durationMinutes", "date", "timeSlot", "customerName", "customerPhone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_order",
      description: "Хэрэглэгчийн захиалгын статус шалгах. Утасны дугаараар хайна. Утас өгөөгүй бол одоогийн чатын хэрэглэгчийн сүүлийн захиалгыг шалгана.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "Хэрэглэгчийн утасны дугаар" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_payment",
      description: "Хэрэглэгч 'төлчлөө', 'явуулчлаа', 'шилжүүлсэн' гэх мэт төлбөр хийснээ мэдэгдсэн үед дуудна. Захиалгын статусыг PAYMENT_SENT болгож эзэнд мэдэгдэл явуулна.",
      parameters: {
        type: "object",
        properties: {
          notes: { type: "string", description: "Хэрэглэгчийн нэмэлт тайлбар (байвал)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_menu",
      description: "Ресторанын менюгийн жагсаалтыг авна — хоолны нэр, ангилал, үнэ, порц.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_tables",
      description: "Ресторанын сул ширээ шалгана. date, time, guests дамжуулна.",
      parameters: {
        type: "object",
        properties: {
          date:   { type: "string", description: "YYYY-MM-DD" },
          time:   { type: "string", description: "HH:MM" },
          guests: { type: "number", description: "Хэдэн хүн" },
        },
        required: ["date", "time", "guests"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_reservation",
      description: "Ширээ захиалга хадгалах. customerName, customerPhone ЗААВАЛ авсан байна.",
      parameters: {
        type: "object",
        properties: {
          tableId:       { type: "string" },
          date:          { type: "string", description: "YYYY-MM-DD" },
          timeSlot:      { type: "string", description: "HH:MM" },
          guestCount:    { type: "number" },
          customerName:  { type: "string" },
          customerPhone: { type: "string" },
          notes:         { type: "string" },
        },
        required: ["tableId", "date", "timeSlot", "guestCount", "customerName", "customerPhone"],
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

// psid тус бүрт processing queue — race condition запобігає
const processingQueues = new Map();

function queuedProcessMessage(psid, userText, orgId, imageUrl = null) {
  if (!processingQueues.has(psid)) {
    processingQueues.set(psid, Promise.resolve());
  }
  const next = processingQueues.get(psid).then(() => processMessage(psid, userText, orgId, imageUrl));
  // Queue-г цэвэрлэх — хэтэрхий урт уламжлал хуримтлагдахгүй
  processingQueues.set(psid, next.catch(() => {}));
  return next;
}

async function processMessage(psid, userText, orgId = null, imageUrl = null) {
  const prisma = getPrisma();

  // Block + aiPaused + handoff шалгах
  try {
    const chatRecord = await prisma.turuuChat.findFirst({ where: { psid, orgId } });
    if (chatRecord?.blocked) return null;
    if (chatRecord?.aiPaused) return null;
    if (chatRecord?.handoffRequested) {
      const elapsed = chatRecord.handoffAt ? Date.now() - new Date(chatRecord.handoffAt).getTime() : Infinity;
      if (elapsed < 10 * 60 * 1000) return null; // 10 минут болоогүй — AI хариулахгүй
      // 10 минут өнгөрсөн — auto-clear, AI буцаж асна
      await prisma.turuuChat.update({ where: { id: chatRecord.id }, data: { handoffRequested: false, handoffAt: null } });
    }
  } catch { /* proceed */ }

  // KB exact match cache — таарвал OpenAI дуудахгүй, хямд бөгөөд хурдан
  // (зурагтай мессеж бол алгасна — зургийн агуулгаас хамаарч хариулт өөр байж болзошгүй)
  if (orgId && !imageUrl) {
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

  // Зурагтай мессеж бол vision хэлбэрээр илгээнэ (/client/chat-тай адил)
  const userContent = imageUrl
    ? [
        { type: "image_url", image_url: { url: imageUrl, detail: "auto" } },
        { type: "text", text: userText || "Энэ зурагт байгаа барааны тухай асууж байна." },
      ]
    : userText;

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userContent },
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
    const variantImages = []; // зураг илгээсэн хэрэглэгчтэй харьцуулах сангийн variant зурагнууд

    for (const toolCall of toolCalls) {
      const args = JSON.parse(toolCall.function.arguments);

      if (toolCall.function.name === "save_lead") {
        await saveLead({ psid, orgId, ...args });
        toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: true }) });

      } else if (toolCall.function.name === "save_consultation") {
        await saveConsultation({ psid, orgId, ...args });
        toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: true }) });

      } else if (toolCall.function.name === "save_order") {
        const order = await saveOrder({ psid, orgId, ...args });

        // Stock автоматаар хасах (давтан бол алгасна)
        if (orgId && order?.id && !order.duplicate) {
          try {
            const orderItems = Array.isArray(args.items) ? args.items : [];
            for (const it of orderItems) {
              if (!it.name || !it.qty) continue;
              const kbItems = await prisma.turuuKnowledge.findMany({ where: { orgId, active: true }, select: { id: true, question: true, variants: true } });
              const match = kbItems.find((k) => normalizeText(k.question).includes(normalizeText(it.name)) || normalizeText(it.name).includes(normalizeText(k.question)));
              if (match && Array.isArray(match.variants) && match.variants.length > 0) {
                const newVariants = match.variants.map((v) => {
                  const colorOk = !it.color || normalizeText(v.color || "").includes(normalizeText(it.color)) || normalizeText(it.color).includes(normalizeText(v.color || ""));
                  const sizeOk = !it.size || String(v.size || "").toLowerCase() === String(it.size).toLowerCase();
                  if (colorOk && sizeOk) return { ...v, stock: Math.max(0, (v.stock || 0) - (it.qty || 1)) };
                  return v;
                });
                await prisma.turuuKnowledge.update({ where: { id: match.id }, data: { variants: newVariants } });
              }
            }
          } catch (e) { console.error("[auto-stock]", e.message); }
        }

        // QPay auto-invoice: org-д merchant + данс тохируулсан бол автоматаар QR үүсгэнэ
        // (давтан дуудсан захиалга бол дахин invoice үүсгэхгүй — аль хэдийн явуулсан)
        let qpayInfo = null;
        if (orgId && order?.id && !order.duplicate) {
          try {
            const org = await prisma.organization.findUnique({
              where: { id: orgId },
              select: { qpayMerchantId: true, qpayBankCode: true, qpayAccountNumber: true, qpayAccountName: true, qpayBranchCode: true },
            });
            if (org?.qpayMerchantId && org?.qpayAccountNumber) {
              const qpay = require("./qpay.service");
              const result = await qpay.createInvoice({
                merchantId: org.qpayMerchantId,
                branchCode: org.qpayBranchCode || "BRANCH_001",
                amount: args.totalAmount || 0,
                description: `Захиалга #${order.id.slice(-6).toUpperCase()}`,
                customerName: args.customerName || "Хэрэглэгч",
                bankAccounts: [{
                  default: true,
                  account_bank_code: org.qpayBankCode,
                  account_number: org.qpayAccountNumber,
                  account_name: org.qpayAccountName,
                  is_default: true,
                }],
                callbackUrl: `${process.env.API_URL || "https://api.mongolagent.mn"}/webhook/qpay/${order.id}`,
              });
              await prisma.turuuOrder.update({
                where: { id: order.id },
                data: { qpayInvoiceId: result.invoice_id, qpayQrText: result.qr_text, qpayUrls: result.urls || [], qpayStatus: "PENDING" },
              });
              qpayInfo = qpay.buildPaymentMessage(result, args.totalAmount, order.id.slice(-6).toUpperCase());
            }
          } catch (qErr) {
            console.error("[QPay auto-invoice]", qErr.message);
          }
        }

        toolResults.push({
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            success: true,
            ...(qpayInfo ? { qpayReady: true, qpayMessage: qpayInfo } : { qpayReady: false }),
          }),
        });

      } else if (toolCall.function.name === "search_knowledge") {
        const { text, variantImages: vImgs } = await searchKnowledge(orgId, args.query);
        toolResults.push({ tool_call_id: toolCall.id, content: text });
        variantImages.push(...vImgs);

      } else if (toolCall.function.name === "flag_unanswered") {
        // Хариулагдаагүй асуултыг DB-д хадгала
        try {
          await prisma.turuuUnanswered.create({
            data: { orgId: orgId || "default", question: args.question, psid },
          });
        } catch { /* non-blocking */ }
        toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ flagged: true }) });

      } else if (toolCall.function.name === "request_handoff") {
        // Handoff flag TuruuChat-т тэмдэглэ + цаг тэмдэглэх
        try {
          await prisma.turuuChat.updateMany({
            where: { psid, orgId },
            data: { handoffRequested: true, handoffAt: new Date() },
          });
        } catch { /* non-blocking */ }
        toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ handoff: true }) });

      } else if (toolCall.function.name === "check_staff") {
        try {
          const staffList = await prisma.turuuStaff.findMany({
            where: { orgId, isActive: true },
            select: { id: true, name: true, services: true, workDays: true, workStart: true, workEnd: true },
          });
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ staff: staffList }) });
        } catch {
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ staff: [] }) });
        }

      } else if (toolCall.function.name === "check_availability") {
        try {
          const { date, staffId, serviceName } = args;
          const staff = await prisma.turuuStaff.findFirst({ where: { id: staffId, orgId, isActive: true } });
          if (!staff) {
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ error: "Мастер олдсонгүй" }) });
          } else {
            const d = new Date(`${date}T00:00:00`);
            const jsDay = d.getDay();
            const isoDay = jsDay === 0 ? 7 : jsDay;
            const workDays = Array.isArray(staff.workDays) ? staff.workDays : JSON.parse(staff.workDays || "[1,2,3,4,5]");
            if (!workDays.includes(isoDay)) {
              toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ availableSlots: [], reason: "Тухайн өдөр амарна" }) });
            } else {
              const booked = await prisma.turuuAppointment.findMany({
                where: { staffId, date, status: { not: "CANCELLED" } },
                select: { timeSlot: true },
              });
              const bookedTimes = new Set(booked.map((b) => b.timeSlot));
              const services = Array.isArray(staff.services) ? staff.services : JSON.parse(staff.services || "[]");
              let duration = 60;
              if (serviceName) {
                const svc = services.find((s) => s.name === serviceName);
                if (svc?.durationMinutes) duration = svc.durationMinutes;
              } else {
                duration = services.reduce((max, s) => Math.max(max, s.durationMinutes || 60), 60);
              }
              const buffer = Number(staff.bufferMinutes) || 0;
              const allSlots = buildSlots(staff.workStart, staff.workEnd, duration + buffer);
              const available = allSlots.filter((s) => !bookedTimes.has(s));
              toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ availableSlots: available, staffName: staff.name }) });
            }
          }
        } catch {
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ error: "Цагийн мэдээлэл авахад алдаа гарлаа" }) });
        }

      } else if (toolCall.function.name === "save_appointment") {
        try {
          const appt = await saveAppointment({ psid, orgId, ...args });
          const result = { success: true, duplicate: appt.duplicate || false };
          if (appt.qpayData) result.qpay = appt.qpayData;
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify(result) });
        } catch (e) {
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: false, error: e.message }) });
        }

      } else if (toolCall.function.name === "check_menu") {
        try {
          const kbItems = await prisma.turuuKnowledge.findMany({
            where: { orgId, active: true, category: { startsWith: "Бүтээгдэхүүн" } },
            select: { question: true, answer: true, category: true, variants: true },
            orderBy: { category: "asc" },
          });
          if (kbItems.length === 0) {
            toolResults.push({ tool_call_id: toolCall.id, content: "Меню хоосон байна." });
          } else {
            const menu = kbItems.map((item) => {
              let line = `${item.question} (${(item.category || "").replace("Бүтээгдэхүүн / ", "")}) — ${item.answer}`;
              const vars = Array.isArray(item.variants) ? item.variants : [];
              if (vars.length > 0) {
                const varStr = vars.map((v) => `${[v.size, v.color].filter(Boolean).join("/")}: ${(v.stock ?? 0) > 0 ? "байгаа" : "дууссан"}`).join(", ");
                line += ` | ${varStr}`;
              }
              return line;
            }).join("\n");
            toolResults.push({ tool_call_id: toolCall.id, content: menu });
          }
        } catch {
          toolResults.push({ tool_call_id: toolCall.id, content: "Меню авахад алдаа гарлаа." });
        }

      } else if (toolCall.function.name === "check_tables") {
        try {
          const { date, time, guests } = args;
          console.log("[CHECK_TABLES]", { orgId, date, time, guests });
          const allTables = await prisma.turuuTable.findMany({ where: { orgId, isActive: true, capacity: { gte: Number(guests) || 1 } }, orderBy: { capacity: "asc" } });
          const reservations = await prisma.turuuReservation.findMany({ where: { orgId, date, timeSlot: time, status: { not: "CANCELLED" } }, select: { tableId: true } });
          const bookedIds = new Set(reservations.map((r) => r.tableId));
          const available = allTables.filter((t) => !bookedIds.has(t.id));
          console.log("[CHECK_TABLES] result:", { allTablesCount: allTables.length, reservationsCount: reservations.length, availableCount: available.length });
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ available: available.map((t) => ({ id: t.id, tableNumber: t.tableNumber, capacity: t.capacity })), total: allTables.length }) });
        } catch (e) {
          console.error("[CHECK_TABLES] error:", e.message);
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ error: "Ширээ шалгахад алдаа гарлаа: " + e.message }) });
        }

      } else if (toolCall.function.name === "check_order") {
        try {
          const phone = (args.phone || "").trim();
          const where = { orgId };
          if (phone) {
            where.customerPhone = phone;
          } else {
            where.psid = psid;
          }
          const orders = await prisma.turuuOrder.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: 3,
            select: { id: true, status: true, totalAmount: true, items: true, customerName: true, customerPhone: true, createdAt: true, qpayStatus: true },
          });
          if (orders.length === 0) {
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ found: false, error: phone ? `${phone} дугаартай захиалга олдсонгүй` : "Танд захиалга олдсонгүй" }) });
          } else {
            const STATUS_MN = { NEW: "Шинэ — төлбөр хүлээгдэж байна", PAYMENT_SENT: "Төлбөр илгээсэн — шалгагдаж байна", PAID: "Төлбөр баталгаажсан — хүргэлтэнд бэлдэгдэж байна", CANCELLED: "Цуцлагдсан" };
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({
              found: true,
              orders: orders.map((o) => ({
                status: o.status,
                statusLabel: STATUS_MN[o.status] || o.status,
                totalAmount: o.totalAmount,
                items: o.items,
                createdAt: o.createdAt,
                paid: o.status === "PAID" || o.qpayStatus === "PAID",
              })),
            }) });
          }
        } catch (e) {
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ found: false, error: e.message }) });
        }

      } else if (toolCall.function.name === "confirm_payment") {
        try {
          const order = await prisma.turuuOrder.findFirst({
            where: { psid, orgId, status: { notIn: ["PAID", "CANCELLED"] } },
            orderBy: { createdAt: "desc" },
          });
          if (!order) {
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: false, error: "Төлөгдөөгүй захиалга олдсонгүй" }) });
          } else {
            await prisma.turuuOrder.update({ where: { id: order.id }, data: { status: "PAYMENT_SENT" } });
            const orderCode = order.id.slice(-6).toUpperCase();
            // Telegram мэдэгдэл (бэлэн код, telegram холбогдсон үед ажиллана)
            if (orgId) {
              try {
                const org = await prisma.organization.findUnique({
                  where: { id: orgId },
                  select: { telegramBotToken: true, telegramChatId: true },
                });
                const botToken = org?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
                const chatId = org?.telegramChatId || process.env.TELEGRAM_CHAT_ID;
                if (botToken && chatId) {
                  const axios = require("axios");
                  const text = `💳 Хэрэглэгч төлбөр шилжүүлснээ мэдэгдлээ!\nЗахиалга #${orderCode}\nДүн: ₮${Number(order.totalAmount || 0).toLocaleString()}\nХэрэглэгч: ${order.customerName || "—"}\n${args.notes ? `Тайлбар: ${args.notes}` : ""}\nDashboard-аас шалгаж баталгаажуулна уу!`;
                  await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text }).catch(() => {});
                }
              } catch { /* non-blocking */ }
            }
            toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: true, orderCode }) });
          }
        } catch (e) {
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: false, error: e.message }) });
        }

      } else if (toolCall.function.name === "save_reservation") {
        try {
          const conflict = await prisma.turuuReservation.findFirst({ where: { tableId: args.tableId, date: args.date, timeSlot: args.timeSlot, status: { not: "CANCELLED" } } });
          if (conflict) throw new Error(`Уучлаарай, ${args.timeSlot} цагт тэр ширээ захиалагдсан байна.`);
          const reservation = await prisma.turuuReservation.create({
            data: { orgId, psid, tableId: args.tableId, date: args.date, timeSlot: args.timeSlot, guestCount: Number(args.guestCount), customerName: args.customerName, customerPhone: args.customerPhone, notes: args.notes },
          });
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: true, reservationId: reservation.id }) });
        } catch (e) {
          toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ success: false, error: e.message }) });
        }
      }
    }

    // Follow-up: tool үр дүнтэй дахин дуудна
    const followUpMessages = [
      ...messages,
      choice.message,
      ...toolResults.map((r) => ({ role: "tool", tool_call_id: r.tool_call_id, content: r.content })),
    ];

    // Хэрэглэгч зураг илгээсэн бол сангийн variant зурагнуудтай шууд visual харьцуулна
    // (нэрээр харьцуулах нь хувилбар нэрс яг тохирохгүй үед буруу "байхгүй" хариу өгдөг асуудлыг засна)
    if (imageUrl && variantImages.length > 0) {
      const seen = new Set();
      const uniqueImages = variantImages.filter((v) => {
        if (seen.has(v.imageUrl)) return false;
        seen.add(v.imageUrl);
        return true;
      }).slice(0, 6);

      const comparisonContent = [
        { type: "text", text: "Эдгээр нь мэдлэгийн санд хадгалагдсан хувилбаруудын зургууд. Хэрэглэгчийн илгээсэн зурагтай (дээрх) нэг нэгээр харьцуулж, аль нь тохирохыг тодорхойл:" },
      ];
      uniqueImages.forEach((v) => {
        comparisonContent.push({ type: "image_url", image_url: { url: v.imageUrl, detail: "auto" } });
        comparisonContent.push({ type: "text", text: `↑ Дээрх зураг: ${v.label}` });
      });
      followUpMessages.push({ role: "user", content: comparisonContent });
    }

    const followUp = await getOpenAI().chat.completions.create({
      model: aiSettings.model,
      messages: followUpMessages,
      temperature: aiSettings.temperature,
      max_tokens:  512,
    });
    replyText = followUp.choices[0].message.content?.trim() || "";

  } else {
    replyText = choice.message.content?.trim() || "";
  }

  const historyUserContent = imageUrl ? (userText || "[ЗУРАГ ИЛГЭЭСЭН]") : userText;
  await saveHistory(psid, [...history, { role: "user", content: historyUserContent }, { role: "assistant", content: replyText }], orgId);

  // Мессежийн квот тоолох
  if (orgId) await incrementMessageUsed(orgId, prisma);

  return replyText;
}

// Хэрэглэгчийн явуулсан төлбөрийн баримт (screenshot) зургийг боловсруулна:
// зураг дээрх шилжүүлсэн дүнг таниж, хэрэглэгчийн сүүлийн "PAID" болоогүй
// захиалгын нийт дүнтэй тулгаж тааруулна.
async function processReceiptImage(psid, imageUrl, orgId = null) {
  const prisma = getPrisma();

  const order = await prisma.turuuOrder.findFirst({
    where: { psid, orgId, status: { notIn: ["PAID", "CANCELLED", "DONE"] } },
    orderBy: { createdAt: "desc" },
  });

  if (!order) {
    return "Уучлаарай, танай захиалгын мэдээлэл олдсонгүй 😔 Манай ажилтантай шууд холбогдоно уу.";
  }

  let extractedAmount = 0;
  try {
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Энэ бол банкны шилжүүлгийн баримт/screenshot. Зурган дээрх ШИЛЖҮҮЛСЭН ДҮНГИЙН тоог ЗӨВХӨН бүхэл тоо хэлбэрээр хариул (мөнгөн тэмдэгт, таслал, зай бүгдийг арилга). Дүн олдохгүй бол 0 гэж хариул." },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      max_tokens: 20,
      temperature: 0,
    });
    const text = response.choices[0]?.message?.content?.trim() || "0";
    extractedAmount = parseInt(text.replace(/[^\d]/g, ""), 10) || 0;
  } catch (err) {
    console.error("[receipt OCR]", err.message);
  }

  const expected = Math.round(order.totalAmount || 0);
  const orderCode = order.id.slice(-6).toUpperCase();
  let replyText;
  let amountMatches = false;

  if (extractedAmount > 0 && extractedAmount >= expected) {
    amountMatches = true;
    await prisma.turuuOrder.update({ where: { id: order.id }, data: { status: "PAYMENT_SENT" } });
    replyText = `📸 Баримтыг хүлээн авлаа! Захиалга #${orderCode} (${expected.toLocaleString()}₮)-ийн дүн тохирч байна — манай ажилтан баталгаажуулсны дараа мэдэгдэл очно 🙏`;
  } else if (extractedAmount > 0) {
    await prisma.turuuOrder.update({ where: { id: order.id }, data: { status: "PAYMENT_SENT" } });
    replyText = `⚠️ Баримтаас ${extractedAmount.toLocaleString()}₮ танигдлаа, харин захиалгын дүн ${expected.toLocaleString()}₮ байна. Манай ажилтан шалгаж тантай холбогдоно уу 🙏`;
  } else {
    await prisma.turuuOrder.update({ where: { id: order.id }, data: { status: "PAYMENT_SENT" } });
    replyText = `📸 Баримтыг хүлээн авлаа! Манай ажилтан шалгаж баталгаажуулна, түр хүлээнэ үү 🙏`;
  }

  // Admin-д Telegram мэдэгдэл — дансаар бол ҮРГЭЛЖ явуулна (QPay flow-той адил pattern)
  if (orgId) {
    try {
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { telegramBotToken: true, telegramChatId: true },
      });
      const botToken = org?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
      const chatId = org?.telegramChatId || process.env.TELEGRAM_CHAT_ID;
      if (botToken && chatId) {
        const axios = require("axios");
        const statusLine = amountMatches
          ? "📥 Дансаар баримт ирлээ — дүн тохирч байна, БАТАЛГААЖУУЛНА УУ"
          : `⚠️ Дансаар баримт ирлээ — дүн зөрүүтэй/танигдсангүй (танигдсан дүн: ${extractedAmount ? extractedAmount.toLocaleString() + "₮" : "тодорхойгүй"}), шалгана уу`;
        const text = `${statusLine}\nЗахиалга #${orderCode}\nДүн: ₮${expected.toLocaleString()}\nХэрэглэгч: ${order.customerName || "—"}\nБаримт: ${imageUrl}`;
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text }).catch(() => {});
      }
    } catch { /* non-blocking */ }
  }

  const history = await getHistory(psid, orgId);
  await saveHistory(psid, [...history, { role: "user", content: "[ТӨЛБӨРИЙН БАРИМТ ЗУРАГ ИЛГЭЭСЭН]" }, { role: "assistant", content: replyText }], orgId);

  if (orgId) await incrementMessageUsed(orgId, prisma);

  return replyText;
}

// Ирсэн зургийг ангилна: төлбөрийн баримт/screenshot уу, эсвэл барааны зураг уу.
// Алдаа гарвал "receipt" гэж үзнэ — одоогийн (баримт шалгах) урсгалтай адил тул аюулгүй.
async function classifyImage(imageUrl, captionText) {
  try {
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Энэ зургийг ангилна уу.\n` +
                `- Хэрэв энэ бол банкны шилжүүлгийн баримт, QPay/гүйлгээний амжилттай дэлгэцийн зураг бол яг "receipt" гэж хариул.\n` +
                `- Бусад тохиолдолд (бараа/бүтээгдэхүүний зураг, дэлгэцийн агшин г.м) яг "product" гэж хариул.\n` +
                `ЗӨВХӨН "receipt" эсвэл "product" гэсэн нэг үгээр хариул, өөр юу ч бичих хэрэггүй.` +
                (captionText ? `\n\nХэрэглэгчийн бичсэн текст: "${captionText}"` : ""),
            },
            { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
          ],
        },
      ],
      max_tokens: 5,
      temperature: 0,
    });
    const label = response.choices[0]?.message?.content?.trim().toLowerCase() || "";
    return label.includes("product") ? "product" : "receipt";
  } catch (err) {
    console.error("[classifyImage]", err.message);
    return "receipt";
  }
}

// Хэрэглэгчийн илгээсэн зургийг төрлөөр нь зохих урсгал руу чиглүүлнэ:
// төлбөрийн баримт бол processReceiptImage, бараа/бүтээгдэхүүний зураг бол
// vision-той чат руу (processMessage) дамжуулна — жишээ нь "энэ ямар өнгөтэй байгаа?"
async function processImageMessage(psid, imageUrl, captionText, orgId = null) {
  const classification = await classifyImage(imageUrl, captionText);
  if (classification === "receipt") {
    return processReceiptImage(psid, imageUrl, orgId);
  }
  return queuedProcessMessage(psid, captionText || "", orgId, imageUrl);
}

// Voice message → текст (Whisper API)
async function transcribeAudio(audioUrl) {
  try {
    const axios = require("axios");
    const FormData = require("form-data");
    const resp = await axios.get(audioUrl, { responseType: "arraybuffer" });
    const form = new FormData();
    form.append("file", Buffer.from(resp.data), { filename: "voice.mp4", contentType: "audio/mp4" });
    form.append("model", "whisper-1");
    form.append("language", "mn");
    const result = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 30000,
    });
    return result.data?.text?.trim() || null;
  } catch (err) {
    console.error("[transcribe]", err.message);
    return null;
  }
}

module.exports = { processMessage: queuedProcessMessage, processReceiptImage, processImageMessage, transcribeAudio };
