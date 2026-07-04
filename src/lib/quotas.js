"use strict";
// Планы мессежийн квот — НЭГ эх сурвалж (ai.service, client.routes, admin.routes хуваалцана)
// 60% маржинд тохируулсан хямдруулсан шатлал. Суурь: USD/MNT ₮3,600 (банк, 2026-07 mid ₮3,569
// + spread), gpt-4o-mini $0.15/$0.60, 1 мессеж ≈ 18,900 токен (caching-гүй) ≈ ₮10.3.
// Квот = үнэ×40% ÷ ₮10.3. Үнэ: 59,900 / 99,900 / 179,900 / 349,900.
const PLAN_QUOTA = { starter: 2300, growth: 3800, business: 6900, enterprise: 13500 };
const PLAN_NEXT  = { starter: "Growth", growth: "Business", business: "Enterprise" };

module.exports = { PLAN_QUOTA, PLAN_NEXT };
