"use strict";
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Resend } = require("resend");
const { getPrisma } = require("../lib/db");
const { jwtSecret } = require("../lib/jwtSecret");
const { rateLimit } = require("../middleware/rateLimit");
const authLimiter = rateLimit({ windowMs: 60_000, max: 10 }); // 1 минутад 10 оролдлого

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

const APP_URL = process.env.APP_URL || "https://app.mongolagent.mn";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@mongolagent.mn";

function signToken(org) {
  return jwt.sign(
    { orgId: org.id, slug: org.slug, name: org.name, plan: org.plan, role: "owner" },
    jwtSecret(),
    { expiresIn: "30d" }
  );
}

// Ажилтны токен — org-ийн дотор role-той (staff | viewer)
function signStaffToken(staff, org) {
  return jwt.sign(
    { orgId: org.id, slug: org.slug, name: staff.name, plan: org.plan, role: staff.role, staffId: staff.id },
    jwtSecret(),
    { expiresIn: "30d" }
  );
}

// POST /auth/register
router.post("/register", authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "name, email, password шаардлагатай" });
    if (password.length < 6) return res.status(400).json({ error: "Нууц үг хамгийн багадаа 6 тэмдэгт байна" });

    const prisma = getPrisma();
    const existing = await prisma.organization.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: "Энэ имэйл бүртгэлтэй байна" });

    const slug = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "") + "-" + Date.now().toString(36);
    const passwordHash = await bcrypt.hash(password, 10);

    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 30);

    const org = await prisma.organization.create({
      data: { name, slug, email, passwordHash, subscriptionEndsAt: trialEnds },
    });

    const token = signToken(org);
    res.json({ token, org: { id: org.id, name: org.name, slug: org.slug, email: org.email, plan: org.plan } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /auth/login
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "email, password шаардлагатай" });

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { email } });
    if (org) {
      if (org.status !== "active") return res.status(403).json({ error: "Бүртгэл идэвхгүй байна" });
      const valid = await bcrypt.compare(password, org.passwordHash);
      if (!valid) return res.status(401).json({ error: "Имэйл эсвэл нууц үг буруу" });
      const token = signToken(org);
      return res.json({ token, org: { id: org.id, name: org.name, slug: org.slug, email: org.email, plan: org.plan, fbPageId: org.fbPageId, role: "owner" } });
    }

    // Org биш бол — ажилтны нэвтрэлт (additive, org урсгалыг хөндөхгүй)
    const staff = await prisma.staffMember.findUnique({ where: { email } });
    if (!staff || staff.status !== "active") return res.status(401).json({ error: "Имэйл эсвэл нууц үг буруу" });
    const sValid = await bcrypt.compare(password, staff.passwordHash);
    if (!sValid) return res.status(401).json({ error: "Имэйл эсвэл нууц үг буруу" });
    const parentOrg = await prisma.organization.findUnique({ where: { id: staff.orgId } });
    if (!parentOrg || parentOrg.status !== "active") return res.status(403).json({ error: "Бүртгэл идэвхгүй байна" });
    const token = signStaffToken(staff, parentOrg);
    res.json({ token, org: { id: parentOrg.id, name: staff.name, slug: parentOrg.slug, email: staff.email, plan: parentOrg.plan, role: staff.role, staffId: staff.id } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /auth/forgot-password
router.post("/forgot-password", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Имэйл шаардлагатай" });

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { email } });

    // Бүртгэлгүй бол ч амжилттай хариулна (security best practice)
    if (!org) return res.json({ message: "Хэрэв имэйл бүртгэлтэй бол reset холбоос илгээгдэнэ" });

    // Хуучин token-уудыг устгана
    await prisma.passwordResetToken.deleteMany({ where: { email } });

    // Шинэ token үүсгэнэ (30 минут хугацаатай)
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await prisma.passwordResetToken.create({ data: { email, token, expiresAt } });

    const resetUrl = `${APP_URL}/reset-password?token=${token}`;

    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: "Mongol Agent — Нууц үг шинэчлэх",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#07070e;color:#f1f5f9;border-radius:12px">
          <div style="margin-bottom:24px">
            <span style="font-size:20px;font-weight:800;color:#818cf8">Mongol</span>
            <span style="font-size:20px;font-weight:800;color:#94a3b8">Agent</span>
          </div>
          <h2 style="font-size:18px;font-weight:700;margin-bottom:12px;color:#f1f5f9">Нууц үг шинэчлэх хүсэлт</h2>
          <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin-bottom:24px">
            Та нууц үгээ шинэчлэх хүсэлт илгээсэн байна. Доорх товчийг дарж шинэ нууц үг тохируулна уу.
          </p>
          <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;font-weight:600;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;margin-bottom:24px">
            Нууц үг шинэчлэх →
          </a>
          <p style="color:#475569;font-size:12px;line-height:1.6">
            Энэ холбоос <strong>30 минутын</strong> дотор дуусна.<br/>
            Хэрэв та энэ хүсэлт илгээгээгүй бол энэ имэйлийг үл тоомсорлоно уу.
          </p>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #1a1a2e;font-size:11px;color:#334155">
            © ${new Date().getFullYear()} Mongol Agent
          </div>
        </div>
      `,
    });

    res.json({ message: "Нууц үг шинэчлэх холбоос имэйлд илгээгдлээ" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /auth/reset-password
router.post("/reset-password", authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "token, password шаардлагатай" });
    if (password.length < 6) return res.status(400).json({ error: "Нууц үг хамгийн багадаа 6 тэмдэгт байна" });

    const prisma = getPrisma();
    const resetToken = await prisma.passwordResetToken.findUnique({ where: { token } });

    if (!resetToken) return res.status(400).json({ error: "Token олдсонгүй эсвэл буруу байна" });
    if (resetToken.used) return res.status(400).json({ error: "Энэ холбоос аль хэдийн ашиглагдсан байна" });
    if (new Date() > resetToken.expiresAt) return res.status(400).json({ error: "Холбоосны хугацаа дууссан байна. Дахин хүсэлт илгээнэ үү" });

    const passwordHash = await bcrypt.hash(password, 10);

    await prisma.organization.update({
      where: { email: resetToken.email },
      data: { passwordHash },
    });

    await prisma.passwordResetToken.update({
      where: { token },
      data: { used: true },
    });

    res.json({ message: "Нууц үг амжилттай шинэчлэгдлээ" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /auth/me
router.get("/me", async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
    const token = auth.slice(7);
    const payload = jwt.verify(token, jwtSecret());
    if (!payload.orgId) return res.status(401).json({ error: "Invalid" });

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: payload.orgId } });
    if (!org) return res.status(404).json({ error: "Not found" });

    const role = payload.role || "owner";
    // Ажилтан бол түүний нэр/имэйлийг харуулна
    res.json({ id: org.id, name: payload.name || org.name, slug: org.slug, email: org.email, plan: org.plan, fbPageId: org.fbPageId, status: org.status, role });
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

module.exports = router;
