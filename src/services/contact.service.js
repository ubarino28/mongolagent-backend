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
async function refreshChatProfile(orgId, psid, { token = null, force = false, platform = null } = {}) {
  if (!orgId || !psid) return;
  try {
    const prisma = getPrisma();
    const chat = await prisma.turuuChat.findUnique({
      where: { orgId_psid: { orgId, psid } },
      select: { name: true, profilePic: true, platform: true, profileFetchedAt: true },
    });
    // Чат хараахан үүсээгүй бол (мессеж боловсруулагдаагүй) хийх зүйлгүй — updateMany no-op болно.
    if (!chat) return;
    // platform дамжуулсан ба хадгалагдсанаас ЗӨРВӨЛ (жишээ: IG чат default "facebook" гэж
    // буруу шошголсон) → freshness алгасаж, зөв талбараар заавал дахин татна.
    const mislabeled = platform && chat.platform !== platform;
    // Саяхан татсан бол (амжилттай ч бай, нэр олдоогүй ч бай) STALE_MS дуустал дахин татахгүй.
    if (!force && !mislabeled && chat.profileFetchedAt &&
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

    // Instagram vs Facebook профайлын талбар өөр (IG: name/username, FB: first_name/last_name).
    // Webhook-оос дамжсан platform давуу — эс бол хадгалагдсанаа ашиглана.
    const effectivePlatform = platform || chat.platform || "facebook";
    const prof = await getUserProfile(psid, pageToken, effectivePlatform);
    // Оролдлогыг тэмдэглэхийн тулд profileFetchedAt-ыг үргэлж шинэчилнэ (нэр олдоогүй ч дахин
    // татахгүйн тулд). Нэр/зураг олдвол хадгална, эс бол хуучнаа хадгална.
    await prisma.turuuChat.updateMany({
      where: { orgId, psid },
      data: {
        name: prof?.name ?? chat.name ?? null,
        profilePic: prof?.profilePic ?? chat.profilePic ?? null,
        profileFetchedAt: new Date(),
        // platform дамжуулсан бол чатын шошгыг зөв болгоно (IG чат "facebook" default-аас засна).
        ...(platform ? { platform } : {}),
      },
    });
  } catch (e) {
    console.error("[contact] profile refresh error:", e && e.message);
  }
}

module.exports = { refreshChatProfile };
