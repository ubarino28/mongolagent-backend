"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { applyTopupPayment } = require("../src/services/payment.service");
const { MESSAGE_TOPUP, topupPack } = require("../src/lib/planPricing");

// TuruuSettings-ийг дуурайх stateful mock (key: `${orgId}|${key}` → value string)
function makePrisma(initial) {
  const store = new Map(Object.entries(initial || {}));
  const k = (orgId, key) => `${orgId}|${key}`;
  return {
    _store: store, _k: k,
    turuuSettings: {
      findUnique: async ({ where: { orgId_key: { orgId, key } } }) => {
        const v = store.get(k(orgId, key));
        return v != null ? { orgId, key, value: v } : null;
      },
      delete: async ({ where: { orgId_key: { orgId, key } } }) => {
        const kk = k(orgId, key);
        if (!store.has(kk)) { const e = new Error("Record to delete does not exist"); e.code = "P2025"; throw e; }
        store.delete(kk);
        return {};
      },
      upsert: async ({ where: { orgId_key: { orgId, key } }, create, update }) => {
        const kk = k(orgId, key);
        store.set(kk, store.has(kk) ? update.value : create.value);
        return {};
      },
    },
  };
}

// ── Үнэ / margin ────────────────────────────────────────────────────────────
test("topupPack зөв units/price буцаана, буруу size → null", () => {
  assert.deepStrictEqual(topupPack("500"), { units: 500, price: 8900 });
  assert.deepStrictEqual(topupPack(1000), { units: 1000, price: 17900 });
  assert.strictEqual(topupPack(777), null);
  assert.strictEqual(topupPack("abc"), null);
});

test("бүх топ-ап багц хамгийн муу зардал (₮10.3/msg) дээр ≥40% margin барина", () => {
  const WORST_COST = 10.3; // no-cache зардал/мессеж
  for (const [units, price] of Object.entries(MESSAGE_TOPUP)) {
    const perMsg = price / Number(units);
    const margin = (perMsg - WORST_COST) / perMsg;
    assert.ok(margin >= 0.40, `${units} багц margin ${(margin * 100).toFixed(1)}% < 40%`);
  }
});

// ── applyTopupPayment идемпотент ─────────────────────────────────────────────
test("applyTopupPayment pending байхгүй бол applied=false", async () => {
  const prisma = makePrisma({});
  const r = await applyTopupPayment(prisma, "org1");
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.added, 0);
});

test("applyTopupPayment pending credit-ийг нэмж, pending-ийг устгана", async () => {
  const prisma = makePrisma({
    "org1|pending_topup": JSON.stringify({ invoiceId: "inv1", units: 500, amount: 8900 }),
  });
  const r = await applyTopupPayment(prisma, "org1");
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.added, 500);
  assert.strictEqual(r.remaining, 500);
  assert.strictEqual(prisma._store.get("org1|topup_remaining"), "500");
  assert.strictEqual(prisma._store.has("org1|pending_topup"), false); // цэвэрлэгдсэн
});

test("applyTopupPayment одоо байгаа credit дээр НЭМЖ стэклэнэ", async () => {
  const prisma = makePrisma({
    "org1|topup_remaining": "200",
    "org1|pending_topup": JSON.stringify({ invoiceId: "inv2", units: 1000, amount: 17900 }),
  });
  const r = await applyTopupPayment(prisma, "org1");
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.remaining, 1200); // 200 + 1000
});

test("applyTopupPayment давхар дуудлагад зөвхөн НЭГ УДАА credit нэмнэ (идемпотент)", async () => {
  const prisma = makePrisma({
    "org1|pending_topup": JSON.stringify({ invoiceId: "inv3", units: 2500, amount: 43900 }),
  });
  const r1 = await applyTopupPayment(prisma, "org1");
  const r2 = await applyTopupPayment(prisma, "org1"); // pending аль хэдийн устсан
  assert.strictEqual(r1.applied, true);
  assert.strictEqual(r2.applied, false);
  assert.strictEqual(prisma._store.get("org1|topup_remaining"), "2500"); // давхар нэмэгдээгүй
});
