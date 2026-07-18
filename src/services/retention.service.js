"use strict";
// ХАДГАЛАХ ХУГАЦААНЫ БОДЛОГО (retention).
//
// Нууцлалын бодлогод "хэдий хугацаанд хадгална" гэж бичсэн зүйлийг бодитоор
// хэрэгжүүлнэ. Хугацаа хэтэрсэн хувийн мэдээллийг цэвэрлэнэ.
//
// ⚠️ ӨГӨГДМӨЛ нь DRY-RUN: юу ч устгахгүй, зөвхөн "хэдэн мөр устах байсан"-ыг
// тоолж лог бичнэ. Жинхэнэ устгалыг асаахын тулд RETENTION_ENABLED=1 тохируулна.
// Ингэснээр тоог нүдээр хараад итгэлтэй болсны дараа идэвхжүүлнэ.
//
// Захиалгыг УСТГАХГҮЙ — нягтлан бодох бүртгэлийн шаардлагаар дүн/огноо үлдэх ёстой.
// Оронд нь хугацаа хэтэрсэн захиалгын ТАНИХ мэдээллийг (нэр/утас/хаяг) арилгана.
const { getPrisma } = require("../lib/db");
const { ANON } = require("./privacy.service");

const DAY = 24 * 60 * 60 * 1000;

// Хугацаанууд (сар). Өөрчлөх бол нууцлалын бодлогын хүснэгтийг МӨН шинэчилнэ.
const MONTHS = {
  chats: 12,          // Messenger чатын бичвэр
  unanswered: 6,      // хариулаагүй асуулт (зөвхөн AI сайжруулах зориулалттай)
  leads: 24,          // lead / consultation
  orderPii: 24,       // захиалгын таних мэдээлэл (дүн хэвээр үлдэнэ)
};

function cutoff(months) {
  return new Date(Date.now() - months * 30 * DAY);
}

const ENABLED = process.env.RETENTION_ENABLED === "1";

async function runRetention() {
  const prisma = getPrisma();
  const report = { mode: ENABLED ? "LIVE" : "DRY-RUN" };

  // Бүрэн устгах бүлгүүд
  const purges = [
    ["chats", "turuuChat", { updatedAt: { lt: cutoff(MONTHS.chats) } }],
    ["unanswered", "turuuUnanswered", { createdAt: { lt: cutoff(MONTHS.unanswered) } }],
    ["leads", "turuuLead", { createdAt: { lt: cutoff(MONTHS.leads) } }],
    ["consultations", "turuuConsultation", { createdAt: { lt: cutoff(MONTHS.leads) } }],
  ];

  for (const [key, model, where] of purges) {
    try {
      if (ENABLED) {
        const r = await prisma[model].deleteMany({ where });
        report[key] = r.count;
      } else {
        report[key] = await prisma[model].count({ where });
      }
    } catch (e) {
      report[key] = `алдаа: ${e.message}`;
    }
  }

  // Захиалгын PII нэргүйжүүлэх — аль хэдийн нэргүйжсэнийг дахин хөндөхгүй
  // (customerName != ANON гэсэн шүүлтүүр давхар ажиллахаас сэргийлнэ).
  const orderWhere = {
    createdAt: { lt: cutoff(MONTHS.orderPii) },
    NOT: { customerName: ANON },
  };
  const anonData = { customerName: ANON, customerPhone: null, customerEmail: null, deliveryAddress: null, psid: null, notes: null };

  for (const [key, model] of [["ordersAnonymized", "turuuOrder"], ["storeOrdersAnonymized", "storeOrder"]]) {
    try {
      if (ENABLED) {
        // StoreOrder-д psid талбар байхгүй тул тухайн загварт тохирсон өгөгдлийг ашиглана
        const data = model === "storeOrder" ? { ...anonData, psid: undefined } : anonData;
        const r = await prisma[model].updateMany({ where: orderWhere, data });
        report[key] = r.count;
      } else {
        report[key] = await prisma[model].count({ where: orderWhere });
      }
    } catch (e) {
      report[key] = `алдаа: ${e.message}`;
    }
  }

  const hasWork = Object.entries(report).some(([k, v]) => k !== "mode" && typeof v === "number" && v > 0);
  if (hasWork || !ENABLED) {
    console.log("[retention]", JSON.stringify(report));
    if (!ENABLED && hasWork) {
      console.log("[retention] DRY-RUN — юу ч устгаагүй. Идэвхжүүлэх: RETENTION_ENABLED=1");
    }
  }
  return report;
}

// Өдөрт нэг удаа ажиллана. Сервер босоод 5 минутын дараа эхний удаа.
function startRetention(intervalMs = 24 * 60 * 60 * 1000) {
  if (process.env.RETENTION_DISABLED === "1") {
    console.log("[retention] disabled by env");
    return null;
  }
  const tick = () => runRetention().catch((e) => console.error("[retention]", e.message));
  const t = setInterval(tick, intervalMs);
  if (t.unref) t.unref();
  setTimeout(tick, 5 * 60 * 1000);
  return t;
}

module.exports = { runRetention, startRetention, MONTHS };
