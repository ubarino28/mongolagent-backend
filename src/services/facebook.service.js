"use strict";
const axios = require("axios");

const GRAPH_URL = "https://graph.facebook.com/v19.0/me/messages";

async function sendText(psid, text, pageToken) {
  const token = pageToken || process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) return console.error("[FB] FB_PAGE_ACCESS_TOKEN тохируулаагүй");

  const chunks = splitMessage(text, 1900);
  for (const chunk of chunks) {
    await axios.post(
      GRAPH_URL,
      { recipient: { id: psid }, message: { text: chunk } },
      { params: { access_token: token } }
    ).catch(err => console.error("[FB] send error:", err.response?.data || err.message));
  }
}

async function sendTypingOn(psid, pageToken) {
  const token = pageToken || process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) return;
  await axios.post(
    GRAPH_URL,
    { recipient: { id: psid }, sender_action: "typing_on" },
    { params: { access_token: token } }
  ).catch(() => {});
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > i) end = lastNewline + 1;
    }
    parts.push(text.slice(i, end).trim());
    i = end;
  }
  return parts.filter(Boolean);
}

module.exports = { sendText, sendTypingOn };
