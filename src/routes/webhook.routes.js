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
      if (!order?.qpayInvoiceId || order.qpayStatus === "PAID") return;

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

      await prisma.storeOrder.update({
        where: { id: order.id },
        data: { qpayStatus: "PAID", status: "PAID" },
      });

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

// Subscription QPay callback — POST /webhook/sub-qpay/:orgId
router.post("/sub-qpay/:orgId", async (req, res) => {
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const prisma = getPrisma();
      const org = await prisma.organization.findUnique({
        where: { id: req.params.orgId },
        select: { id: true, subInvoiceId: true, subQpayStatus: true, name: true, telegramBotToken: true, telegramChatId: true },
      });
      if (!org?.subInvoiceId || org.subQpayStatus === "PAID") return;

      const subQpay = require("../services/subscription-qpay.service");
      const result = await subQpay.checkPayment(org.subInvoiceId);
      const paid = (result.count != null ? result.count > 0 : false) || result.payment_status === "PAID";
      if (!paid) return;

      // Subscription 1 сараар сунгана
      const now = new Date();
      const subscriptionEndsAt = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());

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

module.exports = router;
