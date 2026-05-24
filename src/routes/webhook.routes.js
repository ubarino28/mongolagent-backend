"use strict";
const express = require("express");
const { processMessage } = require("../services/ai.service");
const { sendText, sendTypingOn } = require("../services/facebook.service");
const { getPrisma } = require("../lib/db");

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

        if (event.message?.text) {
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

module.exports = router;
