"use strict";
// Чатын харилцагчийн профайл (нэр + зураг)-ыг Graph API-аас татаж TuruuChat-д кэшлэнэ.
//
// profilePic нь Meta-ийн ТҮР ЗУУРЫН CDN URL (хэдэн цагийн дараа 403 өгдөг) тул:
//  - profileFetchedAt-аар шинэчлэлтийг хязгаарлаж (STALE_MS) Graph API-г дэмий давтахгүй;
//  - идэвхтэй яриа (шинэ мессеж) ирэх бүрт хугацаа хэтэрсэн бол дахин татаж URL-ыг шинэчилнэ;
//  - frontend талд зураг эвдэрвэл (onError) эхний үсгийн avatar руу гоёмсог шилжинэ.
const { getPrisma } = require("../lib/db");
const { decrypt } = require("../lib/secretCrypto");
const { getUserProfile } = require("./facebook.service");

// Профайлыг 6 цаг тутам л дахин татна (URL шинэлэг байлгах ба Graph API дуудлагыг хязгаарлах тэнцвэр).
const STALE_MS = 6 * 60 * 60 * 1000;

// Нэг харилцагчийн профайлыг шаардлагатай бол шинэчилнэ.
//  orgId, psid — шаардлагатай. token — байвал дахин decrypt хийхгүй (webhook-д аль хэдийн бий).
//  force — freshness шалгалтыг алгасаж заавал татна.
// Чимээгүй ажиллана: алдаа гарвал зөвхөн лог бичнэ, throw хийхгүй (fire-and-forget-д тохирсон).
async function refreshChatProfile(orgId, psid, { token = null, force = false } = {}) {
  if (!orgId || !psid) return;
  try {
    const prisma = getPrisma();
    const chat = await prisma.turuuChat.findUnique({
      where: { orgId_psid: { orgId, psid } },
      select: { name: true, profilePic: true, platform: true, profileFetchedAt: true },
    });
    // Чат хараахан үүсээгүй бол (мессеж боловсруулагдаагүй) хийх зүйлгүй — updateMany no-op болно.
    if (!chat) return;
    // Саяхан татсан бол (амжилттай ч бай, нэр олдоогүй ч бай) STALE_MS дуустал дахин татахгүй.
    if (!force && chat.profileFetchedAt &&
        Date.now() - new Date(chat.profileFetchedAt).getTime() < STALE_MS) return;

    let pageToken = token;
    if (!pageToken) {
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { fbPageToken: true },
      });
      if (!org?.fbPageToken) return;
      pageToken = decrypt(org.fbPageToken);
    }

    const prof = await getUserProfile(psid, pageToken, chat.platform || "facebook");
    // Оролдлогыг тэмдэглэхийн тулд profileFetchedAt-ыг үргэлж шинэчилнэ (нэр олдоогүй ч дахин
    // татахгүйн тулд). Нэр/зураг олдвол хадгална, эс бол хуучнаа хадгална.
    await prisma.turuuChat.updateMany({
      where: { orgId, psid },
      data: {
        name: prof?.name ?? chat.name ?? null,
        profilePic: prof?.profilePic ?? chat.profilePic ?? null,
        profileFetchedAt: new Date(),
      },
    });
  } catch (e) {
    console.error("[contact] profile refresh error:", e && e.message);
  }
}

module.exports = { refreshChatProfile };
