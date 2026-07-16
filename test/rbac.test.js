"use strict";
// Эрхийн дүрэм — АЮУЛГҮЙ БАЙДЛЫН логик. Энд эвдрэл гарвал "viewer" ажилтан
// мэдлэгийн санг устгах / нэвтрэх имэйл солих (бүртгэл булаах) боломжтой болно.
const { test } = require("node:test");
const assert = require("node:assert");
const { roleOf, isOwner, canWrite, requireOwner, blockViewerWrites } = require("../src/lib/rbac");

// Express middleware-г хуурамч req/res-ээр туршина
function run(mw, { role, method = "GET" }) {
  const req = { org: role === undefined ? {} : { role }, method };
  let status = null, body = null, nexted = false;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  mw(req, res, () => { nexted = true; });
  return { status, body, nexted };
}

// ── roleOf: танигдахгүй/дутуу role → owner (хуучин token-ууд эвдрэхгүй) ──
test("roleOf мэдэгдэж буй эрхийг таньж, бусдыг owner болгоно", () => {
  assert.strictEqual(roleOf({ org: { role: "staff" } }), "staff");
  assert.strictEqual(roleOf({ org: { role: "viewer" } }), "viewer");
  assert.strictEqual(roleOf({ org: { role: "owner" } }), "owner");
  assert.strictEqual(roleOf({ org: {} }), "owner", "role-гүй хуучин token → owner");
  assert.strictEqual(roleOf({}), "owner");
  assert.strictEqual(roleOf(null), "owner");
  // Хуурамч/танихгүй эрх нь ЭРХ ӨСГӨХГҮЙ — owner болно, гэхдээ token гарын үсэгтэй тул
  // үүнийг зөвхөн бидний өөрсдийн гаргасан token агуулж чадна
  assert.strictEqual(roleOf({ org: { role: "superadmin" } }), "owner");
});

test("isOwner зөвхөн эзэнд true", () => {
  assert.ok(isOwner("owner"));
  assert.ok(isOwner(undefined), "role-гүй → эзэн");
  assert.ok(!isOwner("staff"));
  assert.ok(!isOwner("viewer"));
});

// ── canWrite: viewer зөвхөн GET ──
test("canWrite — viewer зөвхөн GET хийнэ", () => {
  assert.ok(canWrite("viewer", "GET"));
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.ok(!canWrite("viewer", m), `viewer ${m} хийж БОЛОХГҮЙ`);
  }
});

test("canWrite — staff ба owner бүх үйлдэл хийнэ", () => {
  for (const role of ["staff", "owner", undefined]) {
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      assert.ok(canWrite(role, m), `${role} ${m} хийж болох ЁСТОЙ`);
    }
  }
});

test("canWrite жижиг үсэгтэй method-д ч ажиллана", () => {
  assert.ok(!canWrite("viewer", "post"), "жижиг үсгээр тойрч гарах ЁСГҮЙ");
  assert.ok(canWrite("viewer", "get"));
});

// ── blockViewerWrites middleware ──
test("blockViewerWrites — viewer бичихэд 403, харахад нэвтрүүлнэ", () => {
  const w = run(blockViewerWrites, { role: "viewer", method: "DELETE" });
  assert.strictEqual(w.status, 403);
  assert.ok(!w.nexted);
  const r = run(blockViewerWrites, { role: "viewer", method: "GET" });
  assert.ok(r.nexted);
});

test("blockViewerWrites — staff/owner/хуучин token-ыг саадгүй нэвтрүүлнэ", () => {
  assert.ok(run(blockViewerWrites, { role: "staff", method: "POST" }).nexted);
  assert.ok(run(blockViewerWrites, { role: "owner", method: "DELETE" }).nexted);
  assert.ok(run(blockViewerWrites, { role: undefined, method: "POST" }).nexted, "хуучин token эвдрэх ЁСГҮЙ");
});

// ── requireOwner middleware ──
test("requireOwner — зөвхөн эзнийг нэвтрүүлнэ", () => {
  assert.ok(run(requireOwner, { role: "owner" }).nexted);
  assert.ok(run(requireOwner, { role: undefined }).nexted, "хуучин эзний token → зөвшөөрнө");
  const s = run(requireOwner, { role: "staff" });
  assert.strictEqual(s.status, 403);
  assert.ok(!s.nexted, "staff мөнгө/бүртгэлд хүрэх ЁСГҮЙ");
  const v = run(requireOwner, { role: "viewer" });
  assert.strictEqual(v.status, 403);
  assert.ok(!v.nexted);
});

test("requireOwner — GET байсан ч ажилтныг блоклоно (багийн жагсаалт нууц)", () => {
  const s = run(requireOwner, { role: "staff", method: "GET" });
  assert.strictEqual(s.status, 403);
  assert.ok(!s.nexted);
});
