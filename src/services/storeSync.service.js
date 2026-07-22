"use strict";
// Мэдлэгийн сан (TuruuKnowledge) ↔ вэбсайтын бараа (Product) sync.
// Approach A: TuruuKnowledge-ийг эх сурвалж болгож, барааны өөрчлөлт бүрийг холбогдсон
// Product мөр рүү тусгана. AI-ийн хайлтын код (search_knowledge/check_menu) огт хөндөгдөхгүй —
// зөвхөн энэ давхарга нэмэгдэнэ. Store байхгүй org-д чимээгүй алгасна.
const { getPrisma } = require("../lib/db");

const PRODUCT_PREFIX = "Бүтээгдэхүүн";
const PRICE_RE = /^Үнэ:\s*([\d,.]+)\s*₮?\.?\s*/;

// KB item бараа мөн эсэх — category нь "Бүтээгдэхүүн"-ээр эхэлдэг
function isProductKnowledge(kb) {
  return typeof kb?.category === "string" && kb.category.split(" / ")[0].trim() === PRODUCT_PREFIX;
}

// "Бүтээгдэхүүн / Гутал" → "Гутал" (дэд ангилал)
function toStoreCategory(category) {
  if (!category) return null;
  const parts = category.split(" / ");
  return parts[1]?.trim() || null;
}

// answer-с үнэ + тайлбар салгах (frontend-ийн parseProductAnswer-тэй ижил)
function parseAnswer(answer) {
  const m = (answer || "").match(PRICE_RE);
  if (m) return { price: Number(m[1].replace(/,/g, "")) || 0, description: (answer || "").slice(m[0].length).trim() };
  return { price: 0, description: answer || "" };
}

// KB variant ({size,color,stock,imageUrl}) → storefront-ийн хүлээдэг хэлбэр ({name,values[]}).
// ЧУХАЛ: storefront (ProductDetail.tsx) болон website admin (VariantEditor) ХОЁУЛАА variant-ыг
// {name, values} хэлбэрээр уншдаг тул KB-гийн {size,color} хэлбэрийг хөрвүүлэхгүй бол
// filter (v.name && v.values) БҮГДИЙГ хаяж, размер/өнгө selector ОГТ гарахгүй байсан.
// Размер/өнгө нь ТУСДАА тэнхлэг — дууссан (stock<=0) утгыг харуулахгүй (сонголт цэвэрхэн).
function toStoreVariants(variants) {
  const arr = Array.isArray(variants) ? variants : [];
  const inStock = arr.filter((v) => v.stock == null || Number(v.stock) > 0);
  const pool = inStock.length ? inStock : arr; // бүгд дууссан ч сонголтыг харуулна (мэдээллийн төлөө)
  const uniq = (key) => [...new Set(pool.map((v) => v[key]).filter(Boolean))];
  const out = [];
  const sizes = uniq("size");
  const colors = uniq("color");
  if (sizes.length) out.push({ name: "Размер", values: sizes });
  if (colors.length) out.push({ name: "Өнгө", values: colors });
  return out;
}

// KB item → Product талбарууд
function mapKnowledgeToProduct(kb) {
  const { price, description } = parseAnswer(kb.answer);
  const variants = Array.isArray(kb.variants) ? kb.variants : [];
  // Store талд Product.stock ганц бүхэл тоо — variant тус бүрийн нөөцийн нийлбэр.
  // Variant огт байхгүй бол "үргэлж бэлэн" гэж үзэж өндөр sentinel тавина.
  const totalStock = variants.length
    ? variants.reduce((s, v) => s + (Number(v.stock) || 0), 0)
    : 999;
  // Зургууд: KB-ийн үндсэн зураг + variant тус бүрийн зураг (давхардалгүй)
  const imgs = [];
  if (kb.imageUrl) imgs.push(kb.imageUrl);
  for (const v of variants) if (v.imageUrl && !imgs.includes(v.imageUrl)) imgs.push(v.imageUrl);

  return {
    name: kb.question,
    description: description || null,
    price,
    images: imgs,
    // Product.variants-ыг ЗӨВХӨН storefront уншдаг (нөөц хасалт нь KB.variants дээр ажилладаг),
    // тиймээс энд storefront хэлбэрт хөрвүүлж хадгалахад аюулгүй.
    variants: toStoreVariants(variants),
    attributes: (kb.attributes && typeof kb.attributes === "object") ? kb.attributes : null, // үзүүлэлт (Чадал/Хүчдэл г.м)
    stock: totalStock,
    category: toStoreCategory(kb.category),
    active: kb.active !== false,
  };
}

