"use strict";
// Хамаарал нэмэхгүй, санах ойн энгийн rate limiter (нэг instance-д хангалттай).
// Brute-force (login/checkout)-аас хамгаална.

const buckets = new Map();

// Санах ой хэт өсөхөөс сэргийлж 10 минут тутамд хуучин бичлэгийг цэвэрлэнэ
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of buckets) if (now > e.reset) buckets.delete(k);
}, 10 * 60 * 1000).unref?.();

function rateLimit({ windowMs = 60_000, max = 30, key } = {}) {
  const keyFn = key || ((req) => `${req.ip}:${req.baseUrl}${req.path}`);
  return (req, res, next) => {
    const k = keyFn(req);
    const now = Date.now();
    let e = buckets.get(k);
    if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; buckets.set(k, e); }
    e.count++;
    if (e.count > max) {
      res.set("Retry-After", String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: "Хэт олон оролдлого. Түр хүлээгээд дахин оролдоно уу." });
    }
    next();
  };
}

module.exports = { rateLimit };
