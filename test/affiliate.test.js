"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { wasActiveThroughMonth, accrueForClient, getBalance, COMMISSION_RATE } = require("../src/services/affiliate.service");

const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30 * DAY;

// ── wasActiveThroughMonth ────────────────────────────────────────────────────

test("wasActiveThroughMonth: subscriptionEndsAt тухайн сарыг хамарвал true", () => {
  const referredAt = new Date("2026-01-01");
  const ends = new Date(referredAt.getTime() + 6 * MONTH); // 6 сар төлсөн
  assert.strictEqual(wasActiveThroughMonth(referredAt, ends, 1), true);
  assert.strictEqual(wasActiveThroughMonth(referredAt, ends, 6), true);
  assert.strictEqual(wasActiveThroughMonth(referredAt, ends, 7), false); // 7-р сар хамрагдаагүй
});

test("wasActiveThroughMonth: subscriptionEndsAt байхгүй бол false", () => {
  assert.strictEqual(wasActiveThroughMonth(new Date("2026-01-01"), null, 1), false);
});

// ── accrueForClient ──────────────────────────────────────────────────────────

// Дуудлагыг бүртгэдэг хуурамч prisma. AffiliateCommission-д (clientId,monthIndex)
// unique-ийг Set-ээр дуурайж, давхар үүсгэлтийг throw болгоно.
function fakePrisma({ affiliateExists = true, existing = [] } = {}) {
  const created = [];
  const seen = new Set(existing.map((e) => `${e.clientId}:${e.monthIndex}`));
  return {
    _created: created,
    organization: { findUnique: async () => (affiliateExists ? { id: "aff" } : null) },
    affiliateCommission: {
      create: async ({ data }) => {
        const key = `${data.clientId}:${data.monthIndex}`;
        if (seen.has(key)) throw new Error("unique зөрчил");
        seen.add(key); created.push(data); return data;
      },
    },
  };
}

test("accrueForClient: 6 сар идэвхтэй клиентэд 6 комисс, тус бүр 10%", async () => {
  const referredAt = new Date(Date.now() - 6.5 * MONTH); // 6 бүтэн сар өнгөрсөн
  const prisma = fakePrisma();
  const client = { id: "c1", referredBy: "aff", referredAt, subscriptionEndsAt: new Date(referredAt.getTime() + 6 * MONTH), subPerMonth: 79900 };
  const n = await accrueForClient(prisma, client);
  assert.strictEqual(n, 6);
  assert.strictEqual(prisma._created.length, 6);
  assert.strictEqual(prisma._created[0].amount, Math.round(79900 * COMMISSION_RATE)); // 7990
  assert.deepStrictEqual(prisma._created.map((c) => c.monthIndex), [1, 2, 3, 4, 5, 6]);
});

test("accrueForClient: жилээр төлсөн ч НЭГ ДОР биш — өнгөрсөн сараар л боловсорно", async () => {
  const referredAt = new Date(Date.now() - 3.2 * MONTH); // ердөө 3 сар өнгөрсөн
  const prisma = fakePrisma();
  // Жилээр төлсөн: subscriptionEndsAt = +12 сар, гэхдээ ердөө 3 сар л өнгөрсөн
  const client = { id: "c1", referredBy: "aff", referredAt, subscriptionEndsAt: new Date(referredAt.getTime() + 12 * MONTH), subPerMonth: 79900 };
  const n = await accrueForClient(prisma, client);
  assert.strictEqual(n, 3, "зөвхөн өнгөрсөн 3 сар боловсорно, 12 биш");
});

test("accrueForClient: 12 сараас хэтрэхгүй", async () => {
  const referredAt = new Date(Date.now() - 20 * MONTH); // 20 сар өнгөрсөн
  const prisma = fakePrisma();
  const client = { id: "c1", referredBy: "aff", referredAt, subscriptionEndsAt: new Date(referredAt.getTime() + 24 * MONTH), subPerMonth: 79900 };
  const n = await accrueForClient(prisma, client);
  assert.strictEqual(n, 12, "хамгийн ихдээ 12 сар");
});