// org-ийн Store-ийг ол (байхгүй бол null)
async function findStore(prisma, orgId) {
  return prisma.store.findUnique({ where: { orgId }, select: { id: true } });
}

// НЭГ KB item-ийг Store Product руу тусгах (upsert эсвэл бараа биш болсон бол устгах)
async function syncKnowledgeToStore(orgId, kb) {
  if (!orgId || !kb?.id) return { ok: false, reason: "invalid" };
  const prisma = getPrisma();
  try {
    const store = await findStore(prisma, orgId);
    if (!store) return { ok: false, reason: "no-store" };

    const existing = await prisma.product.findUnique({ where: { knowledgeId: kb.id }, select: { id: true } });

    // Бараа биш болсон (ангилал өөрчлөгдсөн) бол холбогдсон Product-ийг устгана
    if (!isProductKnowledge(kb)) {
      if (existing) { await prisma.product.delete({ where: { id: existing.id } }); return { ok: true, action: "deleted-nonproduct" }; }
      return { ok: true, action: "skipped-nonproduct" };
    }

    const data = mapKnowledgeToProduct(kb);
    if (existing) {
      await prisma.product.update({ where: { id: existing.id }, data });
      return { ok: true, action: "updated", productId: existing.id };
    }
    const created = await prisma.product.create({
      data: { ...data, storeId: store.id, orgId, knowledgeId: kb.id },
    });
    return { ok: true, action: "created", productId: created.id };
  } catch (e) {
    console.error("[storeSync] syncKnowledgeToStore:", e.message);
    return { ok: false, reason: e.message };
  }
}

// KB item устгагдахад холбогдсон Product-ийг устгах
async function removeStoreProductForKnowledge(orgId, kbId) {
  if (!orgId || !kbId) return;
  const prisma = getPrisma();
  try {
    await prisma.product.deleteMany({ where: { orgId, knowledgeId: kbId } });
  } catch (e) { console.error("[storeSync] removeStoreProductForKnowledge:", e.message); }
}

// Бүх KB устгагдахад (Дахин эхлүүлэх) — sync-ээр үүссэн бүх Product-ийг устгах
// (гараар нэмсэн, knowledgeId=null Product-уудад хүрэхгүй)
async function removeAllSyncedProducts(orgId) {
  if (!orgId) return;
  const prisma = getPrisma();
  try {
    await prisma.product.deleteMany({ where: { orgId, knowledgeId: { not: null } } });
  } catch (e) { console.error("[storeSync] removeAllSyncedProducts:", e.message); }
}

// Олон KB item-ийг зэрэг sync хийх (Builder AI-ийн bulk save-д)
async function syncManyKnowledgeToStore(orgId, kbItems) {
  const results = [];
  for (const kb of kbItems || []) results.push(await syncKnowledgeToStore(orgId, kb));
  return results;
}

// ─── Нөөц 2 тийш sync ─────────────────────────────────────────────────────────
// Загвар: KB (TuruuKnowledge.variants[].stock) = нөөцийн цорын ганц эх сурвалж.
// Product.stock = KB variant-уудын нийлбэрээс ТООЦООЛОГДоно. Аль ч сувгаар зарсан
// нөөц хасалт KB дээр хийгдэж, дараа нь Product.stock дахин derive хийгдэнэ.

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "").trim();

// Вэбсайт захиалгын нэг item-ийн variant-string-д тохирох KB variant-ыг ол.
// Тохирохгүй бол нөөцтэй эхний variant-ыг буцаана (нийт нөөц зөв хэвээр үлдэнэ).
function pickVariantIndex(variants, variantStr) {
  if (!Array.isArray(variants) || variants.length === 0) return -1;
  const v = norm(variantStr);
  if (v) {
    // size + color хоёулаа string дотор байвал давуу эрхтэй
    let idx = variants.findIndex((x) => x.size && x.color && v.includes(norm(x.size)) && v.includes(norm(x.color)));
    if (idx >= 0) return idx;
    idx = variants.findIndex((x) => (x.size && v.includes(norm(x.size))) || (x.color && v.includes(norm(x.color))));
    if (idx >= 0) return idx;
  }
  // Тохирохгүй → нөөцтэй эхний variant
  const stocked = variants.findIndex((x) => (x.stock || 0) > 0);
  return stocked >= 0 ? stocked : 0;
}

