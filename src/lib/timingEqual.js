"use strict";
const crypto = require("crypto");

// Тогтмол хугацааны (timing-safe) тэнцүүлэлт — нууц утгыг timing-аар таахаас сэргийлнэ.
// Урт ялгаатай бол шууд false (timingSafeEqual урт ижил байхыг шаарддаг).
function timingEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { timingEqual };
