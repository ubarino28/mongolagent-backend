"use strict";
// Энгийн санах-ойн TTL кэш (хамаарал нэмэхгүй). Олон instance-д хуваалцагддаггүй тул
// зөвхөн богино TTL-тэй, идемпотент уншилтад ашиглана (system prompt, storefront дата).

const store = new Map(); // key -> { value, exp }

function get(key) {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) { store.delete(key); return undefined; }
  return e.value;
}

function set(key, value, ttlMs) {
  store.set(key, { value, exp: Date.now() + ttlMs });
}

function del(prefix) {
  // prefix-ээр эхэлсэн бүх түлхүүрийг устгана (invalidation)
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

// getOrSet — кэшэд байвал буцаана, эс бол fn() дуудаж кэшилнэ
async function getOrSet(key, ttlMs, fn) {
  const cached = get(key);
  if (cached !== undefined) return cached;
  const value = await fn();
  set(key, value, ttlMs);
  return value;
}

// Санах ой хуримтлахаас сэргийлж 10 минут тутамд хугацаа дууссаныг цэвэрлэнэ
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of store) if (now > e.exp) store.delete(k);
}, 10 * 60_000).unref?.();

// Тухайн org-ийн analytics/report/funnel кэшийг бүгдийг цэвэрлэнэ (шинэ борлуулалт шууд харагдуулах)
function invalidateOrg(orgId) {
  if (!orgId) return;
  del(`report:${orgId}`);
  del(`analytics:${orgId}`);
  del(`funnel:${orgId}`);
}

module.exports = { get, set, del, getOrSet, invalidateOrg };
