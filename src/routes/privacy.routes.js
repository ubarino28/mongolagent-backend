"use strict";
// НИЙТИЙН нууцлалын маршрутууд (auth-гүй).
//
// 1) POST /privacy/facebook/data-deletion — Meta-гийн ЗААВАЛ шаарддаг "Data Deletion
//    Request Callback". Хэрэглэгч Facebook → Settings → Apps and websites → Remove
//    дарахад Meta энэ URL руу signed_request илгээнэ. Бид { url, confirmation_code }
//    буцаах ёстой бөгөөд url нь хүсэлтийн явцыг харах хуудас байх ёстой.
// 2) GET /privacy/data-deletion/:code — тухайн хүсэлтийн статусыг харуулах нийтийн хуудас.
const express = require("express");
const crypto = require("crypto");
const { getPrisma } = require("../lib/db");
const { erasePsid } = require("../services/privacy.service");
const { rateLimit } = require("../middleware/rateLimit");
const { timingEqual } = require("../lib/timingEqual");

const router = express.Router();
const delLimiter = rateLimit({ windowMs: 60_000, max: 20 });

const API_URL = process.env.API_URL || "https://api.mongolagent.mn";

// base64url → Buffer (Facebook signed_request нь base64url ашиглана)
function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// signed_request-ийг задалж баталгаажуулна. Гарын үсэг таарахгүй бол null.
// FB_APP_SECRET тохируулаагүй бол ямар ч хүсэлтийг ХҮЛЭЭН АВАХГҮЙ — эс тэгвэл
// дурын хүн бусдын өгөгдлийг устгах хүсэлт илгээх боломжтой болно.
function parseSignedRequest(signedRequest) {
  const secret = process.env.FB_APP_SECRET;
  if (!secret) {
    console.warn("[privacy] FB_APP_SECRET тохируулаагүй — data deletion callback идэвхгүй");
    return null;
  }
  const parts = String(signedRequest || "").split(".");
  if (parts.length !== 2) return null;
  const [encodedSig, payload] = parts;

  // timingEqual нь String дээр ажилладаг тул hex хэлбэрээр харьцуулна.
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const actual = b64urlDecode(encodedSig).toString("hex");
  if (!timingEqual(expected, actual)) return null;

  try {
    const data = JSON.parse(b64urlDecode(payload).toString("utf8"));
    return data && data.user_id ? data : null;
  } catch {
    return null;
  }
}

// POST /privacy/facebook/data-deletion
router.post("/facebook/data-deletion", delLimiter, async (req, res) => {
  try {
    const data = parseSignedRequest(req.body?.signed_request);
    if (!data) return res.status(400).json({ error: "signed_request буруу байна" });

    const psid = String(data.user_id);
    const code = crypto.randomBytes(12).toString("hex");
    const prisma = getPrisma();

    // Хүсэлтийг эхлээд бүртгэнэ — устгал явцад унасан ч хэрэглэгч статусаа харна.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "DataDeletionRequest" ("id","code","source","subjectRef","status","createdAt")
       VALUES ($1,$2,'facebook',$3,'pending',now())`,
      crypto.randomUUID(), code, psid
    );

    // Устгалыг хариу буцаасны дараа гүйцэтгэнэ — Meta-гийн timeout-д баригдахгүй.
    res.json({ url: `${API_URL}/privacy/data-deletion/${code}`, confirmation_code: code });

    setImmediate(async () => {
      try {
        const result = await erasePsid(prisma, psid);
        await prisma.$executeRawUnsafe(
          `UPDATE "DataDeletionRequest" SET "status"='completed', "result"=$2::jsonb, "completedAt"=now() WHERE "code"=$1`,
          code, JSON.stringify(result)
        );
        console.log(`[privacy] FB data deletion гүйцэтгэв: ${code}`);
      } catch (e) {
        console.error("[privacy] deletion алдаа:", e && e.message);
        await prisma.$executeRawUnsafe(
          `UPDATE "DataDeletionRequest" SET "status"='failed' WHERE "code"=$1`, code
        ).catch(() => {});
      }
    });
  } catch (e) {
    console.error("[privacy] callback алдаа:", e && e.message);
    if (!res.headersSent) res.status(500).json({ error: "Серверийн алдаа гарлаа" });
  }
});

// GET /privacy/data-deletion/:code — статусын нийтийн хуудас
router.get("/data-deletion/:code", delLimiter, async (req, res) => {
  const code = String(req.params.code || "").slice(0, 64);
  let row = null;
  try {
    const rows = await getPrisma().$queryRawUnsafe(
      `SELECT "code","status","createdAt","completedAt" FROM "DataDeletionRequest" WHERE "code"=$1 LIMIT 1`,
      code
    );
    row = rows && rows[0];
  } catch { /* хүснэгт байхгүй бол доор "олдсонгүй" гарна */ }

  const label = !row ? "Хүсэлт олдсонгүй"
    : row.status === "completed" ? "Биелэгдсэн — таны мэдээллийг устгасан"
    : row.status === "failed" ? "Алдаа гарсан — бидэнтэй холбогдоно уу"
    : "Хүлээгдэж байна";

  res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<html lang="mn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Өгөгдөл устгах хүсэлт — Mongol Agent</title></head>
<body style="font-family:system-ui,sans-serif;background:#f6f8fc;margin:0;padding:40px 20px;color:#0e1a2e">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e9f2;border-radius:12px;padding:32px">
    <div style="font-weight:800;font-size:18px;margin-bottom:24px">
      <span style="color:#4f6bff">Mongol</span> <span style="color:#5a6b85">Agent</span>
    </div>
    <h1 style="font-size:18px;margin:0 0 12px">Өгөгдөл устгах хүсэлт</h1>
    <p style="color:#5a6b85;font-size:14px;line-height:1.7;margin:0 0 20px">Төлөв: <strong>${label}</strong></p>
    <div style="font-size:13px;color:#8a97ad;border-top:1px solid #e4e9f2;padding-top:16px">
      Баталгаажуулах код: <code>${code.replace(/[^a-f0-9]/gi, "")}</code><br>
      Асуулт байвал: <a href="mailto:info@mongolagent.mn" style="color:#4f6bff">info@mongolagent.mn</a>
    </div>
  </div>
</body></html>`);
});

module.exports = router;
