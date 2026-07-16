"use strict";
// Хуучин мэдлэгийн сан (TuruuKnowledge) дахь бараануудыг вэбсайтын Product руу нэг удаа нэгтгэнэ.
// storeSync давхарга нэмэгдэхээс ӨМНӨ орсон бараанууд холбогдоогүй байдаг тул энэ скриптийг
// нэг удаа ажиллуулж бүх Store-той org-ийн бараануудыг синк хийнэ.
//
// Хэрэглээ:
//   node scripts/backfillStoreProducts.js                  → бүх Store-той org
//   node scripts/backfillStoreProducts.js <orgId|email>    → зөвхөн нэг org
//   ... --clean-demos гэж нэмбэл KB-д холбоогүй (demo/seed) Product-уудыг устгана
require("dotenv").config();
const { getPrisma } = require("../src/lib/db");
const storeSync = require("../src/services/storeSync.service");

const PRODUCT_PREFIX = "Бүтээгдэхүүн";

async function main() {
  const prisma = getPrisma();
  const args = process.argv.slice(2);
  const cleanDemos = args.includes("--clean-demos");
  const target = args.find((a) => !a.startsWith("--"));

  // Хамрах org-уудыг тодорхойлно
  let orgIds;
  if (target) {
    const org = target.includes("@")
      ? await prisma.organization.findUnique({ where: { email: target }, select: { id: true } })
      : await prisma.organization.findUnique({ where: { id: target }, select: { id: true } });
    if (!org) { console.error("Org олдсонгүй:", target); process.exit(1); }
    orgIds = [org.id];
  } else {
    const stores = await prisma.store.findMany({ select: { orgId: true } });
    orgIds = [...new Set(stores.map((s) => s.orgId))];
  }
  console.log(`Хамрах org: ${orgIds.length}`);

  let totalSynced = 0, totalRemoved = 0;
  for (const orgId of orgIds) {
    const store = await prisma.store.findUnique({ where: { orgId }, select: { id: true } });
    if (!store) { console.log(`  ${orgId}: Store байхгүй — алгасав`); continue; }

    // 1) KB бараануудыг синк
    const kbProducts = await prisma.turuuKnowledge.findMany({
      where: { orgId, category: { startsWith: PRODUCT_PREFIX } },
    });
    let synced = 0;
    for (const kb of kbProducts) {
      const r = await storeSync.syncKnowledgeToStore(orgId, kb);
      if (r.ok && (r.action === "created" || r.action === "updated")) synced++;
    }
    totalSynced += synced;

    // 2) Сонголтоор: KB-д холбоогүй (demo/seed) Product-уудыг устгах
    let removed = 0;
    if (cleanDemos) {
      const res = await prisma.product.deleteMany({ where: { storeId: store.id, knowledgeId: null } });
      removed = res.count;
      totalRemoved += removed;
    }
    console.log(`  ${orgId}: ${kbProducts.length} KB бараа → ${synced} синк${cleanDemos ? `, ${removed} demo устгав` : ""}`);
  }

  console.log(`\n✅ Нийт ${totalSynced} бараа синк${cleanDemos ? `, ${totalRemoved} demo устгав` : ""}`);
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
