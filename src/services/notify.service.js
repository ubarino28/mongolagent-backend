"use strict";
// Мерчант рүү илгээх мэдэгдлийн НЭГ цэг (и-мэйл).
// Өмнө нь энэ үүргийг telegram.service.js гүйцэтгэдэг байсан — Telegram-ыг бүрэн
// хассан тул шинэ lead/захиалга/квотын сэрэмжлүүлгийг байгууллагын бүртгэлтэй
// и-мэйл рүү илгээнэ.
//
// Зарчим: мэдэгдэл бол ТУСЛАХ урсгал. RESEND_API_KEY тохируулаагүй, и-мэйл олдоогүй,
// эсвэл илгээлт амжилтгүй болсон ч ҮНДСЭН үйлдэл (захиалга үүсгэх г.м) хэзээ ч унахгүй.
const { Resend } = require("resend");
const { getPrisma } = require("../lib/db");

const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@mongolagent.mn";
const APP_URL = process.env.APP_URL || "https://app.mongolagent.mn";

// RESEND_API_KEY байхгүй бол Resend-ийг үүсгэхгүй → бүх илгээлт чимээгүй no-op болно.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Байгууллагын мэдэгдэл хүлээн авах и-мэйл. Одоогоор бүртгэлийн и-мэйл.
async function getOwnerEmail(orgId) {
  if (!orgId) return null;
  try {
    const org = await getPrisma().organization.findUnique({
      where: { id: orgId },
      select: { email: true },
    });
    return org?.email || null;
  } catch {
    return null;
  }
}

// HTML тарилгаас сэргийлж утгыг escape хийнэ (хэрэглэгчийн бичсэн нэр/тэмдэглэл
// шууд и-мэйлийн HTML рүү ордог тул заавал).
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function renderEmail(title, rows, ctaLabel, ctaPath) {
  const body = Object.entries(rows)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `
      <tr>
        <td style="padding:8px 0;color:#94a3b8;font-size:13px;vertical-align:top;white-space:nowrap">${esc(k)}</td>
        <td style="padding:8px 0 8px 16px;color:#f1f5f9;font-size:14px;white-space:pre-wrap">${esc(v)}</td>
      </tr>`)
    .join("");

  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#07070e;color:#f1f5f9;border-radius:12px">
      <div style="margin-bottom:24px">
        <span style="font-size:20px;font-weight:800;color:#818cf8">Mongol</span>
        <span style="font-size:20px;font-weight:800;color:#94a3b8">Agent</span>
      </div>
      <h2 style="font-size:18px;font-weight:700;margin-bottom:16px;color:#f1f5f9">${esc(title)}</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">${body}</table>
      ${ctaLabel ? `
        <a href="${APP_URL}${ctaPath || ""}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600">${esc(ctaLabel)}</a>
      ` : ""}
      <p style="color:#64748b;font-size:12px;line-height:1.6;margin-top:24px">
        Энэ мэдэгдлийг Mongol Agent автоматаар илгээв.
      </p>
    </div>`;
}

// Мөнгө/захиалгын орлогын үйл явдал уу? (гар утсан дээр "ча-чинг" кассын дуу гаргана)
function isIncomeEvent(title) {
  return /захиал|төлбөр|төлөгд|урьдчилга/i.test(String(title || ""));
}

// Байгууллагын эзэн рүү бүтэцтэй мэдэгдэл илгээнэ. Хэзээ ч алдаа шиднэ гэж бодохгүй.
async function notifyOwner(orgId, title, rows = {}, cta = {}) {
  // ── Гар утасны push (и-мэйлээс үл хамаарна) ───────────────────────────────
  // Захиалга/төлбөр = "ча-чинг" (Shopify маягийн кассын дуу, "orders" суваг),
  // бусад мэдэгдэл = энгийн дуу. Бүх notifyOwner дуудалт автоматаар push болно.
  try {
    const { sendPushToOrg } = require("./push.service");
    const income = isIncomeEvent(title);
    const body = Object.entries(rows)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .slice(0, 3)
      .map(([, v]) => String(v))
      .join(" · ");
    sendPushToOrg(orgId, {
      title,
      body: body || "Дэлгэрэнгүйг апп-аас харна уу",
      sound: income ? "kaching.wav" : "default",
      channelId: income ? "orders" : "default",
      data: { path: cta.path || "", income },
    }).catch(() => {});
  } catch { /* push бол туслах урсгал — и-мэйлийг зогсоохгүй */ }

  // ── И-мэйл ─────────────────────────────────────────────────────────────────
  try {
    if (!resend) return false;
    const to = await getOwnerEmail(orgId);
    if (!to) return false;
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `Mongol Agent — ${title}`,
      html: renderEmail(title, rows, cta.label, cta.path),
    });
    return true;
  } catch (e) {
    console.error("[notify] email error:", e && e.message);
    return false;
  }
}

module.exports = { notifyOwner };
