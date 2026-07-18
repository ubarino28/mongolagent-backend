"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { erasePsid, eraseOrganization, ANON } = require("../src/services/privacy.service");

// Дуудлагыг бүртгэдэг хуурамч prisma
function fakePrisma(overrides = {}) {
  const calls = [];
  const rec = (model, op) => async (args) => { calls.push({ model, op, args }); return { count: 1 }; };
  const models = [
    "turuuChat", "turuuLead", "turuuConsultation", "turuuUnanswered",
    "turuuKnowledge", "turuuSettings", "turuuStaff", "turuuMenuItem",
    "turuuTable", "turuuOrder", "turuuAppointment", "turuuReservation",
    "auditLog", "domainOrder", "webWalletTx", "webWallet", "storeOrder",
  ];
  const p = { _calls: calls };
  for (const m of models) p[m] = { deleteMany: rec(m, "deleteMany"), updateMany: rec(m, "updateMany") };
  p.organization = { delete: rec("organization", "delete") };
  return Object.assign(p, overrides);
}

// ── erasePsid ───────────────────────────────────────────────────────────────

test("erasePsid чатыг УСТГАЖ, захиалгыг НЭРГҮЙЖҮҮЛНЭ (устгахгүй)", async () => {
  const prisma = fakePrisma();
  const r = await erasePsid(prisma, "psid-1");

  // Чат/lead/consultation/unanswered — бүрэн устгана
  const deletedModels = prisma._calls.filter((c) => c.op === "deleteMany").map((c) => c.model);
  assert.deepStrictEqual(deletedModels, ["turuuChat", "turuuLead", "turuuConsultation", "turuuUnanswered"]);
  assert.strictEqual(r.deleted.chats, 1);

  // Захиалга — НЭГ Ч deleteMany байхгүй, зөвхөн updateMany
  assert.ok(!deletedModels.includes("turuuOrder"), "захиалгыг устгах ЁСГҮЙ (нягтлан бодох бүртгэл)");
  const orderCall = prisma._calls.find((c) => c.model === "turuuOrder");
  assert.strictEqual(orderCall.op, "updateMany");
  assert.strictEqual(r.anonymized.orders, 1);
});

test("erasePsid захиалгын БҮХ таних талбарыг цэвэрлэнэ", async () => {
  const prisma = fakePrisma();
  await erasePsid(prisma, "psid-1");
  const { data } = prisma._calls.find((c) => c.model === "turuuOrder").args;

  assert.strictEqual(data.customerName, ANON);
  for (const field of ["customerPhone", "customerEmail", "deliveryAddress", "psid", "notes"]) {
    assert.strictEqual(data[field], null, `${field} цэвэрлэгдээгүй байна`);
  }
});

test("erasePsid orgId өгвөл зөвхөн тухайн байгууллагын хүрээнд ажиллана", async () => {
  const prisma = fakePrisma();
  await erasePsid(prisma, "psid-1", { orgId: "org-9" });
  for (const c of prisma._calls) {
    assert.deepStrictEqual(c.args.where, { psid: "psid-1", orgId: "org-9" });
  }
});

test("erasePsid psid хоосон бол юунд ч хүрэхгүй", async () => {
  const prisma = fakePrisma();
  const r = await erasePsid(prisma, null);
  assert.strictEqual(prisma._calls.length, 0);
  assert.deepStrictEqual(r, { deleted: {}, anonymized: {} });
});

test("erasePsid нэг загвар унасан ч бусад нь үргэлжилнэ", async () => {
  const prisma = fakePrisma();
  prisma.turuuChat.deleteMany = async () => { throw new Error("DB унасан"); };
  const r = await erasePsid(prisma, "psid-1");
  assert.strictEqual(r.deleted.chats, 0);        // унасан нь 0
  assert.strictEqual(r.deleted.leads, 1);        // бусад нь ажилласан
  assert.strictEqual(r.anonymized.orders, 1);
});

// ── eraseOrganization ───────────────────────────────────────────────────────

test("eraseOrganization өнчрөх хүснэгтүүдийг Organization-оос ӨМНӨ устгана", async () => {
  const prisma = fakePrisma();
  await eraseOrganization(prisma, "org-1");

  const idx = prisma._calls.findIndex((c) => c.model === "organization");
  assert.ok(idx > 0, "organization эхэнд устгагдаж болохгүй");

  // orgId нь relation биш тул cascade хүрэхгүй — эдгээр гараар устсан байх ёстой
  const before = prisma._calls.slice(0, idx).map((c) => c.model);
  for (const m of ["turuuChat", "turuuLead", "turuuKnowledge", "turuuSettings", "auditLog"]) {
    assert.ok(before.includes(m), `${m} гараар устгагдаагүй — өнчин мөр үлдэнэ`);
  }
});

test("eraseOrganization orgId-гүй бол алдаа шиднэ (санамсаргүй бүх өгөгдөл устгахаас сэргийлнэ)", async () => {
  const prisma = fakePrisma();
  await assert.rejects(() => eraseOrganization(prisma, null), /orgId/);
  assert.strictEqual(prisma._calls.length, 0);
});

test("eraseOrganization бүх дуудлага orgId-гээр хязгаарлагдана", async () => {
  const prisma = fakePrisma();
  await eraseOrganization(prisma, "org-1");
  for (const c of prisma._calls) {
    if (c.model === "organization") assert.deepStrictEqual(c.args.where, { id: "org-1" });
    else assert.deepStrictEqual(c.args.where, { orgId: "org-1" });
  }
});
