"use strict";
// Хувийн мэдээлэл устгах / нэргүйжүүлэх ГАНЦ цэг.
//
// Хоёр өөр шаардлагыг зэрэг хангана:
//   1. Хүний "миний мэдээллийг устга" эрх (Facebook Data Deletion Callback, эцсийн
//      хэрэглэгчийн хүсэлт) — тухайн ХҮНий мэдээллийг арилгана.
//   2. Мерчантын нягтлан бодох бүртгэлийн шаардлага — захиалгын ДҮН, огноо үлдэх ёстой.
//
// Тиймээс захиалгыг УСТГАХГҮЙ, харин таних мэдээллийг нь арилгана (anonymize):
// нэр/утас/и-мэйл/хаяг/psid цэвэрлэгдэж, дүн ба огноо хэвээр үлдэнэ. Чат, lead,
// consultation зэрэг цэвэр PII бичлэгийг бүрэн устгана.

const ANON = "[устгасан]";

// Нэг PSID (Facebook хэрэглэгч)-ийн бүх мэдээллийг устгана/нэргүйжүүлнэ.
// Буцаах: { deleted: {...}, anonymized: {...} } — тоолол (тайлагналд).
async function erasePsid(prisma, psid, { orgId = null } = {}) {
  if (!psid) return { deleted: {}, anonymized: {} };
  const where = orgId ? { psid, orgId } : { psid };
  const deleted = {};
  const anonymized = {};

  // ── Бүрэн устгах (цэвэр PII, бизнесийн бүртгэлийн үнэ цэнэгүй) ──
  for (const [key, model] of [
    ["chats", "turuuChat"],
    ["leads", "turuuLead"],
    ["consultations", "turuuConsultation"],
    ["unanswered", "turuuUnanswered"],
  ]) {
    try {
      const r = await prisma[model].deleteMany({ where });
      deleted[key] = r.count;
    } catch { deleted[key] = 0; }
  }

  // ── Нэргүйжүүлэх (санхүүгийн бүртгэл хэвээр үлдэнэ) ──
  try {
    const r = await prisma.turuuOrder.updateMany({
      where,
      data: { customerName: ANON, customerPhone: null, customerEmail: null, deliveryAddress: null, psid: null, notes: null },
    });
    anonymized.orders = r.count;
  } catch { anonymized.orders = 0; }

  try {
    const r = await prisma.turuuAppointment.updateMany({
      where,
      data: { customerName: ANON, customerPhone: null, psid: null, notes: null },
    });
    anonymized.appointments = r.count;
  } catch { anonymized.appointments = 0; }

  try {
    const r = await prisma.turuuReservation.updateMany({
      where,
      data: { customerName: ANON, customerPhone: null, psid: null, notes: null },
    });
    anonymized.reservations = r.count;
  } catch { anonymized.reservations = 0; }

  return { deleted, anonymized };
}

// Дэлгүүрийн худалдан авагчийг утсаар нь нэргүйжүүлнэ (storefront-д psid байхгүй).
async function eraseStoreCustomer(prisma, { phone, email }) {
  if (!phone && !email) return { anonymized: { storeOrders: 0 } };
  const or = [];
  if (phone) or.push({ customerPhone: String(phone) });
  if (email) or.push({ customerEmail: String(email) });
  try {
    const r = await prisma.storeOrder.updateMany({
      where: { OR: or },
      data: { customerName: ANON, customerPhone: null, customerEmail: null, deliveryAddress: null, notes: null },
    });
    return { anonymized: { storeOrders: r.count } };
  } catch {
    return { anonymized: { storeOrders: 0 } };
  }
}

// Байгууллагын БҮХ мэдээллийг устгана (бүртгэл хаах).
// schema.prisma-д зарим хүснэгт orgId-г ЭНГИЙН String-ээр хадгалдаг (relation биш) тул
// Organization-ыг устгахад cascade хүрэхгүй — эдгээрийг ГАРААР эхлээд устгана,
// эс тэгвэл өнчин мөр үлдэж, "устгасан" гэсэн амлалт худал болно.
const ORPHAN_MODELS = [
  "turuuChat", "turuuLead", "turuuConsultation", "turuuUnanswered",
  "turuuKnowledge", "turuuSettings", "turuuStaff", "turuuMenuItem",
  "turuuTable", "turuuOrder", "auditLog", "domainOrder", "webWalletTx",
];

async function eraseOrganization(prisma, orgId) {
  if (!orgId) throw new Error("orgId шаардлагатай");
  const removed = {};

  for (const model of ORPHAN_MODELS) {
    try {
      const r = await prisma[model].deleteMany({ where: { orgId } });
      removed[model] = r.count;
    } catch { /* тухайн хүснэгт байхгүй бол алгасна */ }
  }
  // Хэтэвч (orgId нь unique)
  try { await prisma.webWallet.deleteMany({ where: { orgId } }); } catch { /* no-op */ }

  // Эцэст нь байгууллага — relation-той хүснэгтүүд (Store, StaffMember, Product,
  // StoreOrder, TuruuAppointment, TuruuReservation ...) cascade-аар устна.
  await prisma.organization.delete({ where: { id: orgId } });
  removed.organization = 1;
  return removed;
}

module.exports = { erasePsid, eraseStoreCustomer, eraseOrganization, ANON };
