"use strict";
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getPrisma } = require("../lib/db");

const router = express.Router();

function signToken(org) {
  return jwt.sign(
    { orgId: org.id, slug: org.slug, name: org.name, plan: org.plan },
    process.env.JWT_SECRET || "turuuai_admin_secret_change_me",
    { expiresIn: "30d" }
  );
}

// POST /auth/register
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "name, email, password шаардлагатай" });
    if (password.length < 6) return res.status(400).json({ error: "Нууц үг хамгийн багадаа 6 тэмдэгт байна" });

    const prisma = getPrisma();
    const existing = await prisma.organization.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: "Энэ имэйл бүртгэлтэй байна" });

    const slug = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "") + "-" + Date.now().toString(36);
    const passwordHash = await bcrypt.hash(password, 10);

    const org = await prisma.organization.create({
      data: { name, slug, email, passwordHash },
    });

    const token = signToken(org);
    res.json({ token, org: { id: org.id, name: org.name, slug: org.slug, email: org.email, plan: org.plan } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "email, password шаардлагатай" });

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { email } });
    if (!org) return res.status(401).json({ error: "Имэйл эсвэл нууц үг буруу" });
    if (org.status !== "active") return res.status(403).json({ error: "Бүртгэл идэвхгүй байна" });

    const valid = await bcrypt.compare(password, org.passwordHash);
    if (!valid) return res.status(401).json({ error: "Имэйл эсвэл нууц үг буруу" });

    const token = signToken(org);
    res.json({ token, org: { id: org.id, name: org.name, slug: org.slug, email: org.email, plan: org.plan, fbPageId: org.fbPageId } });
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
    const payload = jwt.verify(token, process.env.JWT_SECRET || "turuuai_admin_secret_change_me");
    if (!payload.orgId) return res.status(401).json({ error: "Invalid" });

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: payload.orgId } });
    if (!org) return res.status(404).json({ error: "Not found" });

    res.json({ id: org.id, name: org.name, slug: org.slug, email: org.email, plan: org.plan, fbPageId: org.fbPageId, status: org.status });
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

module.exports = router;
