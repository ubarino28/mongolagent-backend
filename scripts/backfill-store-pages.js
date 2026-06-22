"use strict";
/**
 * Нэг удаагийн backfill — одоо байгаа бүх дэлгүүрт дутуу default хуудсуудыг
 * (Бидний тухай / Захиалга хянах / Барааны хуудас) нэмнэ. Аль хэдийн байгаа замыг алгасна.
 *
 * Ажиллуулах: node scripts/backfill-store-pages.js
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { defaultExtraPages } = require("../src/lib/storeTemplates");

const prisma = new PrismaClient();

(async () => {
  const stores = await prisma.store.findMany({ select: { id: true, slug: true } });
  console.log(`Нийт ${stores.length} дэлгүүр шалгаж байна...`);
  let added = 0;
  for (const s of stores) {
    const existing = await prisma.storePage.findMany({ where: { storeId: s.id }, select: { path: true } });
    const have = new Set(existing.map((p) => p.path));
    let order = existing.length;
    for (const page of defaultExtraPages()) {
      if (have.has(page.path)) continue;
      await prisma.storePage.create({
        data: { storeId: s.id, title: page.title, path: page.path, type: page.type, content: page.content, published: true, sortOrder: order++ },
      });
      added++;
      console.log(`  + ${s.slug}: ${page.title} (${page.path})`);
    }
  }
  console.log(`Дууслаа. ${added} хуудас нэмэгдлээ.`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
