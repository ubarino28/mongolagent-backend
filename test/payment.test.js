"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { markStoreOrderPaid, applySubscriptionPayment } = require("../src/services/payment.service");

// updateMany count===1 (анхны шилжилт) → true, нөөц хасах оролдоно
test("markStoreOrderPaid анхны PENDING→PAID шилжилтэд true буцаана", async () => {
  let discountCalled = false;
  const prisma = {
    storeOrder: { updateMany: async () => ({ count: 1 }) },
    product: { findMany: async () => [], update: async () => ({}) },
    discount: { updateMany: async () => { discountCalled = true; return { count: 1 }; } },
  };
  const ok = await markStoreOrderPaid(prisma, { id: "o1", storeId: "s1", discountCode: "ZUN10", items: [] });
  assert.strictEqual(ok, true);
  assert.strictEqual(discountCalled, true); // купонтой бол ашиглалт тоологдоно
});

// updateMany count===0 (өөр хүсэлт аль хэдийн PAID болгосон) → false, купон тоологдохгүй
test("markStoreOrderPaid давхар дуудлагад false буцааж, купон тоолохгүй (идемпотент)", async () => {
  let discountCalled = false;
  const prisma = {
    storeOrder: { updateMany: async () => ({ count: 0 }) },
    product: { findMany: async () => [], update: async () => ({}) },
    discount: { updateMany: async () => { discountCalled = true; return { count: 1 }; } },
  };
  const ok = await markStoreOrderPaid(prisma, { id: "o1", storeId: "s1", discountCode: "ZUN10", items: [] });
  assert.strictEqual(ok, false);
  assert.strictEqual(discountCalled, false);
});

// Купонгүй захиалга — discount.updateMany дуудагдахгүй
test("markStoreOrderPaid купонгүй бол discount.updateMany дуудахгүй", async () => {
  let discountCalled = false;
  const prisma = {
    storeOrder: { updateMany: async () => ({ count: 1 }) },
    product: { findMany: async () => [], update: async () => ({}) },
    discount: { updateMany: async () => { discountCalled = true; return { count: 1 }; } },
  };
  const ok = await markStoreOrderPaid(prisma, { id: "o1", storeId: "s1", discountCode: null, items: [] });
  assert.strictEqual(ok, true);
  assert.strictEqual(discountCalled, false);
});

// C1 fix — applySubscriptionPayment нь эрхийг 30 хоног сунгаж, идемпотент байх ёстой.
// (webhook болон polling-check ЭНЭ shared helper-ийг дуудна — өмнө polling сунгадаггүй
//  байсан тул төлсөн ч эрх гацдаг байсан.)
test("applySubscriptionPayment count===1 үед эрхийг ~30 хоног сунгана", async () => {
  let written = null;
  const prisma = { organization: { updateMany: async ({ data }) => { written = data; return { count: 1 }; } } };
  const now = Date.now();
  const { applied, subscriptionEndsAt } = await applySubscriptionPayment(prisma, { id: "org1", subInvoiceId: "inv1", subscriptionEndsAt: null });
  assert.strictEqual(applied, true);
  // ~30 хоног (±1 цаг тэвчинэ)
  const diffDays = (subscriptionEndsAt.getTime() - now) / (24 * 60 * 60 * 1000);
  assert.ok(Math.abs(diffDays - 30) < 0.05, `30 хоног байх ёстой, гарсан: ${diffDays}`);
  assert.strictEqual(written.subQpayStatus, "PAID");
  assert.strictEqual(written.status, "active");
  assert.strictEqual(written.subInvoiceId, null); // давхар сунгахаас сэргийлж цэвэрлэнэ
});

// Идемпотент: count===0 (webhook аль хэдийн боловсруулсан) бол applied=false
test("applySubscriptionPayment давхар дуудлагад applied=false (идемпотент)", async () => {
  const prisma = { organization: { updateMany: async () => ({ count: 0 }) } };
  const { applied } = await applySubscriptionPayment(prisma, { id: "org1", subInvoiceId: "inv1", subscriptionEndsAt: null });
  assert.strictEqual(applied, false);
});

// Үлдсэн хугацаан дээр нэмж стэклэнэ (идэвхтэй эрхийг эрт сунгавал хохирохгүй)
test("applySubscriptionPayment идэвхтэй эрхийн ҮЛДЭГДЭЛ дээр нэмнэ", async () => {
  const prisma = { organization: { updateMany: async () => ({ count: 1 }) } };
  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 хоног үлдсэн
  const { subscriptionEndsAt } = await applySubscriptionPayment(prisma, { id: "org1", subInvoiceId: "inv1", subscriptionEndsAt: future });
  const diffDays = (subscriptionEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  assert.ok(Math.abs(diffDays - 40) < 0.05, `40 хоног (10 үлдэгдэл + 30) байх ёстой, гарсан: ${diffDays}`);
});

// subInvoiceId байхгүй бол applied=false (хамгаалалт)
test("applySubscriptionPayment subInvoiceId-гүй бол applied=false", async () => {
  const prisma = { organization: { updateMany: async () => ({ count: 1 }) } };
  const { applied } = await applySubscriptionPayment(prisma, { id: "org1", subInvoiceId: null });
  assert.strictEqual(applied, false);
});