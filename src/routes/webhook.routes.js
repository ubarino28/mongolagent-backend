"use strict";
const express = require("express");
const { processMessage, processImageMessage } = require("../services/ai.service");
const { sendText, sendTypingOn } = require("../services/facebook.service");
const { getPrisma } = require("../lib/db");
const { checkPayment } = require("../services/qpay.service");

const router = express.Router();

// Facebook webhook verification
router.get("/", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.FB_VERIFY_TOKEN) {
    console.log("[webhook] verified ✅");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Incoming messages
router.post("/", (req, res) => {
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
          pageToken = org.fbPageToken;
        }
      } catch (err) {
        console.error("[webhook] org lookup error:", err.message);
      }

      for (const event of entry.messaging || []) {
        const psid = event.sender?.id;
        if (!psid) continue;
        if (event.message?.is_echo) continue;

        const token = pageToken || process.env.FB_PAGE_ACCESS_TOKEN;

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
router.post("/qpay/:orderId", async (req, res) => {
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

      await prisma.turuuOrder.update({
        where: { id: order.id },
        data: { qpayStatus: "PAID", status: "PAID" },
      });

      // Telegram мэдэгдэл
      if (order.orgId) {
        try {
          const org = await prisma.organization.findUnique({
            where: { id: order.orgId },
            select: { telegramBotToken: true, telegramChatId: true },
          });
          const botToken = org?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
          const chatId = org?.telegramChatId || process.env.TELEGRAM_CHAT_ID;
          if (botToken && chatId) {
            const axios = require("axios");
            const text = `✅ QPay төлбөр хийгдлээ!\nЗахиалга #${order.id.slice(-6).toUpperCase()}\nДүн: ₮${Number(order.totalAmount || 0).toLocaleString()}\nХэрэглэгч: ${order.customerName || "—"}`;
            await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text }).catch(() => {});
          }
        } catch { /* non-blocking */ }
      }

      // Facebook Messenger-д баталгаажуулалт явуулах
      if (order.psid && order.orgId) {
        try {
          const org = await prisma.organization.findUnique({
            where: { id: order.orgId },
            select: { fbPageToken: true },
          });
          const token = org?.fbPageToken || process.env.FB_PAGE_ACCESS_TOKEN;
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
router.post("/qpay-store/:orderId", async (req, res) => {
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const prisma = getPrisma();
      const order = await prisma.storeOrder.findUnique({ where: { id: req.params.orderId } });
      if (!order?.qpayInvoiceId || order.qpayStatus === "PAID") return;

      const result = await checkPayment(order.qpayInvoiceId);
      if (result.invoice_status !== "PAID") return;

      // Идемпотент — нөөц/купон зөвхөн нэг удаа. Аль хэдийн боловсруулсан бол давхар мэдэгдэхгүй.
      const { markStoreOrderPaid } = require("../services/payment.service");
      const newlyPaid = await markStoreOrderPaid(prisma, order);
      if (!newlyPaid) return;

      // Telegram мэдэгдэл
      try {
        const org = await prisma.organization.findUnique({
          where: { id: order.orgId },
          select: { telegramBotToken: true, telegramChatId: true },
        });
        const botToken = org?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
        const chatId = org?.telegramChatId || process.env.TELEGRAM_CHAT_ID;
        if (botToken && chatId) {
          const axios = require("axios");
          const text = `🛒 Дэлгүүрийн захиалга төлөгдлөө!\nЗахиалга #${order.id.slice(-6).toUpperCase()}\nДүн: ₮${Number(order.totalAmount || 0).toLocaleString()}\nХэрэглэгч: ${order.customerName || "—"}\nУтас: ${order.customerPhone || "—"}`;
          await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text }).catch(() => {});
        }
      } catch { /* non-blocking */ }

      console.log(`[QPay-store] Order ${order.id} PAID`);
    } catch (err) {
      console.error("[QPay-store callback]", err.message);
    }
  });
});

// Appointment QPay callback — POST /webhook/qpay-appointment/:appointmentId
router.post("/qpay-appointment/:appointmentId", async (req, res) => {
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

      await prisma.turuuAppointment.update({
        where: { id: appt.id },
        data: { qpayStatus: "PAID", depositStatus: "PAID", status: "CONFIRMED" },
      });

      // Telegram мэдэгдэл
      if (appt.orgId) {
        try {
          const org = await prisma.organization.findUnique({
            where: { id: appt.orgId },
            select: { telegramBotToken: true, telegramChatId: true },
          });
          const botToken = org?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
          const chatId = org?.telegramChatId || process.env.TELEGRAM_CHAT_ID;
          if (botToken && chatId) {
            const axios = require("axios");
            const text = `✅ Урьдчилгаа төлөгдлөө!\n${appt.staff?.name || "—"} · ${appt.serviceName}\n📅 ${appt.date} ${appt.timeSlot}\n💰 ₮${Number(appt.depositAmount || 0).toLocaleString()}\n👤 ${appt.customerName || "—"}`;
            await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text }).catch(() => {});
          }
        } catch { /* non-blocking */ }
      }

      // Facebook Messenger баталгаажуулалт
      if (appt.psid && appt.orgId) {
        try {
          const org = await prisma.organization.findUnique({
            where: { id: appt.orgId },
            select: { fbPageToken: true },
          });
          const token = org?.fbPageToken || process.env.FB_PAGE_ACCESS_TOKEN;
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
router.post("/sub-qpay/:orgId", async (req, res) => {
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

      // Subscription 30 хоногоор сунгана — ҮЛДСЭН хугацаан дээр нэмж стэклэнэ (эрт төлвөл хохирохгүй),
      // сарын төгсгөлийн (1-р сарын 31 → 3-р сар) үсрэлтийн алдааг 30-хоногийн нэмэлтээр арилгана.
      const now = new Date();
      const base = org.subscriptionEndsAt && new Date(org.subscriptionEndsAt) > now ? new Date(org.subscriptionEndsAt) : now;
      const subscriptionEndsAt = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);

      await prisma.organization.update({
        where: { id: org.id },
        data: { subQpayStatus: "PAID", subscriptionEndsAt, status: "active", subInvoiceId: null },
      });

      // Telegram мэдэгдэл — платформ admin-д
      try {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId   = process.env.TELEGRAM_CHAT_ID;
        if (botToken && chatId) {
          const axios = require("axios");
          const text = `💰 Subscription төлбөр хийгдлээ!\nКлиент: ${org.name}\nДуусах огноо: ${subscriptionEndsAt.toLocaleDateString("mn-MN")}`;
          await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text }).catch(() => {});
        }
      } catch { /* non-blocking */ }

      console.log(`[SubQPay] Org ${org.id} subscription renewed`);
    } catch (err) {
      console.error("[SubQPay callback]", err.message);
    }
  });
});

// Website wallet topup QPay callback — POST /webhook/web-wallet/:orgId
router.post("/web-wallet/:orgId", async (req, res) => {
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
        if (paid && await applyWalletTopup(prisma, tx)) {
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
router.post("/domain-qpay/:orgId", async (req, res) => {
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
        const r = await fulfillDomainOrder(prisma, { vdomains, vercel }, order);
        console.log(`[Domain] Org ${req.params.orgId} domain ${order.domain} → ${r.status}`);
      }
    } catch (err) {
      console.error("[Domain callback]", err.message);
    }
  });
});

module.exports = router;
