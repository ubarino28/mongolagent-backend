"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { isPaid } = require("../src/services/reconcile.service");

test("isPaid QPay-ийн янз бүрийн төлсөн хариуг танина", () => {
  assert.strictEqual(isPaid({ invoice_status: "PAID" }), true);
  assert.strictEqual(isPaid({ count: 1 }), true);
  assert.strictEqual(isPaid({ count: 3 }), true);
  assert.strictEqual(isPaid({ payment_status: "PAID" }), true);
});

test("isPaid төлөгдөөгүй/хоосон хариуг false гэнэ", () => {
  assert.strictEqual(isPaid({ count: 0 }), false);
  assert.strictEqual(isPaid({ invoice_status: "PENDING" }), false);
  assert.strictEqual(isPaid({}), false);
  assert.strictEqual(isPaid(null), false);
  assert.strictEqual(isPaid(undefined), false);
});