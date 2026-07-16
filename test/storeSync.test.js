"use strict";
// KB (TuruuKnowledge) → вэбсайтын бараа (Product) хөрвүүлэлт.
// Энд эвдрэл гарвал БҮХ бизнесийн БҮХ бараа вэбсайт дээр буруу үнэ/нөөцтэй харагдана.
const { test } = require("node:test");
const assert = require("node:assert");
const { isProductKnowledge, mapKnowledgeToProduct, pickVariantIndex, toStoreVariants } = require("../src/services/storeSync.service");

// ── isProductKnowledge: аль KB нь бараа вэ ──
test("isProductKnowledge зөвхөн 'Бүтээгдэхүүн' ангиллыг бараа гэж үзнэ", () => {
  assert.ok(isProductKnowledge({ category: "Бүтээгдэхүүн" }));
  assert.ok(isProductKnowledge({ category: "Бүтээгдэхүүн / Гутал" }));
  assert.ok(isProductKnowledge({ category: "Бүтээгдэхүүн / Гутал / Пүүз" }));
  assert.ok(!isProductKnowledge({ category: "Түгээмэл асуулт" }), "ФАҮ бараа БИШ");
  assert.ok(!isProductKnowledge({ category: "Хүргэлт" }), "хүргэлтийн мэдээлэл бараа БИШ");
  assert.ok(!isProductKnowledge({ category: null }));
  assert.ok(!isProductKnowledge({}));
  assert.ok(!isProductKnowledge(null));
});

// ── Үнэ задлах (хамгийн эмзэг хэсэг) ──
test("mapKnowledgeToProduct таслалтай үнийг зөв задална", () => {
  const p = mapKnowledgeToProduct({ question: "Nike", answer: "Үнэ: 149,000₮. Сонгодог цагаан пүүз." });
  assert.strictEqual(p.price, 149000);
  assert.strictEqual(p.description, "Сонгодог цагаан пүүз.");
});

test("mapKnowledgeToProduct таслалгүй/₮-гүй үнийг ч задална", () => {
  assert.strictEqual(mapKnowledgeToProduct({ question: "A", answer: "Үнэ: 5000" }).price, 5000);
  assert.strictEqual(mapKnowledgeToProduct({ question: "A", answer: "Үнэ: 5000₮" }).price, 5000);
});

test("mapKnowledgeToProduct үнэгүй answer-т price=0, тайлбар бүтэн үлдэнэ", () => {
  const p = mapKnowledgeToProduct({ question: "A", answer: "Зөвхөн тайлбар байна" });
  assert.strictEqual(p.price, 0);
  assert.strictEqual(p.description, "Зөвхөн тайлбар байна");
});

// ── Ангилал ──
test("mapKnowledgeToProduct дэд ангиллыг гаргаж авна", () => {
  assert.strictEqual(mapKnowledgeToProduct({ question: "A", answer: "", category: "Бүтээгдэхүүн / Гутал" }).category, "Гутал");
  assert.strictEqual(mapKnowledgeToProduct({ question: "A", answer: "", category: "Бүтээгдэхүүн" }).category, null);
});

// ── Нөөц: variant нийлбэр, variant-гүй бол хязгааргүй ──
test("mapKnowledgeToProduct нөөцийг variant-уудын НИЙЛБЭРЭЭР тооцно", () => {
  const p = mapKnowledgeToProduct({
    question: "A", answer: "Үнэ: 1000",
    variants: [{ size: "42", stock: 3 }, { size: "43", stock: 2 }],
  });
  assert.strictEqual(p.stock, 5);
});

test("mapKnowledgeToProduct variant-гүй бараанд 'үргэлж бэлэн' (999) тавина", () => {
  assert.strictEqual(mapKnowledgeToProduct({ question: "A", answer: "Үнэ: 1000", variants: [] }).stock, 999);
  assert.strictEqual(mapKnowledgeToProduct({ question: "A", answer: "Үнэ: 1000" }).stock, 999);
});

test("mapKnowledgeToProduct бүх variant дууссан бол нөөц 0", () => {
  const p = mapKnowledgeToProduct({ question: "A", answer: "Үнэ: 1000", variants: [{ size: "42", stock: 0 }] });
  assert.strictEqual(p.stock, 0);
});

// ── Зураг: үндсэн + variant, давхардалгүй ──
test("mapKnowledgeToProduct үндсэн болон variant зургийг давхардалгүй цуглуулна", () => {
  const p = mapKnowledgeToProduct({
    question: "A", answer: "", imageUrl: "main.jpg",
    variants: [{ color: "Цагаан", imageUrl: "white.jpg" }, { color: "Хар", imageUrl: "black.jpg" }, { color: "Улаан", imageUrl: "white.jpg" }],
  });
  assert.deepStrictEqual(p.images, ["main.jpg", "white.jpg", "black.jpg"]);
});

test("mapKnowledgeToProduct зураггүй бол хоосон массив", () => {
  assert.deepStrictEqual(mapKnowledgeToProduct({ question: "A", answer: "" }).images, []);
});

// ── active / нэр / үзүүлэлт ──
test("mapKnowledgeToProduct нэр, active, үзүүлэлтийг зөв дамжуулна", () => {
  const p = mapKnowledgeToProduct({ question: "Nike Air", answer: "", active: false, attributes: { Материал: "Арьс" } });
  assert.strictEqual(p.name, "Nike Air");
  assert.strictEqual(p.active, false);
  assert.deepStrictEqual(p.attributes, { Материал: "Арьс" });
  // active тодорхойгүй бол идэвхтэй гэж үзнэ
  assert.strictEqual(mapKnowledgeToProduct({ question: "A", answer: "" }).active, true);
  assert.strictEqual(mapKnowledgeToProduct({ question: "A", answer: "" }).attributes, null);
});

