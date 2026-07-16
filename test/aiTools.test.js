"use strict";
// AI tool тодорхойлолтуудын дундын модуль (Messenger + тест-чат ХОЁУЛАА эндээс татдаг).
// Энд эвдрэл гарвал 2 гадаргуугийн зан төлөв чимээгүй зөрнө — тиймээс хамгаалж тестлэнэ.
const { test } = require("node:test");
const assert = require("node:assert");
const { TOOLS, pickTools, toolsForType, TOOLS_BY_TYPE, GROWTH_ONLY_TOOLS } = require("../src/lib/aiTools");

const names = (list) => list.map((t) => t.function.name);

// ── Бүтцийн бүрэн бүтэн байдал ──
test("TOOLS бүр зөв OpenAI function-tool бүтэцтэй", () => {
  assert.ok(TOOLS.length > 0, "TOOLS хоосон байж болохгүй");
  for (const t of TOOLS) {
    assert.strictEqual(t.type, "function", `${JSON.stringify(t)} → type=function байх ёстой`);
    assert.ok(t.function?.name, "function.name байх ёстой");
    assert.ok(t.function?.description, `${t.function.name}: description байх ёстой`);
    assert.strictEqual(t.function?.parameters?.type, "object", `${t.function.name}: parameters.type=object байх ёстой`);
  }
});

test("tool-ийн нэр давхардаагүй", () => {
  const n = names(TOOLS);
  assert.strictEqual(new Set(n).size, n.length, `давхардсан нэр: ${JSON.stringify(n)}`);
});

// ── pickTools (тест-чат subset угсрахад) ──
test("pickTools зөвхөн хүссэн tool-ийг буцаана", () => {
  const picked = pickTools(["search_knowledge", "save_order"]);
  assert.deepStrictEqual(names(picked).sort(), ["save_order", "search_knowledge"]);
});

test("pickTools байхгүй нэрийг чимээгүй алгасна", () => {
  const picked = pickTools(["search_knowledge", "ийм_tool_байхгүй"]);
  assert.deepStrictEqual(names(picked), ["search_knowledge"]);
});

test("pickTools хоосон жагсаалтад хоосон буцаана", () => {
  assert.deepStrictEqual(pickTools([]), []);
});

// ── toolsForType (бизнес төрлөөр шүүх) ──
test("shop төрөлд захиалгын tool нээлттэй, цаг/ширээнийх хаалттай", () => {
  const n = names(toolsForType("shop"));
  for (const need of ["search_knowledge", "check_menu", "save_order", "check_order", "confirm_payment"]) {
    assert.ok(n.includes(need), `shop-д ${need} байх ЁСТОЙ`);
  }
  for (const no of ["check_staff", "save_appointment", "check_tables", "save_reservation"]) {
    assert.ok(!n.includes(no), `shop-д ${no} байх ЁСГҮЙ`);
  }
});

test("salon төрөлд цаг захиалгын tool нээлттэй, дэлгүүрийнх хаалттай", () => {
  const n = names(toolsForType("salon"));
  for (const need of ["check_staff", "check_availability", "save_appointment", "reschedule_appointment"]) {
    assert.ok(n.includes(need), `salon-д ${need} байх ЁСТОЙ`);
  }
  for (const no of ["save_order", "check_menu", "check_tables"]) {
    assert.ok(!n.includes(no), `salon-д ${no} байх ЁСГҮЙ`);
  }
});

test("restaurant төрөлд ширээний tool нээлттэй", () => {
  const n = names(toolsForType("restaurant"));
  for (const need of ["check_tables", "save_reservation", "cancel_reservation", "save_order"]) {
    assert.ok(n.includes(need), `restaurant-д ${need} байх ЁСТОЙ`);
  }
});

test("тодорхойгүй/other төрөлд БҮХ tool өгнө (аюулгүй тал)", () => {
  assert.strictEqual(toolsForType("other").length, TOOLS.length);
  assert.strictEqual(toolsForType(undefined).length, TOOLS.length);
  assert.strictEqual(toolsForType("ийм_төрөл_байхгүй").length, TOOLS.length);
});

// ── Регресс хамгаалалт: тохиргоо ↔ тодорхойлолт зөрөхгүй ──
test("TOOLS_BY_TYPE дэх бүх нэр TOOLS дотор бодитоор байдаг (үсгийн алдаа барина)", () => {
  const all = new Set(names(TOOLS));
  for (const [type, list] of Object.entries(TOOLS_BY_TYPE)) {
    for (const n of list) assert.ok(all.has(n), `TOOLS_BY_TYPE.${type} дэх "${n}" нь TOOLS дотор АЛГА`);
  }
});

test("GROWTH_ONLY_TOOLS дэх бүх нэр TOOLS дотор бодитоор байдаг", () => {
  const all = new Set(names(TOOLS));
  for (const n of GROWTH_ONLY_TOOLS) assert.ok(all.has(n), `GROWTH_ONLY_TOOLS дэх "${n}" нь TOOLS дотор АЛГА`);
});

test("Starter багцад (Growth-only хасахад) хайлт/lead үлдэж, захиалга хаагдана", () => {
  const starter = names(toolsForType("shop").filter((t) => !GROWTH_ONLY_TOOLS.has(t.function.name)));
  assert.ok(starter.includes("search_knowledge"), "starter-д search_knowledge үлдэх ЁСТОЙ");
  assert.ok(starter.includes("save_lead"), "starter-д save_lead үлдэх ЁСТОЙ");
  assert.ok(!starter.includes("save_order"), "starter-д save_order хаагдах ЁСТОЙ");
  assert.ok(!starter.includes("confirm_payment"), "starter-д confirm_payment хаагдах ЁСТОЙ");
});

// ── save_order-ийн схем (захиалга буруу үүсэхээс сэргийлдэг гол шаардлагууд) ──
test("save_order нэр/утас/бараа/дүнг ЗААВАЛ шаардана", () => {
  const so = TOOLS.find((t) => t.function.name === "save_order");
  assert.ok(so, "save_order tool байх ёстой");
  const req = so.function.parameters.required;
  for (const f of ["customerName", "customerPhone", "items", "totalAmount"]) {
    assert.ok(req.includes(f), `save_order.required-д ${f} байх ЁСТОЙ`);
  }
  // item тус бүр нэр/тоо/үнэтэй байх ёстой — эс тэгвэл дүн буруу тооцогдоно
  const itemReq = so.function.parameters.properties.items.items.required;
  for (const f of ["name", "qty", "price"]) assert.ok(itemReq.includes(f), `items.required-д ${f} байх ЁСТОЙ`);
});
