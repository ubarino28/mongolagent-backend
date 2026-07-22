"use strict";
const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../lib/jwtSecret");
const { getPrisma } = require("../lib/db");

// Org төлөв (status + tokenVer)-ийн богино хугацааны кэш (60с) — түдгэлзүүлсэн/session цуцалсан
// token-ийг хурдан хаахын зэрэгцээ хүсэлт бүрт DB дуудахаас сэргийлнэ.
const statusCache = new Map(); // orgId  -> { status, tokenVer, exp }
const staffCache = new Map();  // staffId -> { role, active, exp }
const TTL = 60 * 1000;

async function orgState(orgId) {
  const now = Date.now();
  const cached = statusCache.get(orgId);
  if (cached && now < cached.exp) return cached;
  try {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { status: true, tokenVer: true } });
    const state = { status: org ? org.status : "missing", tokenVer: org ? (org.tokenVer || 0) : 0, exp: now + TTL };
    statusCache.set(orgId, state);
    return state;
  } catch {
    return { status: "active", tokenVer: null, exp: now + TTL }; // DB алдаа — блоклохгүй (tokenVer=null → шалгахгүй)
  }
}

// Ажилтны токен бол StaffMember-ийн ОДООГИЙН статус/ролийг DB-ээс шалгана (токенд итгэхгүй) —
// халагдсан/идэвхгүй болсон ажилтныг 7 хоног хүлээхгүй, зэрэглэл бууруулсныг тэр даруй мөрдөнө.
async function staffValid(staffId, orgId) {
  const now = Date.now();
  const c = staffCache.get(staffId);
  if (c && now < c.exp) return c.active ? { role: c.role } : null;
  try {
    const prisma = getPrisma();
    const s = await prisma.staffMember.findFirst({ where: { id: staffId, orgId }, select: { role: true, status: true } });
    const active = !!s && s.status === "active";
    staffCache.set(staffId, { role: s?.role || "viewer", active, exp: now + TTL });
    return active ? { role: s.role } : null;
  } catch {
    return { role: "viewer" }; // DB алдаа — least-privilege (viewer)-ээр зөвшөөрнө (outage-аас сэргийлнэ)
  }
}

// Нууц үг солих/сэргээх / ажилтан идэвхгүй болгоход кэшийг цэвэрлэж цуцлалтыг ТЭР ДАРУЙ мөрдүүлнэ.
function invalidateAuthCache(orgId, staffId) {
  if (orgId) statusCache.delete(orgId);
  if (staffId) staffCache.delete(staffId);
}

async function clientAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });

  const token = auth.slice(7);
  try {
    // Алгоритмыг ЯГ HS256-аар тогтооно — alg:none / алгоритм-төөрөгдлийн дайралтаас сэргийлнэ
    const payload = jwt.verify(token, jwtSecret(), { algorithms: ["HS256"] });
    if (!payload.orgId) return res.status(401).json({ error: "Invalid token" });
    const state = await orgState(payload.orgId);
    // Org түдгэлзүүлэгдсэн бол хүчинтэй token байсан ч хандалт хаана
    if (state.status !== "active") return res.status(403).json({ error: "Бүртгэл идэвхгүй байна" });
    // Session цуцлалт (зөвхөн owner) — нууц үг солих/сэргээхэд tokenVer bump хийгддэг тул хуучин
    // token хүчингүй болно. (payload.tv байхгүй хуучин token = 0; tokenVer=null → DB алдаа, алгасна.)
    if (!payload.staffId && state.tokenVer != null && (payload.tv || 0) !== (state.tokenVer || 0)) {
      return res.status(401).json({ error: "Session хүчингүй боллоо. Дахин нэвтэрнэ үү", code: "TOKEN_REVOKED" });
    }
    // Ажилтны токен — DB-ийн одоогийн статус/ролийг мөрдөнө (халагдсан бол хаана, ролийг DB-ээс авна)
    if (payload.staffId) {
      const sv = await staffValid(payload.staffId, payload.orgId);
      if (!sv) return res.status(403).json({ error: "Хандах эрх цуцлагдсан. Дахин нэвтэрнэ үү" });
      payload.role = sv.role; // токенд итгэхгүй — DB-ийн одоогийн роль
    }
    req.org = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// Токен зарцуулах route-д ЗӨВХӨН: эрх/хугацаа (subscription/trial) дууссан org-ийг блоклоно.
// Dashboard хандалтыг хаахгүй — зөвхөн OpenAI дуудах үйлдлийг (тест чат, builder, import).
const { isOrgExpired } = require("../lib/quota");
const expiryCache = new Map(); // orgId -> { expired, exp }
async function blockIfExpired(req, res, next) {
  const orgId = req.org?.orgId;
  if (!orgId) return next();
  const now = Date.now();
  const cached = expiryCache.get(orgId);
  let expired;
  if (cached && now < cached.exp) {
    expired = cached.expired;
  } else {
    try {
      const prisma = getPrisma();
      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { status: true, subscriptionEndsAt: true } });
      expired = isOrgExpired(org);
      expiryCache.set(orgId, { expired, exp: now + TTL });
    } catch { expired = false; } // DB алдаа гарвал блоклохгүй (outage-аас сэргийлнэ)
  }
  if (expired) return res.status(403).json({ error: "Багцын хугацаа дууссан байна. Үргэлжлүүлэхийн тулд багцаа сунгана уу.", code: "SUBSCRIPTION_EXPIRED" });
  next();
}

module.exports = { clientAuthMiddleware, blockIfExpired, invalidateAuthCache };
