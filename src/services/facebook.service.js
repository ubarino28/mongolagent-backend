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

// Хэрэглэгчийн профайл (нэр + зураг) Graph API-аас татна.
//  - Facebook: first_name/last_name/profile_pic
//  - Instagram: name/username/profile_pic
// pages_messaging эрх шаардлагатай ба ЗӨВХӨН тухайн хуудсанд бичсэн хүний мэдээллийг л буцаадаг.
// Нэр татаж чадахгүй (нууцлалтай хэрэглэгч / шинэ PSID / эрхгүй токен) бол Graph 400 өгдөг тул null буцаана.
async function getUserProfile(psid, pageToken, platform = "facebook") {
  const token = pageToken || process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token || !psid) return null;
  const fields = platform === "instagram"
    ? "name,username,profile_pic"
    : "first_name,last_name,profile_pic";
  try {
    const { data } = await axios.get(`https://graph.facebook.com/v19.0/${encodeURIComponent(psid)}`, {
      params: { fields, access_token: token },
      timeout: 8000,
    });
    const name = platform === "instagram"
      ? (data.name || data.username || "").trim()
      : [data.first_name, data.last_name].filter(Boolean).join(" ").trim();
    const profilePic = typeof data.profile_pic === "string" ? data.profile_pic : null;
    if (!name && !profilePic) return null;
    return { name: name || null, profilePic };
  } catch (err) {
    // Чимээгүй null — нэр татагдахгүй нь хэвийн (нууцлал/шинэ хэрэглэгч)
    return null;
  }
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

module.exports = { sendText, sendTypingOn, getUserProfile };
