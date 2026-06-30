"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

const { timingEqual } = require("../src/lib/timingEqual");
const { mapLimit } = require("../src/lib/concurrency");
const cache = require("../src/lib/cache");
const secret = require("../src/lib/secretCrypto");

test("timingEqual ижил мөрт true, ялгаатайд false", () => {
  assert.strictEqual(timingEqual("abc123", "abc123"), true);
  assert.strictEqual(timingEqual("abc123", "abc124"), false);
  assert.strictEqual(timingEqual("short", "longerstring"), false); // урт ялгаатай
  assert.strictEqual(timingEqual(null, null), true);
  assert.strictEqual(timingEqual(undefined, ""), true);
});

test("mapLimit бүх item-ийг боловсруулж, дарааллыг хадгална", async () => {
  const items = [1, 2, 3, 4, 5];
  const out = await mapLimit(items, 2, async (x) => x * 10);
  assert.deepStrictEqual(out, [10, 20, 30, 40, 50]);
});

test("mapLimit нэг item алдвал бусдыг зогсоохгүй", async () => {
  const out = await mapLimit([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error("boom"); return x; });
  assert.strictEqual(out[0], 1);
  assert.ok(out[1] && out[1].__error instanceof Error);
  assert.strictEqual(out[2], 3);
});

test("cache getOrSet кэшилж, TTL дотор fn-ийг дахин дуудахгүй", async () => {
  let calls = 0;
  const fn = async () => { calls++; return "val"; };
  const a = await cache.getOrSet("t:1", 1000, fn);
  const b = await cache.getOrSet("t:1", 1000, fn);
  assert.strictEqual(a, "val");
  assert.strictEqual(b, "val");
  assert.strictEqual(calls, 1); // зөвхөн нэг удаа
});

test("secretCrypto: түлхүүргүй бол NO-OP (passthrough)", () => {
  delete process.env.ENCRYPTION_KEY;
  assert.strictEqual(secret.isEnabled(), false);
  assert.strictEqual(secret.encrypt("hello"), "hello");
  assert.strictEqual(secret.decrypt("hello"), "hello");
});

test("secretCrypto: түлхүүртэй бол encrypt→decrypt round-trip + plaintext fallback", () => {
  process.env.ENCRYPTION_KEY = "0".repeat(64); // 32 байт hex
  const enc = secret.encrypt("super-secret-token");
  assert.ok(enc.startsWith(secret.PREFIX), "шифрлэгдсэн утга угтвартай байх ёстой");
  assert.notStrictEqual(enc, "super-secret-token");
  assert.strictEqual(secret.decrypt(enc), "super-secret-token");
  // хуучин plaintext (угтваргүй) утгыг хэвээр буцаана
  assert.strictEqual(secret.decrypt("legacy-plaintext"), "legacy-plaintext");
  delete process.env.ENCRYPTION_KEY;
});
