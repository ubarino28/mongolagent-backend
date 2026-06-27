"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { markStoreOrderPaid } = require("../src/services/payment.service");

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