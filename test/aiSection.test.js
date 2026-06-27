"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { sanitizeBlock } = require("../src/services/aiSection.service");

test("sanitizeBlock зөвшөөрөгдөөгүй төрлийг хасна", () => {
  assert.strictEqual(sanitizeBlock({ type: "ProductGrid", props: {} }), null);
  assert.strictEqual(sanitizeBlock({ type: "ScriptInject", props: {} }), null);
  assert.strictEqual(sanitizeBlock(null), null);
});

test("sanitizeBlock зөвшөөрөгдсөн props-ийг үлдээж, бусдыг хасна", () => {
  const r = sanitizeBlock({ type: "Hero", props: { heading: "Сайн уу", subheading: "Тест", evil: "<script>", ctaHref: "javascript:alert(1)" } });
  assert.strictEqual(r.type, "Hero");
  assert.strictEqual(r.props.heading, "Сайн уу");
  assert.strictEqual(r.props.subheading, "Тест");
  assert.ok(!("evil" in r.props));
  assert.ok(!("ctaHref" in r.props)); // ctaHref зөвшөөрөгдөөгүй (зөвхөн heading/subheading/ctaText)
});

test("sanitizeBlock array item icon-г баталгаажуулна", () => {
  const r = sanitizeBlock({ type: "Features", props: { heading: "Давуу тал", items: [{ title: "А", text: "Б", icon: "nonexistent" }, { title: "В", text: "Г", icon: "truck" }] } });
  assert.strictEqual(r.props.items[0].icon, "star"); // буруу icon → star
  assert.strictEqual(r.props.items[1].icon, "truck");
  assert.strictEqual(r.props.items.length, 2);
});

test("sanitizeBlock rating-г 1..5 хооронд барина", () => {
  const r = sanitizeBlock({ type: "Testimonials", props: { items: [{ name: "Х", text: "сайхан", rating: "99" }, { name: "У", text: "муу", rating: "-3" }] } });
  assert.strictEqual(r.props.items[0].rating, "5");
  assert.strictEqual(r.props.items[1].rating, "0");
});

test("sanitizeBlock items-г 8-аар хязгаарлана", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: "x" }));
  const r = sanitizeBlock({ type: "Stats", props: { items } });
  assert.strictEqual(r.props.items.length, 8);
});