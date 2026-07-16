"use strict";
const express = require("express");
const crypto = require("crypto");
const { processMessage, processImageMessage } = require("../services/ai.service");
const { sendText, sendTypingOn } = require("../services/facebook.service");
const { getPrisma } = require("../lib/db");
const { checkPayment } = require("../services/qpay.service");
const { rateLimit } = require("../middleware/rateLimit");
const telegram = require("../services/telegram.service");
const { applySubscriptionPayment, applyTopupPayment } = require("../services/payment.service");
const { decrypt } = require("../lib/secretCrypto");

const router = express.Router();

// Payment callback-уудыг нөөц (orderId/orgId)-оор нь тусад нь хязгаарлана — нэг invoice-ийн
// webhook-ийг мянга дахин дуудаж QPay checkPayment-ийг үнэгүй ачаалах abuse-аас сэргийлнэ.
// QPay жинхэнэ callback нэг invoice-д цөөн удаа л ирдэг тул 30/мин хангалттай.
const whLimit = rateLimit({ windowMs: 60_000, max: 30, key: (req) => `wh:${req.originalUrl.split("?")[0]}` });

if (!process.env.FB_APP_SECRET) {
  console.warn("[webhook] FB_APP_SECRET тохируулаагүй — Facebook webhook HMAC шалгалт идэвхгүй. Хуурамч webhook-оос сэргийлэхийн тулд тохируулна уу.");
}

const { timingEqual } = require("../lib/timingEqual");

// Facebook webhook-ийн X-Hub-Signature-256 (HMAC-SHA256) шалгана.
// FB_APP_SECRET тохируулаагүй бол алгасна (амьд интеграцыг эвдэхгүй) — тохируулсан бол ШАХНА.
function fbSignatureValid(req) {
  const appSecret = process.env.FB_APP_SECRET;
  if (!appSecret) return true;
  const sig = req.get("x-hub-signature-256");
  if (!sig || !sig.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret)
    .update(req.rawBody || Buffer.from(""))
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { return false; }
}

// QPay payment/check хариунаас бодит төлсөн дүн хүлээгдсэн дүнд хүрсэн эсэх.
// paid_amount тодорхойгүй (хуучин/өөр формат) бол блоклохгүй — статусаар шийднэ (false-negative-аас сэргийлнэ).
function paidEnough(result, expected) {
  const exp = Number(expected);
  if (!exp || exp <= 0) return true;
  const paid = Number(result?.paid_amount);
  if (!Number.isFinite(paid) || paid <= 0) return true;
  return paid + 1 >= exp; // 1₮ бөөрөнхийллийн зөрүү тэвчинэ
}

