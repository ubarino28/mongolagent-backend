"use strict";
const express = require("express");
const { processMessage } = require("../services/ai.service");
const { sendText, sendTypingOn } = require("../services/facebook.service");

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

  // Facebook 5 секундийн дотор 200 хариу хүлээнэ
  res.status(200).send("EVENT_RECEIVED");

  // Async-аар боловсруулна
  setImmediate(async () => {
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const psid = event.sender?.id;
        if (!psid) continue;

        // Echo (манай page-ийн мессеж) алгасна
        if (event.message?.is_echo) continue;

        // Текст мессеж
        if (event.message?.text) {
          try {
            await sendTypingOn(psid);
            const reply = await processMessage(psid, event.message.text);
            if (reply) await sendText(psid, reply);
          } catch (err) {
            console.error("[webhook] process error:", err.message);
            await sendText(psid, "Уучлаарай, техникийн алдаа гарлаа 😔 Дахин оролдоно уу.").catch(() => {});
          }
        }

        // Postback (button click)
        if (event.postback?.payload) {
          try {
            await sendTypingOn(psid);
            const reply = await processMessage(psid, event.postback.title || event.postback.payload);
            if (reply) await sendText(psid, reply);
          } catch (err) {
            console.error("[webhook] postback error:", err.message);
          }
        }
      }
    }
  });
});

module.exports = router;
