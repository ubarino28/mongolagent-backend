"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { paidEnough, markStoreOrderPaid, applyWalletTopup, applySubscriptionPayment, applyTopupPayment } = require("../src/services/payment.service");

// paidEnough — дутуу төлбөрийг PAID болгохоос сэргийлэх гол шалгалт.
// (webhook/polling/reconcile гурвуулаа markStoreOrderPaid→paidEnough-аар дамжина.)

test("paidEnough: төлсөн дүн = хүлээгдсэн → true", () => {
  assert.strictEqual(paidEnough({ paid_amount: 100000 }, 100000), true);
});

test("paidEnough: илүү төлсөн → true", () => {
  assert.strictEqual(paidEnough({ paid_amount: 120000 }, 100000), true);
});

test("paidEnough: ДУТУУ төлсөн → false (гол засвар)", () => {
  assert.strictEqual(paidEnough({ paid_amount: 50000 }, 100000), false);
  assert.strictEqual(paidEnough({ paid_amount: 99998 }, 100000), false);
});

test("paidEnough: 1₮ бөөрөнхийллийн зөрүү тэвчинэ", () => {
  assert.strictEqual(paidEnough({ paid_amount: 99999 }, 100000), true);
});

test("paidEnough: paid_amount байхгүй/0 → true (статусаар шийднэ, false-negative-аас сэргийлнэ)", () => {
  assert.strictEqual(paidEnough({}, 100000), true);
  assert.strictEqual(paidEnough({ paid_amount: 0 }, 100000), true);
  assert.strictEqual(paidEnough({ paid_amount: "abc" }, 100000), true);
  assert.strictEqual(paidEnough(null, 100000), true);
});

test("paidEnough: хүлээгдсэн дүн 0/буруу → true (шалгах зүйлгүй)", () => {
  assert.strictEqual(paidEnough({ paid_amount: 5 }, 0), true);
  assert.strictEqual(paidEnough({ paid_amount: 5 }, null), true);
});

// markStoreOrderPaid дүн/статус гейт — result дамжуулбал захиалгыг ХӨНДӨХГҮЙгээр таслана.

test("markStoreOrderPaid: ДУТУУ төлбөрийн result → false, захиалга ХӨНДӨГДӨХГҮЙ", async () => {
  let orderTouched = false;
  const prisma = { storeOrder: { updateMany: async () => { orderTouched = true; return { count: 1 }; } } };
  const ok = await markStoreOrderPaid(prisma, { id: "o1", totalAmount: 100000, items: [] }, { invoice_status: "PAID", paid_amount: 40000 });
  assert.strictEqual(ok, false);
  assert.strictEqual(orderTouched, false); // дутуу төлбөр → PAID болгохгүй
});

test("markStoreOrderPaid: invoice_status PAID биш result → false, захиалга ХӨНДӨГДӨХГҮЙ", async () => {
  let orderTouched = false;
  const prisma = { storeOrder: { updateMany: async () => { orderTouched = true; return { count: 1 }; } } };
  const ok = await markStoreOrderPaid(prisma, { id: "o1", totalAmount: 100000, items: [] }, { invoice_status: "PENDING", paid_amount: 100000 });
  assert.strictEqual(ok, false);
  assert.strictEqual(orderTouched, false);
});

test("markStoreOrderPaid: хангалттай төлбөр + PAID статус → true", async () => {
  const prisma = {
    storeOrder: { updateMany: async () => ({ count: 1 }) },
    product: { findMany: async () => [], findUnique: async () => null, update: async () => ({}) },
    turuuKnowledge: { findUnique: async () => null },
  };
  const ok = await markStoreOrderPaid(prisma, { id: "o1", orgId: "org1", totalAmount: 100000, items: [] }, { invoice_status: "PAID", paid_amount: 100000 });
  assert.strictEqual(ok, true);
});

// ─── Phase 2: subscription/wallet/topup дүн баталгаажуулалт ───────────────────

test("applyWalletTopup: дутуу төлбөр → false, wallet хөндөгдөхгүй", async () => {
  let touched = false;
  const prisma = { webWalletTx: { updateMany: async () => { touched = true; return { count: 1 }; } }, webWallet: { upsert: async () => ({}) } };
  const ok = await applyWalletTopup(prisma, { id: "t1", orgId: "o", amount: 10000 }, { invoice_status: "PAID", paid_amount: 3000 });
  assert.strictEqual(ok, false);
  assert.strictEqual(touched, false);
});

test("applySubscriptionPayment: дутуу төлбөр → applied=false, org хөндөгдөхгүй", async () => {
  let touched = false;
  const prisma = {
    turuuSettings: { findUnique: async () => ({ value: JSON.stringify({ plan: "growth", months: 1, amount: 99900 }) }) },
    organization: { updateMany: async () => { touched = true; return { count: 1 }; } },
  };
  const { applied } = await applySubscriptionPayment(prisma, { id: "org1", subInvoiceId: "inv", subscriptionEndsAt: null }, { invoice_status: "PAID", paid_amount: 5000 });
  assert.strictEqual(applied, false);
  assert.strictEqual(touched, false);
});

test("applyTopupPayment: дутуу төлбөр → applied=false, pending устгагдахгүй", async () => {
  let deleted = false;
  const prisma = {
    turuuSettings: {
      findUnique: async () => ({ value: JSON.stringify({ invoiceId: "i", units: 500, amount: 8900 }) }),
      delete: async () => { deleted = true; },
    },
  };
  const { applied } = await applyTopupPayment(prisma, "org1", { invoice_status: "PAID", paid_amount: 1000 });
  assert.strictEqual(applied, false);
  assert.strictEqual(deleted, false);
});

test("applyWalletTopup: хангалттай төлбөр → true", async () => {
  const prisma = { webWalletTx: { updateMany: async () => ({ count: 1 }) }, webWallet: { upsert: async () => ({}) } };
  const ok = await applyWalletTopup(prisma, { id: "t1", orgId: "o", amount: 10000 }, { invoice_status: "PAID", paid_amount: 10000 });
  assert.strictEqual(ok, true);
});