// Facebook webhook verification
router.get("/", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && timingEqual(token, process.env.FB_VERIFY_TOKEN)) {
    console.log("[webhook] verified ✅");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Incoming messages
router.post("/", (req, res) => {
  // Facebook-оос ирсэн эсэхийг HMAC-аар баталгаажуулна — хуурамч мессеж/AI-cost abuse-аас сэргийлнэ
  if (!fbSignatureValid(req)) return res.sendStatus(403);

  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);

  res.status(200).send("EVENT_RECEIVED");

  setImmediate(async () => {
    for (const entry of body.entry || []) {
      // entry.id нь Facebook Page ID — аль org-ийнх болохыг мэднэ
      const pageId = entry.id;
      let orgId = null;
      let pageToken = null;

      try {
        const prisma = getPrisma();
        const org = await prisma.organization.findUnique({ where: { fbPageId: pageId } });
        if (org) {
          orgId = org.id;
          pageToken = decrypt(org.fbPageToken);
        }
      } catch (err) {
        console.error("[webhook] org lookup error:", err.message);
      }

      for (const event of entry.messaging || []) {
        const psid = event.sender?.id;
        if (!psid) continue;
        if (event.message?.is_echo) {
          // Эзэн Messenger-ээс шууд хариулсан бол AI pause хийнэ
          // Echo-д sender.id = Page ID, recipient.id = хэрэглэгчийн PSID
          const recipientPsid = event.recipient?.id;
          if (recipientPsid && orgId) {
            try {
              const prisma = getPrisma();
              await prisma.turuuChat.updateMany({
                where: { psid: recipientPsid, orgId },
                data: { aiPaused: true },
              });
            } catch { /* non-blocking */ }
          }
          continue;
        }

        const token = pageToken || process.env.FB_PAGE_ACCESS_TOKEN;

        // Sticker → алгасна (хариу шаардлагагүй)
        if (event.message?.sticker_id) continue;

        // Voice message → speech-to-text (Whisper)
        const audioAttachment = event.message?.attachments?.find((a) => a.type === "audio");
        if (audioAttachment?.payload?.url) {
          try {
            const { transcribeAudio, convAllowed } = require("../services/ai.service");
            // Анти-спам: Whisper (төлбөртэй) дуудахаас өмнө throttle шалгана
            if (!convAllowed(orgId, psid)) continue;
            await sendTypingOn(psid, token);
            const transcript = await transcribeAudio(audioAttachment.payload.url);
            if (transcript) {
              const reply = await processMessage(psid, transcript, orgId);
              if (reply) await sendText(psid, reply, token);
            } else {
              await sendText(psid, "Уучлаарай, дуут мессежийг таниж чадсангүй. Текстээр бичнэ үү 🙏", token).catch(() => {});
            }
          } catch (err) {
            console.error("[webhook] voice error:", err.message);
            await sendText(psid, "Уучлаарай, дуут мессеж боловсруулахад алдаа гарлаа 😔", token).catch(() => {});
          }
          continue;
        }

        const imageAttachment = event.message?.attachments?.find((a) => a.type === "image");
        if (imageAttachment?.payload?.url) {
          try {
            await sendTypingOn(psid, token);
            const reply = await processImageMessage(psid, imageAttachment.payload.url, event.message?.text || "", orgId);
            if (reply) await sendText(psid, reply, token);
          } catch (err) {
            console.error("[webhook] image process error:", err.message);
            await sendText(psid, "Уучлаарай, техникийн алдаа гарлаа 😔 Дахин оролдоно уу.", token).catch(() => {});
          }
        } else if (event.message?.text) {
          try {
            await sendTypingOn(psid, token);
            const reply = await processMessage(psid, event.message.text, orgId);
            if (reply) await sendText(psid, reply, token);
          } catch (err) {
            console.error("[webhook] process error:", err.message);
            await sendText(psid, "Уучлаарай, техникийн алдаа гарлаа 😔 Дахин оролдоно уу.", token).catch(() => {});
          }
        }

        if (event.postback?.payload) {
          try {
            await sendTypingOn(psid, token);
            const reply = await processMessage(psid, event.postback.title || event.postback.payload, orgId);
            if (reply) await sendText(psid, reply, token);
          } catch (err) {
            console.error("[webhook] postback error:", err.message);
          }
        }
      }
    }
  });
});

// QPay payment callback — POST /webhook/qpay/:orderId
router.post("/qpay/:orderId", whLimit, async (req, res) => {
  // QPay-д хурдан 200 хариулна
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const prisma = getPrisma();
      const order = await prisma.turuuOrder.findUnique({ where: { id: req.params.orderId } });
      if (!order?.qpayInvoiceId || order.qpayStatus === "PAID" || order.qpayStatus === "CANCELLED" || order.status === "PAID") return;

      const result = await checkPayment(order.qpayInvoiceId);
      const paid = result.invoice_status === "PAID";
      if (!paid) return;
      // Төлсөн дүн захиалгын дүнд хүрээгүй бол PAID болгохгүй (доогуур төлөлтөөс сэргийлнэ)
      if (!paidEnough(result, order.totalAmount)) {
        console.warn(`[QPay] Order ${order.id} underpaid — paid_amount=${result.paid_amount}, expected=${order.totalAmount}`);
        return;
      }

      // Идемпотент — зөвхөн PENDING→PAID шилжүүлсэн ганц хүсэлт цааш үргэлжилнэ (давхар мэдэгдэлгүй)
      const upd = await prisma.turuuOrder.updateMany({
        where: { id: order.id, qpayStatus: { not: "PAID" }, status: { not: "PAID" } },
        data: { qpayStatus: "PAID", status: "PAID", paymentMethod: "qpay" },
      });
      if (upd.count !== 1) return;

      // Telegram мэдэгдэл
      if (order.orgId) {
        try {
          const text = `✅ QPay төлбөр хийгдлээ!\nЗахиалга #${order.id.slice(-6).toUpperCase()}\nДүн: ₮${Number(order.totalAmount || 0).toLocaleString()}\nХэрэглэгч: ${order.customerName || "—"}`;
          await telegram.notifyText(order.orgId, text);
        } catch { /* non-blocking */ }
      }

      // Facebook Messenger-д баталгаажуулалт явуулах
      if (order.psid && order.orgId) {
        try {
          const org = await prisma.organization.findUnique({
            where: { id: order.orgId },
            select: { fbPageToken: true },
          });
          const token = decrypt(org?.fbPageToken) || process.env.FB_PAGE_ACCESS_TOKEN;
          if (token) {
            await sendText(
              order.psid,
              `✅ Таны төлбөр амжилттай хийгдлээ! Захиалга #${order.id.slice(-6).toUpperCase()} батлагдлаа. Тантай удахгүй холбогдно 🙏`,
              token
            ).catch(() => {});
          }
        } catch { /* non-blocking */ }
      }

      console.log(`[QPay] Order ${order.id} PAID`);
    } catch (err) {
      console.error("[QPay callback]", err.message);
    }
  });
});