// Вэбсайт захиалга (StoreOrder) төлөгдөхөд — холбогдсон KB барааны нөөцийг хасаад
// Product.stock-ийг KB-аас дахин derive хийнэ. knowledgeId-гүй (вэбсайт-only) бараанд хүрэхгүй.
async function decrementKnowledgeForStoreOrder(orgId, items) {
  if (!orgId || !Array.isArray(items) || items.length === 0) return;
  const prisma = getPrisma();
  try {
    const touchedKbIds = new Set();
    let guessed = false;
    for (const it of items) {
      const productId = it.productId;
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      if (!productId) continue;

      const product = await prisma.product.findUnique({ where: { id: productId }, select: { knowledgeId: true } });
      if (!product?.knowledgeId) continue; // вэбсайт-only бараа — KB-д холбоогүй, Product.stock аль хэдийн хасагдсан
      const kbId = product.knowledgeId;

      // АТОМИК: KB мөрийг FOR UPDATE-ээр түгжиж read-modify-write хийнэ. (Өмнө lock-гүй JSON
      //  массив уншиж-хасаж-бичдэг тул сувгууд хооронд (Messenger vs website) зэрэг захиалга
      //  сүүлийн ширхгийг хоёулаа зарж болдог байв.) Түгжээ transaction дуустал барина.
      const r = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM "TuruuKnowledge" WHERE id = $1 FOR UPDATE', kbId);
        const kb = await tx.turuuKnowledge.findUnique({ where: { id: kbId } });
        if (!kb) return { touched: false };
        const variants = Array.isArray(kb.variants) ? kb.variants.map((v) => ({ ...v })) : [];
        if (variants.length === 0) return { touched: false }; // variant-гүй = нөөц хязгааргүй
        const idx = pickVariantIndex(variants, it.variant);
        if (idx < 0) return { touched: false };
        // Яг таарсан эсэх (size/color нь variant string-д байгаа эсэх) — үгүй бол "таамагласан"
        const nv = norm(it.variant);
        const exact = !!nv && variants.some((x) => (x.size && nv.includes(norm(x.size))) || (x.color && nv.includes(norm(x.color))));
        variants[idx] = { ...variants[idx], stock: Math.max(0, (variants[idx].stock || 0) - qty) };
        await tx.turuuKnowledge.update({ where: { id: kb.id }, data: { variants } });
        return { touched: true, guessed: !exact };
      });
      if (r.touched) touchedKbIds.add(kbId);
      if (r.guessed) guessed = true;
    }
    // #26: variant тодорхойлж чадаагүй (таамагласан) бол эзэнд мэдэгдэж нөөцийг гараар шалгуулна
    if (guessed) {
      try {
        require("./notify.service").notifyOwner(orgId, "⚠️ Захиалгын variant тодорхойгүй",
          { Анхаар: "Барааны размер/өнгийг захиалгаас тодорхойлж чадсангүй — холбогдох нөөцийг гараар шалгана уу" },
          { label: "Бараа харах", path: "/website/products" }).catch(() => {});
      } catch { /* мэдэгдэл — үндсэн урсгалд нөлөөлөхгүй */ }
    }
    // Хасалтын дараа холбогдсон Product.stock-ийг KB-аас дахин derive хийнэ
    for (const kbId of touchedKbIds) {
      const fresh = await prisma.turuuKnowledge.findUnique({ where: { id: kbId } });
      if (fresh) await syncKnowledgeToStore(orgId, fresh);
    }
  } catch (e) {
    console.error("[storeSync] decrementKnowledgeForStoreOrder:", e.message);
  }
}

module.exports = {
  syncKnowledgeToStore,
  syncManyKnowledgeToStore,
  removeStoreProductForKnowledge,
  removeAllSyncedProducts,
  decrementKnowledgeForStoreOrder,
  isProductKnowledge,
  mapKnowledgeToProduct,
  pickVariantIndex,   // тестэд ашиглана (нөөц хасалтын variant сонголт)
  toStoreVariants,    // тестэд ашиглана (KB→storefront variant хөрвүүлэлт)
};
