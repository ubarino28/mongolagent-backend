"use strict";

/**
 * Захиалга төлөгдсөний дараа барааны нөөцийг хасах.
 * Нэг захиалгын items[] (productId, qty) дээр ажиллана.
 * Нөөцийг 0-оос доош болгохгүй. Алдаа гарвал бусдыг үргэлжлүүлнэ (non-blocking).
 */
async function decrementStockForOrder(prisma, order) {
  const items = Array.isArray(order.items) ? order.items : [];
  for (const it of items) {
    const id = it.productId;
    const qty = Math.max(0, Math.floor(Number(it.qty) || 0));
    if (!id || qty <= 0) continue;
    try {
      // Хангалттай нөөцтэй бол хас
      const r = await prisma.product.updateMany({
        where: { id, stock: { gte: qty } },
        data: { stock: { decrement: qty } },
      });
      // Нөөц хүрэлцэхгүй байсан бол 0 болгоно (хасуу болгохгүй) — зэрэг 2 захиалга сүүлийн
      // ширхгийг хоёулаа зарсан тохиолдол. Худалдагчид анхааруулга + мэдэгдэл (эс тэгвэл
      // байхгүй бараа зарсныг мэдэхгүй үлддэг).
      if (r.count === 0) {
        console.warn(`[stock] OVERSELL — product ${id} нөөц хүрэлцсэнгүй (qty=${qty}), 0 болгов. Захиалга ${order.id}`);
        await prisma.product.updateMany({ where: { id, stock: { gt: 0 } }, data: { stock: 0 } });
        try {
          const { notifyOwner } = require("./notify.service");
          const prod = await prisma.product.findUnique({ where: { id }, select: { name: true } }).catch(() => null);
          notifyOwner(order.orgId, "⚠️ Нөөц хэтэрсэн захиалга", {
            Бараа: prod?.name || id,
            Захиалсан: qty,
            Захиалга: `#${String(order.id).slice(-6).toUpperCase()}`,
            Анхаар: "Нөөц хүрэлцэхгүй байхад төлбөр хийгдсэн — хэрэглэгчтэй холбогдоно уу",
          }, { label: "Захиалга харах", path: "/website/orders" }).catch(() => {});
        } catch { /* мэдэгдэл — үндсэн урсгалд нөлөөлөхгүй */ }
      }
    } catch (e) {
      console.error("[stock] decrement error:", id, e.message);
    }
  }
}

module.exports = { decrementStockForOrder };