// Store (website builder) QPay callback — POST /webhook/qpay-store/:orderId
router.post("/qpay-store/:orderId", whLimit, async (req, res) => {
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const prisma = getPrisma();
      const order = await prisma.storeOrder.findUnique({ where: { id: req.params.orderId } });
      if (!order?.qpayInvoiceId || order.qpayStatus === "PAID") return;

      const result = await checkPayment(order.qpayInvoiceId);
      if (result.invoice_status !== "PAID") return;
      if (!paidEnough(result, order.totalAmount)) {
        console.warn(`[QPay-store] Order ${order.id} underpaid — paid_amount=${result.paid_amount}, expected=${order.totalAmount}`);
        return;
      }

      // Идемпотент — нөөц/купон зөвхөн нэг удаа. Аль хэдийн боловсруулсан бол давхар мэдэгдэхгүй.
      const { markStoreOrderPaid } = require("../services/payment.service");
      const newlyPaid = await markStoreOrderPaid(prisma, order);
      if (!newlyPaid) return;

      // Telegram мэдэгдэл
      try {
        const text = `🛒 Дэлгүүрийн захиалга төлөгдлөө!\nЗахиалга #${order.id.slice(-6).toUpperCase()}\nДүн: ₮${Number(order.totalAmount || 0).toLocaleString()}\nХэрэглэгч: ${order.customerName || "—"}\nУтас: ${order.customerPhone || "—"}`;
        await telegram.notifyText(order.orgId, text);
      } catch { /* non-blocking */ }

      console.log(`[QPay-store] Order ${order.id} PAID`);
    } catch (err) {
      console.error("[QPay-store callback]", err.message);
    }
  });
});

// Appointment QPay callback — POST /webhook/qpay-appointment/:appointmentId
router.post("/qpay-appointment/:appointmentId", whLimit, async (req, res) => {
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const prisma = getPrisma();
      const appt = await prisma.turuuAppointment.findUnique({
        where: { id: req.params.appointmentId },
        include: { staff: { select: { name: true } } },
      });
      if (!appt?.qpayInvoiceId || appt.depositStatus === "PAID") return;

      const result = await checkPayment(appt.qpayInvoiceId);
      const paid = result.invoice_status === "PAID";
      if (!paid) return;
      if (!paidEnough(result, appt.depositAmount)) {
        console.warn(`[QPay] Appointment ${appt.id} underpaid — paid_amount=${result.paid_amount}, expected=${appt.depositAmount}`);
        return;
      }

      // Идемпотент — зөвхөн анхны шилжилт цааш үргэлжилнэ (давхар мэдэгдэлгүй)
      const updAppt = await prisma.turuuAppointment.updateMany({
        where: { id: appt.id, depositStatus: { not: "PAID" } },
        data: { qpayStatus: "PAID", depositStatus: "PAID", status: "CONFIRMED" },
      });
      if (updAppt.count !== 1) return;

      // Telegram мэдэгдэл
      if (appt.orgId) {
        try {
          const text = `✅ Урьдчилгаа төлөгдлөө!\n${appt.staff?.name || "—"} · ${appt.serviceName}\n📅 ${appt.date} ${appt.timeSlot}\n💰 ₮${Number(appt.depositAmount || 0).toLocaleString()}\n👤 ${appt.customerName || "—"}`;
          await telegram.notifyText(appt.orgId, text);
        } catch { /* non-blocking */ }
      }

      // Facebook Messenger баталгаажуулалт
      if (appt.psid && appt.orgId) {
        try {
          const org = await prisma.organization.findUnique({
            where: { id: appt.orgId },
            select: { fbPageToken: true },
          });
          const token = decrypt(org?.fbPageToken) || process.env.FB_PAGE_ACCESS_TOKEN;
          if (token) {
            await sendText(
              appt.psid,
              `✅ Урьдчилгаа ₮${Number(appt.depositAmount || 0).toLocaleString()} амжилттай төлөгдлөө!\n\n📅 ${appt.date} ${appt.timeSlot}\n💆 ${appt.staff?.name || "—"}\n✂️ ${appt.serviceName}\n\nЦаг захиалга баталгаажлаа! Тантай тухайн цагт уулзана 🙏`,
              token
            ).catch(() => {});
          }
        } catch { /* non-blocking */ }
      }

      console.log(`[QPay] Appointment ${appt.id} deposit PAID`);
    } catch (err) {
      console.error("[QPay appointment callback]", err.message);
    }
  });
});

