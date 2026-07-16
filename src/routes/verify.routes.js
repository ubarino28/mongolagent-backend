"use strict";
// Тайлан баталгаажуулах НИЙТИЙН хуудас (auth-гүй).
// Банк/гуравдагч тал хэвлэсэн тайлан дээрх код/URL-ээр орж, СЕРВЕР дээрх жинхэнэ тоог хардаг.
// Ингэснээр PDF-ийн тоог гараар засвал сервертэйгээ таарахгүй → хуурамчлал илэрнэ.
const express = require("express");
const { getPrisma } = require("../lib/db");

const router = express.Router();

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mnt = (n) => "₮" + Math.round(Number(n) || 0).toLocaleString("en-US");
const fmtDate = (d) => { try { return new Date(d).toLocaleDateString("mn-MN", { year: "numeric", month: "long", day: "numeric" }); } catch { return ""; } };

function page(title, bodyHtml) {
  return `<!doctype html><html lang="mn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f1f5f9;color:#0f172a;padding:24px}
  .card{max-width:560px;margin:24px auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px 30px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
  .brand{display:flex;align-items:center;gap:8px;font-weight:800;color:#143A6B;font-size:15px;margin-bottom:4px}
  .ok{display:inline-flex;align-items:center;gap:6px;background:#dcfce7;color:#166534;font-weight:700;font-size:12.5px;padding:5px 11px;border-radius:99px;margin:10px 0 4px}
  .bad{background:#fee2e2;color:#991b1b}
  h1{font-size:20px;margin:8px 0 2px}
  .muted{color:#64748b;font-size:13px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0}
  .kpi{border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px}
  .kpi .l{font-size:11px;color:#64748b;font-weight:600}
  .kpi .v{font-size:19px;font-weight:800;margin-top:3px}
  .verified{border-color:#86efac;background:#f0fdf4}
  .verified .v{color:#166534}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  td{padding:7px 0;border-bottom:1px solid #eef2f7;font-size:13.5px}
  td.r{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
  .foot{margin-top:22px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:11.5px;color:#94a3b8;line-height:1.6}
  code{background:#f1f5f9;padding:2px 7px;border-radius:6px;font-size:13px;font-weight:700;letter-spacing:.04em}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}

// GET /verify/report/:code — баталгаажуулах хуудас
router.get("/report/:code", async (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  try {
    const prisma = getPrisma();
    const rows = await prisma.$queryRaw`SELECT * FROM "ReportSnapshot" WHERE "code"=${code} LIMIT 1`;
    const snap = Array.isArray(rows) ? rows[0] : null;
    if (!snap) {
      res.status(404).type("html").send(page("Баталгаажуулалт олдсонгүй", `
        <div class="brand">🛡️ Mongolagent — Тайлан баталгаажуулалт</div>
        <span class="ok bad">✕ Олдсонгүй</span>
        <h1>Код буруу байна</h1>
        <p class="muted">«<code>${esc(code)}</code>» кодтой баталгаажсан тайлан олдсонгүй. Хэвлэсэн тайлан дээрх кодоо шалгана уу.</p>
        <div class="foot">Хэрэв энэ тайланг Mongolagent-ээр гаргасан гэж мэдүүлсэн бол код таарахгүй байгаа нь <b>хуурамч эсвэл засварласан</b> байж болзошгүй.</div>`));
      return;
    }
    const verified = Number(snap.verifiedRevenue) || 0;
    const self = Number(snap.selfReportedRevenue) || 0;
    const total = Number(snap.totalRevenue) || (verified + self);
    res.type("html").send(page("Тайлан баталгаажлаа — Mongolagent", `
      <div class="brand">🛡️ Mongolagent — Тайлан баталгаажуулалт</div>
      <span class="ok">✓ Баталгаажсан тайлан</span>
      <h1>${esc(snap.bizName || "Бизнес")}</h1>
      <div class="muted">Тайлант хугацаа: ${esc(snap.periodLabel || snap.months + " сар")} · Гаргасан: ${fmtDate(snap.createdAt)}</div>
      <div class="grid">
        <div class="kpi verified">
          <div class="l">Баталгаат орлого (QPay/вэб)</div>
          <div class="v">${mnt(verified)}</div>
        </div>
        <div class="kpi">
          <div class="l">Нийт орлого (мэдүүлсэн)</div>
          <div class="v">${mnt(total)}</div>
        </div>
      </div>
      <table>
        <tr><td>Баталгаат орлого (гүйлгээгээр нотлогдсон)</td><td class="r">${mnt(verified)}</td></tr>
        <tr><td>Өөрийн мэдүүлсэн (данс/бэлэн, баталгаажаагүй)</td><td class="r">${mnt(self)}</td></tr>
        <tr><td>Баталгаат захиалга / нийт</td><td class="r">${Number(snap.verifiedOrders) || 0} / ${Number(snap.totalOrders) || 0}</td></tr>
      </table>
      <div class="foot">
        Баталгаажуулах код: <code>${esc(snap.code)}</code><br>
        Энэ тоонууд Mongolagent серверээс шууд уншигдав. Хэвлэсэн тайлан дээрх дүнтэй таарч байвал баримт <b>жинхэнэ</b>. Таарахгүй бол засварласан байна.<br>
        «Баталгаат орлого» нь QPay/вэбсайтын жинхэнэ төлбөрийн гүйлгээгээр нотлогдсон — гараар нэмэх/өөрчлөх боломжгүй. «Өөрийн мэдүүлсэн» дүнг бизнес эрхлэгч гараар тэмдэглэсэн тул баталгаажаагүй.
      </div>`));
  } catch (e) {
    console.error("[verify]", e && e.message);
    res.status(500).type("html").send(page("Алдаа", `<div class="brand">🛡️ Mongolagent</div><p class="muted">Түр алдаа гарлаа. Дараа дахин оролдоно уу.</p>`));
  }
});

module.exports = router;
