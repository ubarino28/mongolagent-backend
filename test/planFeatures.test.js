"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { planAllows, kbLimit } = require("../src/lib/planFeatures");

test("Starter — захиалга/цаг/handoff/import/aiConfig хаалттай", () => {
  for (const f of ["orders", "appointments", "handoff", "fileImport", "aiConfig"])
    assert.strictEqual(planAllows("starter", f), false, `starter ${f} хаалттай байх ёстой`);
});

test("Analytics (funnel / delta / топ бараа / орлого) — БҮХ планд нээлттэй (Starter=Growth)", () => {
  for (const plan of ["starter", "growth", "business", "enterprise"]) {
    assert.strictEqual(planAllows(plan, "funnelAnalytics"), true, `${plan} funnel нээлттэй`);
    assert.strictEqual(planAllows(plan, "advancedAnalytics"), true, `${plan} advanced нээлттэй`);
  }
});

test("Growth — захиалга/цаг/handoff/import нээлттэй; aiConfig хаалттай", () => {
  for (const f of ["orders", "appointments", "handoff", "fileImport"])
    assert.strictEqual(planAllows("growth", f), true, `growth ${f} нээлттэй байх ёстой`);
  assert.strictEqual(planAllows("growth", "aiConfig"), false);
});

test("Business — aiConfig нээгдэнэ", () => {
  assert.strictEqual(planAllows("business", "aiConfig"), true);
});

test("Enterprise — бүх feature нээлттэй", () => {
  for (const f of ["orders", "appointments", "handoff", "fileImport", "aiConfig"])
    assert.strictEqual(planAllows("enterprise", f), true);
});

test("Тодорхойлоогүй feature = чөлөөтэй (default allow)", () => {
  assert.strictEqual(planAllows("starter", "randomFeature"), true);
});

test("KB багтаамжийн лимит план бүрт зөв", () => {
  assert.strictEqual(kbLimit("starter"), 100);
  assert.strictEqual(kbLimit("growth"), 500);
  assert.strictEqual(kbLimit("business"), 2000);
  assert.strictEqual(kbLimit("enterprise"), Infinity);
  assert.strictEqual(kbLimit("unknown"), 100); // fallback
});