// Subscription QPay callback — POST /webhook/sub-qpay/:orgId
router.post("/sub-qpay/:orgId", whLimit, async (req, res) => {
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const prisma = getPrisma();
      const org = await prisma.organization.findUnique({
        where: { id: req.params.orgId },
        select: { id: true, subInvoiceId: true, subQpayStatus: true, subscriptionEndsAt: true, name: true, telegramBotToken: true, telegramChatId: true },
      });
      if (!org?.subInvoiceId || org.subQpayStatus === "PAID") return;

      const subQpay = require("../services/subscription-qpay.service");
      const result = await subQpay.checkPayment(org.subInvoiceId);
      const paid = (result.count != null ? result.count > 0 : false) || result.payment_status === "PAID";
      if (!paid) return;

      // Subscription 30 хоногоор сунгана — webhook болон polling-check нэг л shared helper
      // ашиглана (логик хоёр тийш салахаас сэргийлнэ). Идемпотент: зөвхөн ЭНЭ invoice-ийг
      // боловсруулсан ганц хүсэлт count=1 авна.
      const { applied, subscriptionEndsAt } = await applySubscriptionPayment(prisma, org);
      if (!applied) return;

      // Telegram мэдэгдэл — платформ admin-д (env бот). notifyText(null) → платформын env ашиглана.
      try {
        const text = `💰 Subscription төлбөр хийгдлээ!\nКлиент: ${org.name}\nДуусах огноо: ${subscriptionEndsAt.toLocaleDateString("mn-MN")}`;
        await telegram.notifyText(null, text);
      } catch { /* non-blocking */ }

      console.log(`[SubQPay] Org ${org.id} subscription renewed`);
    } catch (err) {
      console.error("[SubQPay callback]", err.message);
    }
  });
});

// Message top-up QPay callback — POST /webhook/topup-qpay/:orgId
// pending_topup (TuruuSettings) нь { invoiceId, units, amount } хадгална. Tab хаагдсан ч
// webhook нэмэлт message credit-ийг ИДЕМПОТЕНТоор бүртгэнэ (polling /topup/check-тэй зөрчилгүй —
// applyTopupPayment delete-as-mutex-ээр давхар нэмэхээс сэргийлнэ).
router.post("/topup-qpay/:orgId", whLimit, async (req, res) => {
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const prisma = getPrisma();
      const orgId = req.params.orgId;
      const s = await prisma.turuuSettings.findUnique({ where: { orgId_key: { orgId, key: "pending_topup" } } });
      if (!s || !s.value) return;
      let pending;
      try { pending = JSON.parse(s.value); } catch { return; }
      if (!pending.invoiceId) return;

      const subQpay = require("../services/subscription-qpay.service");
      const result = await subQpay.checkPayment(pending.invoiceId);
      const paid = (result.count != null ? result.count > 0 : false) || result.payment_status === "PAID" || result.invoice_status === "PAID";
      if (!paid) return;
      if (!paidEnough(result, pending.amount)) {
        console.warn(`[TopupQPay] Org ${orgId} underpaid — paid_amount=${result.paid_amount}, expected=${pending.amount}`);
        return;
      }

      const { applied, added } = await applyTopupPayment(prisma, orgId);
      if (applied) console.log(`[TopupQPay] Org ${orgId} +${added} message credit`);
    } catch (err) {
      console.error("[TopupQPay callback]", err.message);
    }
  });
});

