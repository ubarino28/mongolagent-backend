"use strict";
// Багцын feature gating — НЭГ эх сурвалж. Аль боломж аль багцаас нээгдэхийг заана.
// Зарлагдсан план картуудтай тааруулсан (client.routes /billing PLANS-тэй нийцнэ).
const { getPrisma } = require("./db");
const { PLAN_RANK } = require("./quotas");

// Feature бүрийн ШААРДЛАГАТАЙ доод план
// Тэмдэглэл: analytics (funnel / deltas / топ бараа / орлого) нь ОДООГООР бүх планд нээлттэй —
// Starter=Growth ижил түвшин. Ирээдүйн "Дэвшилтэт analytics" (Business) нэмэлтийг дараа gate хийнэ.
const FEATURE_MIN_PLAN = {
  orders:       "growth",   // Захиалга + QPay төлбөр
  appointments: "growth",   // Цаг захиалга + урьдчилгаа
  handoff:      "growth",   // Хүн handoff
  fileImport:   "growth",   // PDF / Excel → мэдлэгийн сан
  aiConfig:     "business", // AI тохиргоо (model / tone)
};

// Мэдлэгийн сангийн багтаамж (план бүр). Enterprise = хязгааргүй.
const KB_LIMIT = { starter: 100, growth: 500, business: 2000, enterprise: Infinity };
const PLAN_LABEL = { starter: "Starter", growth: "Growth", business: "Business", enterprise: "Enterprise" };

function rank(plan) { return PLAN_RANK[plan] ?? 0; }

// plan нь feature-ийг ашиглаж чадах эсэх
function planAllows(plan, feature) {
  const min = FEATURE_MIN_PLAN[feature];
  if (!min) return true;                 // тодорхойлоогүй feature = чөлөөтэй
  return rank(plan) >= rank(min);
}
function kbLimit(plan) { return KB_LIMIT[plan] ?? 100; }

// Одоогийн планыг DB-ЭЭС авна (60с кэш). JWT дэх план upgrade хийсний дараа хуучирдаг тул
// gating-д DB-ийн бодит планыг ашиглана — саяхан төлж дээшлүүлсэн хэрэглэгчийг андуурч хаахгүй.
const planCache = new Map(); // orgId -> { plan, exp }
const TTL = 60 * 1000;
async function getOrgPlan(orgId) {
  if (!orgId) return "starter";
  const now = Date.now();
  const c = planCache.get(orgId);
  if (c && now < c.exp) return c.plan;
  try {
    const org = await getPrisma().organization.findUnique({ where: { id: orgId }, select: { plan: true } });
    const plan = org?.plan || "starter";
    planCache.set(orgId, { plan, exp: now + TTL });
    return plan;
  } catch {
    return "starter"; // DB алдаа — кэшлэхгүйгээр хамгийн доод планаар үзнэ
  }
}
function invalidatePlan(orgId) { planCache.delete(orgId); }

// Express middleware — feature түгжигдсэн бол 403 (PLAN_REQUIRED)
function requireFeature(feature) {
  return async (req, res, next) => {
    try {
      const plan = await getOrgPlan(req.org?.orgId);
      if (planAllows(plan, feature)) return next();
      const min = FEATURE_MIN_PLAN[feature];
      return res.status(403).json({
        error: `Энэ боломж ${PLAN_LABEL[min]} багцаас нээгдэнэ. Багцаа дээшлүүлээрэй.`,
        code: "PLAN_REQUIRED", requiredPlan: min, feature,
      });
    } catch { return next(); } // gating дотоод алдаа гарвал блоклохгүй (аюулгүй тал)
  };
}

module.exports = {
  FEATURE_MIN_PLAN, KB_LIMIT, PLAN_LABEL,
  planAllows, kbLimit, getOrgPlan, invalidatePlan, requireFeature,
};