test("accrueForClient: буцаалт (subscriptionEndsAt богино) → идэвхгүй сар комиссгүй", async () => {
  const referredAt = new Date(Date.now() - 10 * MONTH);
  const prisma = fakePrisma();
  // Клиент 3 сарын дараа буцаалт авсан → subscriptionEndsAt = +3 сар
  const client = { id: "c1", referredBy: "aff", referredAt, subscriptionEndsAt: new Date(referredAt.getTime() + 3 * MONTH), subPerMonth: 79900 };
  const n = await accrueForClient(prisma, client);
  assert.strictEqual(n, 3, "буцаалтын дараах сар комиссгүй");
});

test("accrueForClient: идемпотент — аль хэдийн бодсон сарыг давхар үүсгэхгүй", async () => {
  const referredAt = new Date(Date.now() - 6.5 * MONTH);
  // 1,2,3-р сар аль хэдийн бодогдсон
  const prisma = fakePrisma({ existing: [1, 2, 3].map((m) => ({ clientId: "c1", monthIndex: m })) });
  const client = { id: "c1", referredBy: "aff", referredAt, subscriptionEndsAt: new Date(referredAt.getTime() + 6 * MONTH), subPerMonth: 79900 };
  const n = await accrueForClient(prisma, client);
  assert.strictEqual(n, 3, "зөвхөн шинэ 4,5,6-р сар");
  assert.deepStrictEqual(prisma._created.map((c) => c.monthIndex), [4, 5, 6]);
});

test("accrueForClient: self-referral (referredBy === clientId) → 0", async () => {
  const referredAt = new Date(Date.now() - 3 * MONTH);
  const prisma = fakePrisma();
  const client = { id: "c1", referredBy: "c1", referredAt, subscriptionEndsAt: new Date(referredAt.getTime() + 6 * MONTH), subPerMonth: 79900 };
  assert.strictEqual(await accrueForClient(prisma, client), 0);
});

test("accrueForClient: санал болгогч устсан бол 0", async () => {
  const referredAt = new Date(Date.now() - 3 * MONTH);
  const prisma = fakePrisma({ affiliateExists: false });
  const client = { id: "c1", referredBy: "gone", referredAt, subscriptionEndsAt: new Date(referredAt.getTime() + 6 * MONTH), subPerMonth: 79900 };
  assert.strictEqual(await accrueForClient(prisma, client), 0);
});

test("accrueForClient: referredAt эсвэл subPerMonth байхгүй бол 0", async () => {
  const prisma = fakePrisma();
  assert.strictEqual(await accrueForClient(prisma, { id: "c1", referredBy: "aff", referredAt: null, subPerMonth: 79900 }), 0);
  assert.strictEqual(await accrueForClient(prisma, { id: "c1", referredBy: "aff", referredAt: new Date(), subPerMonth: 0 }), 0);
});

// ── getBalance ───────────────────────────────────────────────────────────────

test("getBalance: available = нийт комисс − (paid + pending)", async () => {
  const prisma = {
    affiliateCommission: { aggregate: async () => ({ _sum: { amount: 300000 } }) },
    affiliatePayout: { aggregate: async () => ({ _sum: { amount: 120000 } }) },
  };
  const b = await getBalance(prisma, "aff");
  assert.strictEqual(b.total, 300000);
  assert.strictEqual(b.withdrawn, 120000);
  assert.strictEqual(b.available, 180000);
});

test("getBalance: комисс байхгүй бол бүх 0 (сөрөг болохгүй)", async () => {
  const prisma = {
    affiliateCommission: { aggregate: async () => ({ _sum: { amount: null } }) },
    affiliatePayout: { aggregate: async () => ({ _sum: { amount: null } }) },
  };
  const b = await getBalance(prisma, "aff");
  assert.deepStrictEqual(b, { total: 0, withdrawn: 0, available: 0 });
});