// Template purchase QPay callback — POST /webhook/template-qpay/:orgId/:templateId
router.post("/template-qpay/:orgId/:templateId", whLimit, async (req, res) => {
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const prisma = getPrisma();
      const { orgId, templateId } = req.params;
      const purchase = await prisma.templatePurchase.findUnique({
        where: { orgId_templateId: { orgId, templateId } },
      });
      if (!purchase?.invoiceId || purchase.status === "PAID") return;

      const subQpay = require("../services/subscription-qpay.service");
      const result = await subQpay.checkPayment(purchase.invoiceId);
      const paid = (result.count != null ? result.count > 0 : false) || result.payment_status === "PAID" || result.invoice_status === "PAID";
      if (!paid) return;
      if (!paidEnough(result, purchase.amount)) {
        console.warn(`[TemplateQPay] ${orgId}/${templateId} underpaid — paid_amount=${result.paid_amount}, expected=${purchase.amount}`);
        return;
      }

      const updTpl = await prisma.templatePurchase.updateMany({
        where: { orgId, templateId, status: { not: "PAID" } },
        data: { status: "PAID" },
      });
      if (updTpl.count !== 1) return;
      console.log(`[TemplateQPay] Org ${orgId} purchased template ${templateId}`);
    } catch (err) {
      console.error("[TemplateQPay callback]", err.message);
    }
  });
});

// Website wallet topup QPay callback — POST /webhook/web-wallet/:orgId
router.post("/web-wallet/:orgId", whLimit, async (req, res) => {
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const prisma = getPrisma();
      // Callback зөвхөн orgId өгдөг тул бүх PENDING топапыг ӨӨР ӨӨРИЙН invoice-оор шалгана.
      // → буруу tx-д буруу дүн орохоос сэргийлнэ (өмнө "хамгийн сүүлийн pending"-ийг авдаг байсан).
      const subQpay = require("../services/subscription-qpay.service");
      const { applyWalletTopup } = require("../services/payment.service");
      const txs = await prisma.webWalletTx.findMany({
        where: { orgId: req.params.orgId, qpayStatus: "PENDING", type: "topup" },
      });
      for (const tx of txs) {
        if (!tx.qpayInvoiceId) continue;
        const result = await subQpay.checkPayment(tx.qpayInvoiceId);
        const paid = (result.count != null ? result.count > 0 : false) || result.payment_status === "PAID";
        if (paid && paidEnough(result, tx.amount) && await applyWalletTopup(prisma, tx)) {
          console.log(`[WebWallet] Org ${req.params.orgId} topped up ${tx.amount}₮`);
        }
      }
    } catch (err) {
      console.error("[WebWallet callback]", err.message);
    }
  });
});

// Domain purchase QPay callback — POST /webhook/domain-qpay/:orgId
// createDomainInvoice нь энэ URL-ийг callback болгож өгдөг. Өмнө энэ route байхгүй
// байсан тул tab хаагдвал төлбөр авагдсан ч домэйн БҮРТГЭГДДЭГГҮЙ байв.
// Одоо webhook домэйнг сервер талд ИДЕМПОТЕНТоор бүртгэнэ (polling-той зөрчилгүй).
router.post("/domain-qpay/:orgId", whLimit, async (req, res) => {
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const prisma = getPrisma();
      const subQpay = require("../services/subscription-qpay.service");
      const vdomains = require("../services/vercelDomains.service");
      const vercel = require("../services/vercel.service");
      const { fulfillDomainOrder } = require("../services/domain.service");

      // Callback зөвхөн orgId өгдөг тул бүх pending домэйн захиалгыг ӨӨР ӨӨРИЙН invoice-оор шалгана
      const orders = await prisma.domainOrder.findMany({
        where: { orgId: req.params.orgId, status: "pending" },
      });
      for (const order of orders) {
        if (!order.qpayInvoiceId) continue;
        const result = await subQpay.checkPayment(order.qpayInvoiceId);
        const paid = (result.count != null ? result.count > 0 : false) || result.payment_status === "PAID" || result.invoice_status === "PAID";
        if (!paid) continue;
        if (!paidEnough(result, order.priceMnt)) {
          console.warn(`[Domain] Order ${order.id} underpaid — paid_amount=${result.paid_amount}, expected=${order.priceMnt}`);
          continue;
        }
        const r = await fulfillDomainOrder(prisma, { vdomains, vercel }, order);
        console.log(`[Domain] Org ${req.params.orgId} domain ${order.domain} → ${r.status}`);
      }
    } catch (err) {
      console.error("[Domain callback]", err.message);
    }
  });
});

module.exports = router;
