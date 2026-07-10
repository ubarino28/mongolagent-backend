"use strict";
// Багцын үнэ — хугацаа бүрийн ЭФФЕКТИВ САРЫН үнэ. Нийт төлбөр = perMonth × months.
// 6 сар ≈ 10% хямд, 1 жил ≈ 20% хямд (урт хугацааны амлалтад урамшуулал).
const PLAN_PERIOD_PRICE = {
  starter:    { monthly: 59900,  halfyear: 53900,  yearly: 47900 },
  growth:     { monthly: 99900,  halfyear: 89900,  yearly: 79900 },
  business:   { monthly: 179900, halfyear: 161900, yearly: 143900 },
  enterprise: { monthly: 349900, halfyear: 314900, yearly: 279900 },
};
const PERIOD_MONTHS = { monthly: 1, halfyear: 6, yearly: 12 };
const PERIOD_LABEL  = { monthly: "Сар", halfyear: "6 сар", yearly: "Жил" };

// Нийт төлбөр (тухайн хугацаанд) — perMonth × months
function periodTotal(plan, period) {
  const perMonth = PLAN_PERIOD_PRICE[plan] && PLAN_PERIOD_PRICE[plan][period];
  const months = PERIOD_MONTHS[period];
  if (!perMonth || !months) return null;
  return perMonth * months;
}

// Нэмэлт message багц (top-up) — quota дуусахад авна. Persistent: ашиглагдаж дуустал үлдэнэ.
// Үнэ: БАТАЛГААТ 40%+ margin — хамгийн муу зардал (no-cache ≈ ₮10.3/msg) дээр 40% → ₮17.2/msg.
// Cache warm үед бодит margin ~63%. Base багц ₮26/msg-аас ~32% хямд.
const MESSAGE_TOPUP = {
  500:  8900,
  1000: 17900,
  2500: 43900,
  5000: 86900,
};

// Багцын мэдээлэл (size тоо → { units, price }). size буруу бол null.
function topupPack(size) {
  const units = parseInt(size, 10);
  const price = MESSAGE_TOPUP[units];
  if (!price) return null;
  return { units, price };
}

module.exports = { PLAN_PERIOD_PRICE, PERIOD_MONTHS, PERIOD_LABEL, periodTotal, MESSAGE_TOPUP, topupPack };
