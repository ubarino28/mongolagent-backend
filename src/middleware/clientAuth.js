"use strict";
const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../lib/jwtSecret");
const { getPrisma } = require("../lib/db");

// Org status-ийн богино хугацааны кэш (60с) — түдгэлзүүлсэн/идэвхгүй org-ийн token-ийг
// хурдан хаахын зэрэгцээ хүсэлт бүрт DB дуудахаас сэргийлнэ.
const statusCache = new Map(); // orgId -> { status, exp }
const TTL = 60 * 1000;

async function orgActive(orgId) {
  const now = Date.now();
  const cached = statusCache.get(orgId);
  if (cached && now < cached.exp) return cached.status === "active";
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { status: true } });
    const status = org ? org.status : "missing";
    statusCache.set(orgId, { status, exp: now + TTL });
    return status === "active";
  } catch {
    return true; // DB алдаа гарвал блоклохгүй — outage-аас сэргийлнэ
  }
}

async function clientAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });

  const token = auth.slice(7);
  try {
    // Алгоритмыг ЯГ HS256-аар тогтооно — alg:none / алгоритм-төөрөгдлийн дайралтаас сэргийлнэ
    const payload = jwt.verify(token, jwtSecret(), { algorithms: ["HS256"] });
    if (!payload.orgId) return res.status(401).json({ error: "Invalid token" });
    // Org түдгэлзүүлэгдсэн бол хүчинтэй token байсан ч хандалт хаана
    if (!(await orgActive(payload.orgId))) return res.status(403).json({ error: "Бүртгэл идэвхгүй байна" });
    req.org = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = { clientAuthMiddleware };
