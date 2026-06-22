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
      // Нөөц хүрэлцэхгүй байсан бол 0 болгоно (хасуу болгохгүй)
      if (r.count === 0) {
        await prisma.product.updateMany({ where: { id, stock: { gt: 0 } }, data: { stock: 0 } });
      }
    } catch (e) {
      console.error("[stock] decrement error:", id, e.message);
    }
  }
}

module.exports = { decrementStockForOrder };