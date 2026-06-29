"use strict";
const { getPrisma } = require("../lib/db");
const axios = require("axios");

async function saveLead({ psid, orgId = null, name, phone, email, company, serviceInterest, budget, notes }) {
  const prisma = getPrisma();
  const lead = await prisma.turuuLead.create({
    data: { psid, orgId, name, phone, email, company, serviceInterest, budget, notes },
  });

  // Telegram мэдэгдэл — org-ийн token эсвэл глобал token ашиглана
  const { botToken, chatId } = await getTelegramConfig(orgId);
  await notifyTelegram("💼 Шинэ Lead", { name, phone, email, company, serviceInterest, budget, notes }, botToken, chatId);
  return lead;
}

async function saveConsultation({ psid, orgId = null, name, phone, email, serviceInterest, preferredTime }) {
  const prisma = getPrisma();
  const c = await prisma.turuuConsultation.create({
    data: { psid, orgId, name, phone, email, serviceInterest, preferredTime },
  });

  const { botToken, chatId } = await getTelegramConfig(orgId);
  await notifyTelegram("📅 Consultation захиалга", { name, phone, email, serviceInterest, preferredTime }, botToken, chatId);
  return c;
}

async function getTelegramConfig(orgId) {
  try {
    if (orgId) {
      const prisma = getPrisma();
      const org = await prisma.organization.findUnique({ where: { id: orgId } });
      if (org?.telegramBotToken && org?.telegramChatId) {
        return { botToken: org.telegramBotToken, chatId: org.telegramChatId };
      }
    }
  } catch { /* fallback */ }
  return { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID };
}

async function notifyTelegram(title, data, botToken, chatId) {
  if (!botToken || !chatId) return;
  const lines = Object.entries(data).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
  const text = `${title}\n━━━━━━━━━━━━\n${lines}`;
  await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text })
    .catch((err) => console.error("[TG] notify error:", err.message));
}

async function saveOrder({ psid, orgId = null, customerName, customerPhone, customerEmail, deliveryAddress, items, totalAmount, notes, payOnPickup = false }) {
  const prisma = getPrisma();

  // Очиж авахдаа төлнө — notes-д тэмдэглэж эзэнд (dashboard + Telegram) харагдуулна
  if (payOnPickup) {
    const suffix = "Очиж авахдаа төлнө";
    notes = notes ? `${notes} | ${suffix}` : suffix;
  }

  // Idempotency: AI ижил захиалгад save_order-ыг давтан дуудвал (жишээ нь "дансаар төлье" гэсний дараа)
  // сүүлийн 30 минутад ижил psid+totalAmount-тай NEW захиалга байгаа бол давтахгүй
  if (psid) {
    const recent = await prisma.turuuOrder.findFirst({
      where: {
        psid, orgId, status: "NEW", totalAmount,
        createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (recent) return { ...recent, duplicate: true };
  }

  const order = await prisma.turuuOrder.create({
    data: { psid, orgId, customerName, customerPhone, customerEmail, deliveryAddress, items, totalAmount, notes },
  });

  const { botToken, chatId } = await getTelegramConfig(orgId);
  const itemsSummary = Array.isArray(items) ? items.map((i) => {
    const variant = [i.color, i.size].filter(Boolean).join(" / ");
    return `${i.name}${variant ? ` (${variant})` : ""} x${i.qty} — ₮${(i.price * i.qty).toLocaleString()}`;
  }).join("\n") : "";
  await notifyTelegram("🛒 Шинэ захиалга", { customerName, customerPhone, deliveryAddress, items: itemsSummary, totalAmount: `₮${totalAmount?.toLocaleString()}`, notes }, botToken, chatId);
  return order;
}

async function saveAppointment({ psid, orgId = null, staffId, staffName, serviceName, durationMinutes, date, timeSlot, customerName, customerPhone, depositAmount = 0, notes }) {
  const prisma = getPrisma();

  // Idempotency: ижил мастер/огноо/цаг/утасны дугаарт 10 минутад давтан дуудсан бол алгасна
  if (psid) {
    const recent = await prisma.turuuAppointment.findFirst({
      where: { psid, orgId, staffId, date, timeSlot, createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } },
    });
    if (recent) return { ...recent, duplicate: true };
  }

  // Давхар захиалга шалгах: тухайн мастерын тухайн цагт өөр захиалга байвал хориглоно
  const conflict = await prisma.turuuAppointment.findFirst({
    where: { staffId, date, timeSlot, status: { not: "CANCELLED" } },
  });
  if (conflict) {
    throw new Error(`Уучлаарай, ${timeSlot} цаг аль хэдийн захиалагдсан байна. Өөр цаг сонгоно уу.`);
  }

  const appt = await prisma.turuuAppointment.create({
    data: { psid, orgId, staffId, serviceName, durationMinutes, date, timeSlot, customerName, customerPhone, depositAmount, notes },
  });

  // QPay урьдчилгаа invoice автоматаар үүсгэх
  let qpayData = null;
  if (depositAmount > 0 && orgId) {
    try {
      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { qpayMerchantId: true, qpayBranchCode: true, qpayAccountNumber: true, qpayAccountBank: true, qpayAccountName: true } });
      if (org?.qpayMerchantId && org?.qpayAccountNumber) {
        const qpay = require("../services/qpay.service");
        const API_URL = process.env.API_URL || "https://api.mongolagent.mn";
        const result = await qpay.createInvoice({
          merchantId: org.qpayMerchantId,
          branchCode: org.qpayBranchCode || "BRANCH_001",
          amount: depositAmount,
          description: `Урьдчилгаа — ${serviceName} (${date} ${timeSlot})`,
          customerName: customerName || "Хэрэглэгч",
          bankAccounts: [{ account_bank_code: org.qpayAccountBank, account_number: org.qpayAccountNumber, account_name: org.qpayAccountName, is_default: true }],
          callbackUrl: `${API_URL}/webhook/qpay-appointment/${appt.id}`,
        });
        await prisma.turuuAppointment.update({
          where: { id: appt.id },
          data: { qpayInvoiceId: result.invoice_id, qpayQrText: result.qr_text, qpayUrls: result.urls || [], qpayStatus: "PENDING", depositStatus: "PENDING" },
        });
        qpayData = { invoiceId: result.invoice_id, qrText: result.qr_text, urls: result.urls || [] };
      }
    } catch (e) {
      console.error("[QPay appointment invoice]", e.message);
    }
  }

  const { botToken, chatId } = await getTelegramConfig(orgId);
  let staffKeyLabel = "Мастер";
  try {
    const bt = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key: "business_type" } } });
    const { getLabels } = require("../lib/businessType");
    staffKeyLabel = getLabels(bt?.value).telegramKey;
  } catch { /* fallback */ }
  await notifyTelegram("📅 Шинэ цаг захиалга", {
    [staffKeyLabel]: staffName || staffId,
    Үйлчилгээ:   serviceName,
    Огноо:       `${date} ${timeSlot}`,
    Хэрэглэгч:   customerName,
    Утас:         customerPhone,
    Урьдчилгаа:  depositAmount > 0 ? `₮${depositAmount.toLocaleString()}` : undefined,
    Тэмдэглэл:   notes,
  }, botToken, chatId);

  return { ...appt, qpayData };
}

module.exports = { saveLead, saveConsultation, saveOrder, saveAppointment };
