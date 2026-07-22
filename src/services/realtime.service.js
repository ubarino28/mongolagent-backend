"use strict";
// Supabase Realtime Broadcast — Inbox-ийн шинэ мессежийг дашбордад АГШИН ЗУУР түлхнэ (polling-гүй).
//
// Backend нь Supabase-ийн broadcast HTTP endpoint рүү нэг POST хийнэ (байнгын WebSocket холболт
// backend талд хэрэггүй). Frontend нь "org:{orgId}" сувгийг сонсоод дохио ирэхэд Inbox-оо шинэчилнэ.
//
// АЮУЛГҮЙ БАЙДАЛ: дохио дотор НУУЦ ӨГӨГДӨЛ БАЙХГҮЙ — зөвхөн "шинэчил" дохио (psid). Жинхэнэ
// ярианы агуулга нь тухайн мерчантын JWT-ээр хамгаалагдсан API-аас л татагдана. Сувгийн нэр нь
// orgId (UUID, таамаглах боломжгүй) агуулна.
const axios = require("axios");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Fire-and-forget: хэзээ ч throw хийхгүй (дотроо catch хийнэ) тул await шаардлагагүй.
// Realtime унасан ч Inbox-ийн polling fallback ажиллаж байгаа тул мессеж алдагдахгүй.
async function broadcastInbox(orgId, psid = null) {
  if (!orgId || !SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await axios.post(
      `${SUPABASE_URL}/realtime/v1/api/broadcast`,
      { messages: [{ topic: `org:${orgId}`, event: "inbox", payload: { psid } }] },
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 5000,
      }
    );
  } catch (e) {
    if (process.env.DEBUG_REALTIME) console.error("[realtime] broadcast error:", e.response?.status, e.message);
  }
}

module.exports = { broadcastInbox };
