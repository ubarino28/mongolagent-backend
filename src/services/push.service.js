"use strict";
// Гар утасны апп руу Expo push notification илгээх НЭГ цэг.
// Expo-гийн push үйлчилгээ (https://exp.host/--/api/v2/push/send) ашиглана — FCM/APNs
// түлхүүр шаардахгүй, Expo дамжуулагчаар дамжина.
//
// Зарчим: notify.service.js-тэй адил ТУСЛАХ урсгал. Token байхгүй, сүлжээ унасан,
// эсвэл Expo алдаа буцаасан ч ҮНДСЭН үйлдэл (захиалга үүсгэх г.м) хэзээ ч унахгүй.
const { getPrisma } = require("../lib/db");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Expo push token эсэхийг шалгана (ExponentPushToken[...] эсвэл ExpoPushToken[...]).
function isExpoToken(t) {
  return typeof t === "string" && /^Expo(nent)?PushToken\[/.test(t.trim());
}

// Төхөөрөмжийн token хадгална. Нэг token нэг л мөр (unique). Хэрэв өөр байгууллагад
// бүртгэлтэй байсан бол шинэ эзэн рүү шилжүүлнэ (нэг утаснаас өөр account руу нэвтэрсэн).
async function registerToken(orgId, token, platform) {
  if (!orgId || !isExpoToken(token)) return false;
  try {
    const prisma = getPrisma();
    await prisma.pushToken.upsert({
      where: { token: token.trim() },
      create: { orgId, token: token.trim(), platform: platform || null },
      update: { orgId, platform: platform || null, updatedAt: new Date() },
    });
    return true;
  } catch (e) {
    console.error("[push] registerToken:", e && e.message);
    return false;
  }
}

async function removeToken(token) {
  if (!token) return false;
  try {
    await getPrisma().pushToken.deleteMany({ where: { token: String(token).trim() } });
    return true;
  } catch (e) {
    console.error("[push] removeToken:", e && e.message);
    return false;
  }
}

// Байгууллагын бүх төхөөрөмж рүү push илгээнэ. Хэзээ ч алдаа шидэхгүй.
// opts: { title, body, sound, channelId, data }
async function sendPushToOrg(orgId, opts = {}) {
  try {
    if (!orgId || typeof fetch !== "function") return false;
    const prisma = getPrisma();
    const rows = await prisma.pushToken.findMany({ where: { orgId }, select: { token: true } });
    const tokens = rows.map((r) => r.token).filter(isExpoToken);
    if (tokens.length === 0) return false;

    const messages = tokens.map((to) => ({
      to,
      title: opts.title || "Mongol Agent",
      body: opts.body || "",
      sound: opts.sound || "default", // iOS custom дуу нь bundled файлын нэр (ж: "kaching.wav")
      channelId: opts.channelId || "default", // Android дуу нь channel-аар сонгогдоно
      priority: "high",
      data: opts.data || {},
    }));

    // Expo нэг хүсэлтэд 100 хүртэл мессеж авдаг — 100-аар хэсэглэнэ
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const resp = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(chunk),
      });
      const json = await resp.json().catch(() => null);
      // Идэвхгүй болсон token-уудыг цэвэрлэнэ (DeviceNotRegistered)
      const receipts = json && Array.isArray(json.data) ? json.data : [];
      for (let j = 0; j < receipts.length; j++) {
        const r = receipts[j];
        if (r && r.status === "error" && r.details && r.details.error === "DeviceNotRegistered") {
          await removeToken(chunk[j].to).catch(() => {});
        }
      }
    }
    return true;
  } catch (e) {
    console.error("[push] sendPushToOrg:", e && e.message);
    return false;
  }
}

module.exports = { registerToken, removeToken, sendPushToOrg, isExpoToken };
