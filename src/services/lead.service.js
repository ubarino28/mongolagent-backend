"use strict";
const { getPrisma } = require("../lib/db");
const { notifyOwner } = require("./notify.service");

// AI tool-аас ирэх мөрийг хязгаарлана — урт payload-оор DB bloat хийхээс сэргийлнэ
const C = (s, n = 200) => (typeof s === "string" ? s.slice(0, n) : s);

async function saveLead({ psid, orgId = null, name, phone, email, company, serviceInterest, budget, notes }) {
  const prisma = getPrisma();
  const lead = await prisma.turuuLead.create({
    data: { psid, orgId, name: C(name, 120), phone: C(phone, 32), email: C(email, 160), company: C(company, 160), serviceInterest: C(serviceInterest, 200), budget: C(budget, 80), notes: C(notes, 1000) },
  });

  // Мэдэгдэл — байгууллагын и-мэйл рүү (туслах урсгал, унавал захиалгад нөлөөлөхгүй)
  await notifyOwner(orgId, "Шинэ Lead", {
    Нэр: name, Утас: phone, "И-мэйл": email, Байгууллага: company,
    Сонирхол: serviceInterest, Төсөв: budget, Тэмдэглэл: notes,
  }, { label: "Lead-үүдээ харах", path: "/leads" });
  return lead;
}

async function saveConsultation({ psid, orgId = null, name, phone, email, serviceInterest, preferredTime }) {
  const prisma = getPrisma();
  const c = await prisma.turuuConsultation.create({
    data: { psid, orgId, name: C(name, 120), phone: C(phone, 32), email: C(email, 160), serviceInterest: C(serviceInterest, 200), preferredTime: C(preferredTime, 120) },
  });

  await notifyOwner(orgId, "Consultation захиалга", {
    Нэр: name, Утас: phone, "И-мэйл": email,
    Сонирхол: serviceInterest, "Тохирох цаг": preferredTime,
  }, { label: "Дэлгэрэнгүй харах", path: "/leads" });
  return c;
}

async function saveOrder({ psid, orgId = null, customerName, customerPhone, customerEmail, deliveryAddress, items, totalAmount, notes, payOnPickup = false }) {
  const prisma = getPrisma();

  // Хамгаалалт: AI баталгаажуулалтгүйгээр хоосон эсвэл placeholder ("Таны нэр"/"Таны утас")
  // нэр/утсаар захиалга үүсгэхийг хориглоно — алдаа буцаавал AI дахин нэр/утас асууна.
  const phoneDigits = (customerPhone || "").replace(/\D/g, "");
  const nameTrim = (customerName || "").trim();
  const placeholderRe = /таны\s*(нэр|утас)|^(нэр|утас|нэрээ|утсаа|customer|name|phone)$/i;
  if (!nameTrim || placeholderRe.test(nameTrim) || phoneDigits.length < 8) {
    throw new Error("Захиалга бүртгэхийн тулд хэрэглэгчийн бодит нэр болон 8 оронтой утасны дугаарыг эхлээд авна уу.");
  }

  // Sanity: AI tool-аас ирэх тоо хэмжээ/дүнг хязгаарлана — буруу/санаатай гажуудал (сөрөг,
  // NaN, 10000 ширхэг г.м)-аас сэргийлнэ.
  if (Array.isArray(items)) {
    items = items.map((i) => ({ ...i, qty: Math.max(1, Math.min(999, Math.floor(Number(i?.qty) || 1))) }));
  }
  if (!Number.isFinite(Number(totalAmount)) || Number(totalAmount) < 0) totalAmount = 0;

  // Хамгаалалт: бараатай атал нийт дүн 0/сөрөг бол → AI үнэ татахаас өмнө save_order дуудсан.
  // ₮0 (үнэгүй) захиалга үүсгэхгүй — алдаа буцаавал AI үнийг эхлээд тодруулж дахин дуудна.
  if (Array.isArray(items) && items.length > 0 && Number(totalAmount) <= 0) {
    throw new Error("Захиалгын нийт дүн 0 байна. Барааны үнийг эхлээд тодруулна уу (search_knowledge/check_menu-ээр) дараа нь захиалгыг бүртгэнэ.");
  }

  // Очиж авахдаа төлнө — notes-д тэмдэглэж эзэнд (dashboard + и-мэйл) харагдуулна
  if (payOnPickup) {
    const suffix = "Очиж авахдаа төлнө";
    notes = notes ? `${notes} | ${suffix}` : suffix;
  }

  // Idempotency: AI ижил захиалгад save_order-ыг давтан дуудвал (жишээ нь "дансаар төлье" гэсний дараа,
  // эсвэл хэрэглэгч хожим дахин "QPay явуулаач" гэвэл) ижил psid+totalAmount-тай NEW захиалга ХЭДИЙД Ч
  // байсан шинэ захиалга үүсгэхгүй — зөвхөн 48 цагийн auto-cancel-аар (src/index.js) хугацаа дуусна.
  if (psid) {
    const recent = await prisma.turuuOrder.findFirst({
      where: { psid, orgId, status: "NEW", totalAmount },
      orderBy: { createdAt: "desc" },
    });
    if (recent) return { ...recent, duplicate: true };
  }

  const order = await prisma.turuuOrder.create({
    data: { psid, orgId, customerName: C(customerName, 120), customerPhone: C(customerPhone, 32), customerEmail: C(customerEmail, 160), deliveryAddress: C(deliveryAddress, 400), items, totalAmount, notes: C(notes, 1000) },
  });

  const itemsSummary = Array.isArray(items) ? items.map((i) => {
    const variant = [i.color, i.size].filter(Boolean).join(" / ");
    return `${i.name}${variant ? ` (${variant})` : ""} x${i.qty} — ₮${(i.price * i.qty).toLocaleString()}`;
  }).join("\n") : "";
  await notifyOwner(orgId, "Шинэ захиалга", {
    Хэрэглэгч: customerName, Утас: customerPhone, Хаяг: deliveryAddress,
    Бараа: itemsSummary, "Нийт дүн": `₮${totalAmount?.toLocaleString()}`, Тэмдэглэл: notes,
  }, { label: "Захиалгаа харах", path: "/orders" });
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

  // Бизнесийн төрлөөс хамаарсан шошго (Эмч / Тогооч / Мастер ...)
  let staffKeyLabel = "Мастер";
  try {
    const bt = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key: "business_type" } } });
    const { getLabels } = require("../lib/businessType");
    staffKeyLabel = getLabels(bt?.value).staffLabel;
  } catch { /* fallback */ }
  await notifyOwner(orgId, "Шинэ цаг захиалга", {
    [staffKeyLabel]: staffName || staffId,
    Үйлчилгээ:   serviceName,
    Огноо:       `${date} ${timeSlot}`,
    Хэрэглэгч:   customerName,
    Утас:         customerPhone,
    Урьдчилгаа:  depositAmount > 0 ? `₮${depositAmount.toLocaleString()}` : undefined,
    Тэмдэглэл:   notes,
  }, { label: "Цагийн захиалга харах", path: "/appointments" });

  return { ...appt, qpayData };
}

module.exports = { saveLead, saveConsultation, saveOrder, saveAppointment };
