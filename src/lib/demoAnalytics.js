"use strict";
// ТҮР ЗУУР demo — DEMO_ANALYTICS=1 (зөвхөн local .env) үед analytics-ыг хиймэл, бодит шинжтэй
// өгөгдлөөр дүүргэнэ. Хэрэглэгчид dashboard яаж харагдахыг жинхэнэ app дээр үзүүлэхэд зориулав.
// Production-д ашиглахгүй (flag байхгүй). Устгахад амархан — энэ файл + 2 if мөрийг л устгана.

// from/to (ISO огноо) байвал тэр хугацааны хиймэл өгөгдөл — өдрийн тоогоор масштаблана.
function demoAnalytics(from, to) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 29 * 86400000);
  const n = Math.max(1, Math.min(370, Math.round((end - start) / 86400000) + 1));
  const D = Array.from({ length: n }, (_, i) => new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));

  const series = (perDay, amp, seed) => D.map((date, i) => ({ date, count: Math.max(0, Math.round(perDay + Math.sin(i * 0.7 + seed) * amp + ((i % 3) - 1) * amp * 0.3)) }));
  const sum = (a) => a.reduce((s, x) => s + x.count, 0);
  const dailyMessages = series(41, 8, 1);
  const dailyLeads = series(11, 3, 3);
  const dailyConsultations = series(3, 1.2, 7);
  const dailyOrders = series(5, 2, 5);
  const totalConversations = sum(dailyMessages);
  const totalLeads = sum(dailyLeads);
  const totalConsultations = sum(dailyConsultations);
  const totalOrders = sum(dailyOrders);

  const revDaily = D.map((date, i) => ({ date, amount: Math.max(0, Math.round(225000 + Math.sin(i * 0.6) * 55000 + ((i % 4) - 1) * 28000)) }));
  const totalRev = revDaily.reduce((s, x) => s + x.amount, 0);

  // Барааны нэгжийн зарагдалт — нийт захиалгад пропорциональ
  const prodBase = [
    ["Nike Air Force 1 цагаан", 0.27, 149000], ["Adidas Superstar", 0.20, 129000],
    ["Jordan 1 Low", 0.12, 190000], ["New Balance 550", 0.10, 159000],
    ["Converse Chuck 70", 0.08, 99000], ["Nike Dunk Low", 0.07, 169000],
    ["Puma Suede", 0.06, 79000], ["Vans Old Skool", 0.05, 89000],
  ];
  const topProducts = prodBase
    .map(([name, share, price]) => { const units = Math.max(0, Math.round(totalOrders * share)); return { name, units, revenue: units * price }; })
    .filter((p) => p.units > 0);

  return {
    totalConversations, totalLeads, totalConsultations, totalOrders,
    newLeads: Math.round(totalLeads * 0.08),
    dailyMessages, dailyLeads, dailyConsultations, dailyOrders,
    deltas: { conversations: 18, leads: 12, consultations: -5, orders: 24 },
    topProducts,
    revenue: {
      orders: Math.round(totalRev * 0.68), ordersCount: totalOrders,
      appointments: Math.round(totalRev * 0.20), appointmentsCount: totalConsultations,
      store: Math.round(totalRev * 0.12), storeCount: Math.round(totalOrders * 0.20),
      total: totalRev, daily: revDaily, period: "custom",
    },
  };
}

function demoFunnel() {
  return { conversations: 1248, leads: 342, consultations: 89, orders: 156, unanswered: 7, convRate: 27, closeRate: 46 };
}

// Сар бүрийн хиймэл тайлан (банкны хар дэвтэрт) — N сар
function mnMonthLabel(key) { const [y, m] = key.split("-"); return `${y} ${parseInt(m, 10)}-р сар`; }
function demoReport(N) {
  const months = [];
  for (let i = N - 1; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    // бага зэрэг өсөх хандлагатай, улирлын хэлбэлзэлтэй
    const seasonal = 0.82 + Math.sin(i * 0.9) * 0.14;
    const trend = 1 - i * 0.015;
    const revenue = Math.round(6900000 * seasonal * trend);
    const orders = Math.round(156 * seasonal * trend);
    const leads = Math.round(342 * seasonal * trend);
    const conversations = Math.round(1248 * seasonal * trend);
    months.push({ month: key, label: mnMonthLabel(key), revenue, orders, leads, conversations });
  }
  const totals = months.reduce((t, m) => ({
    revenue: t.revenue + m.revenue, orders: t.orders + m.orders,
    leads: t.leads + m.leads, conversations: t.conversations + m.conversations,
  }), { revenue: 0, orders: 0, leads: 0, conversations: 0 });
  // Эх сурвалжийн задаргаа (нийт хугацаанд, ойролцоо харьцаагаар)
  const revenueBySource = {
    orders: Math.round(totals.revenue * 0.68), ordersCount: totals.orders,
    appointments: Math.round(totals.revenue * 0.2), appointmentsCount: Math.round(totals.orders * 0.55),
    store: Math.round(totals.revenue * 0.12), storeCount: Math.round(totals.orders * 0.2),
  };
  return { months: N, monthly: months, totals, revenueBySource };
}

module.exports = { demoAnalytics, demoFunnel, demoReport, DEMO_ON: () => process.env.DEMO_ANALYTICS === "1" };
