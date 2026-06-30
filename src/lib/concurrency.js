"use strict";
// Хязгаарлагдмал зэрэгцээ боловсруулалт — олон item-ийг нэг дор биш, тодорхой
// тооны (limit) зэрэгцээ ажиллуулна. Гадны API-г (QPay) хэт ачаалахаас сэргийлнэ.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = { __error: e }; }
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

module.exports = { mapLimit };