// ── toStoreVariants: KB {size,color} → storefront {name,values} ──
// Энэ хөрвүүлэлт эвдэрвэл storefront дээр размер/өнгө selector ОГТ гарахгүй болно.
test("toStoreVariants размер+өнгөг тусдаа тэнхлэг болгоно (давхардалгүй)", () => {
  const r = toStoreVariants([
    { size: "42", color: "Цагаан", stock: 3 },
    { size: "43", color: "Хар", stock: 2 },
    { size: "42", color: "Хар", stock: 1 },
  ]);
  assert.deepStrictEqual(r, [
    { name: "Размер", values: ["42", "43"] },
    { name: "Өнгө", values: ["Цагаан", "Хар"] },
  ]);
});

test("toStoreVariants нь storefront-ийн шаардлагыг хангана (name + values[])", () => {
  const r = toStoreVariants([{ size: "M", stock: 5 }]);
  // ProductDetail.tsx filter: v.name && v.values?.length
  for (const v of r) { assert.ok(v.name); assert.ok(Array.isArray(v.values) && v.values.length > 0); }
});

test("toStoreVariants зөвхөн нэг тэнхлэгтэй бол нэгийг л буцаана", () => {
  assert.deepStrictEqual(toStoreVariants([{ size: "42", stock: 1 }, { size: "43", stock: 1 }]),
    [{ name: "Размер", values: ["42", "43"] }]);
  assert.deepStrictEqual(toStoreVariants([{ color: "Улаан", stock: 1 }]),
    [{ name: "Өнгө", values: ["Улаан"] }]);
});

test("toStoreVariants дууссан (stock<=0) утгыг харуулахгүй", () => {
  const r = toStoreVariants([{ size: "42", stock: 0 }, { size: "43", stock: 5 }]);
  assert.deepStrictEqual(r, [{ name: "Размер", values: ["43"] }]);
});

test("toStoreVariants бүгд дууссан бол бүх утгыг харуулна (мэдээллийн төлөө)", () => {
  const r = toStoreVariants([{ size: "42", stock: 0 }, { size: "43", stock: 0 }]);
  assert.deepStrictEqual(r, [{ name: "Размер", values: ["42", "43"] }]);
});

test("toStoreVariants variant-гүй бол хоосон массив", () => {
  assert.deepStrictEqual(toStoreVariants([]), []);
  assert.deepStrictEqual(toStoreVariants(null), []);
  assert.deepStrictEqual(toStoreVariants(undefined), []);
});

test("mapKnowledgeToProduct variants-ыг storefront хэлбэрээр буцаана (selector гарна)", () => {
  const p = mapKnowledgeToProduct({
    question: "Пүүз", answer: "Үнэ: 100",
    variants: [{ size: "42", color: "Цагаан", stock: 2 }, { size: "43", color: "Цагаан", stock: 1 }],
  });
  // {name,values} хэлбэртэй, KB {size,color} хэлбэр БИШ
  assert.ok(p.variants.every((v) => v.name && Array.isArray(v.values)));
  assert.deepStrictEqual(p.variants.find((v) => v.name === "Размер").values, ["42", "43"]);
  assert.deepStrictEqual(p.variants.find((v) => v.name === "Өнгө").values, ["Цагаан"]);
  // Нөөц нь ХУУЧНААР variant-уудын нийлбэрээс (2+1=3) — хөрвүүлэлт нөөцийг эвдээгүй
  assert.strictEqual(p.stock, 3);
});

// ── pickVariantIndex: вэбсайтын захиалга → аль variant-аас нөөц хасах ──
const VARIANTS = [
  { size: "42", color: "Цагаан", stock: 3 },
  { size: "43", color: "Хар", stock: 2 },
  { size: "42", color: "Хар", stock: 1 },
];

test("pickVariantIndex размер+өнгө хоёулаа таарвал ЯГ түүнийг сонгоно", () => {
  assert.strictEqual(pickVariantIndex(VARIANTS, "42 / Хар"), 2);
  assert.strictEqual(pickVariantIndex(VARIANTS, "43 / Хар"), 1);
  assert.strictEqual(pickVariantIndex(VARIANTS, "42 / Цагаан"), 0);
});

test("pickVariantIndex зөвхөн нэг талбар таарвал эхний тохирохыг сонгоно", () => {
  assert.strictEqual(pickVariantIndex(VARIANTS, "Цагаан"), 0);
  assert.strictEqual(pickVariantIndex(VARIANTS, "43"), 1);
});

test("pickVariantIndex зай/том жижиг үсгийг үл тоомсорлоно", () => {
  assert.strictEqual(pickVariantIndex(VARIANTS, "42/хар"), 2);
  assert.strictEqual(pickVariantIndex(VARIANTS, "  42 / ХАР  "), 2);
});

test("pickVariantIndex тохирохгүй бол нөөцтэй эхнийг сонгоно (нийт нөөц зөв үлдэнэ)", () => {
  const vs = [{ size: "40", stock: 0 }, { size: "41", stock: 5 }];
  assert.strictEqual(pickVariantIndex(vs, "ямар ч тохирохгүй"), 1);
});

test("pickVariantIndex variant огт байхгүй бол -1", () => {
  assert.strictEqual(pickVariantIndex([], "42"), -1);
  assert.strictEqual(pickVariantIndex(null, "42"), -1);
});
