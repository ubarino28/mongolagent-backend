"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { isExpoToken, registerToken, sendPushToOrg } = require("../src/services/push.service");

test("isExpoToken: зөв Expo token-уудыг танина", () => {
  assert.strictEqual(isExpoToken("ExponentPushToken[abc123]"), true);
  assert.strictEqual(isExpoToken("ExpoPushToken[xyz]"), true);
});

test("isExpoToken: буруу утгыг татгалзана", () => {
  assert.strictEqual(isExpoToken(""), false);
  assert.strictEqual(isExpoToken("random-string"), false);
  assert.strictEqual(isExpoToken(null), false);
  assert.strictEqual(isExpoToken(undefined), false);
  assert.strictEqual(isExpoToken("fcm:token"), false);
});

test("registerToken: буруу token → false (DB хүрэхгүй)", async () => {
  assert.strictEqual(await registerToken("org1", "not-a-token"), false);
  assert.strictEqual(await registerToken("org1", ""), false);
  assert.strictEqual(await registerToken(null, "ExponentPushToken[x]"), false);
});

test("sendPushToOrg: orgId байхгүй → false (алдаа шидэхгүй)", async () => {
  assert.strictEqual(await sendPushToOrg(null, { title: "x" }), false);
});
