"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { stem, normalizeMongol, wordMatch, overlapScore } = require("../src/lib/mongolStem");

// KB item-ийг (question+answer+category) үндэс болгож бэлдэнэ
function kb(q, a, c = "") { return normalizeMongol(`${q} ${a} ${c}`); }

// Бодит дэлгүүрийн KB
const ITEMS = [
  { key: "гутал", words: kb("Nike Air Force гутал", "149000₮", "Бүтээгдэхүүн / Гутал") },
  { key: "гутал2", words: kb("Adidas Superstar гутал", "129000₮", "Бүтээгдэхүүн / Гутал") },
  { key: "цамц", words: kb("Nike Tech Fleece цамц", "119000₮", "Бүтээгдэхүүн / Хувцас") },
  { key: "хүргэлт", words: kb("Хүргэлт", "УБ дотор 5000₮, 100000-аас дээш үнэгүй") },
  { key: "цаг", words: kb("Ажлын цаг", "Даваа-Баасан 10:00-20:00") },
  { key: "буцаалт", words: kb("Буцаалт", "7 хоногт гажигтай бол солино") },
];
function search(query) {
  const q = normalizeMongol(query);
  return ITEMS.map((it) => ({ it, s: overlapScore(q, it.words) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.it.key);
}
function found(query, expectKey) { return search(query).some((k) => k.startsWith(expectKey)); }

// ── stem: гээгдэх эгшиг + дагавар ──
test("stem нугалсан хэлбэрүүдийг ижил үндэс рүү авчирна", () => {
  assert.strictEqual(stem("гутлын"), stem("гутал")); // гутал↔гутлын
  assert.strictEqual(stem("цамцны"), stem("цамц"));
  assert.ok(wordMatch(stem("хүргэдэг"), stem("хүргэлт")) || wordMatch(stem("хүргэлт"), stem("хүргэдэг")));
});

// ── wordMatch: prefix + fuzzy ──
test("wordMatch prefix ба typo-г таарна", () => {
  assert.ok(wordMatch("гутл", "гутлаа"));      // prefix
  assert.ok(wordMatch("гутил", "гутал") || wordMatch(stem("гутил"), stem("гутал"))); // typo
  assert.ok(!wordMatch("ус", "улс"));          // богино → false positive-ээс сэргийлнэ
});

// ── Бодит хайлтын battery (search_test.js-тэй ижил) ──
const CASES = [
  ["гутал байна уу", "гутал"],
  ["гутлын үнэ хэд вэ", "гутал"],
  ["пүүз юу байна", "гутал"],
  ["хямдхан гутал байгаа юу", "гутал"],
  ["гутил байгаа юу", "гутал"],
  ["хүргэдэг үү", "хүргэлт"],
  ["хэдэн цагт онгойдог вэ", "цаг"],
  ["буцааж болох уу", "буцаалт"],
  ["цамцны үнэ", "цамц"],
];
for (const [q, exp] of CASES) {
  test(`хайлт: "${q}" → ${exp} олдоно`, () => {
    assert.ok(found(q, exp), `"${q}" нь ${exp}-г олох ёстой. Гарсан: ${JSON.stringify(search(q))}`);
  });
}
