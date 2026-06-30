"use strict";
// Планы мессежийн квот — НЭГ эх сурвалж (ai.service, client.routes, admin.routes хуваалцана)
const PLAN_QUOTA = { starter: 7000, growth: 15000, business: 30000, enterprise: 70000 };
const PLAN_NEXT  = { starter: "Growth", growth: "Business", business: "Enterprise" };

module.exports = { PLAN_QUOTA, PLAN_NEXT };
