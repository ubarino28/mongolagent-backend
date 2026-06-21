"use strict";
const express = require("express");
const { getPrisma } = require("../lib/db");
const qpay = require("../services/qpay.service");

const router = express.Router();

const ROOT_DOMAIN = process.env.STORE_ROOT_DOMAIN || "mongolagent.mn";

// host-оос дэлгүүр олох: slug.mongolagent.mn → slug, эсвэл custom домэйн
async function resolveStore(prisma, { host, slug }) {
  if (slug) {
    return prisma.store.findUnique({ where: { slug: String(slug).toLowerCase() } });
  }
  if (!host) return null;
  let h = String(host).toLowerCase().split(":")[0].trim();
  h = h.replace(/^www\./, "");

  if (h.endsWith(`.${ROOT_DOMAIN}`)) {
    const sub = h.slice(0, -1 * (`.${ROOT_DOMAIN}`).length);
    if (!sub || sub === "www") return null;
    return prisma.store.findUnique({ where: { slug: sub } });
  }
  // custom домэйн
  return prisma.store.findFirst({ where: { customDomain: h } });
}

// Бараа жагсаалтыг нийтэд харуулах хэлбэрт хувиргах
function publicProduct(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    images: p.images,
    stock: p.stock,
    category: p.category,
    sku: p.sku,
  };
}

// ─── Site resolve ───────────────────────────────────────────────────────────

// GET /storefront/site?host=slug.mongolagent.mn  (эсвэл ?slug=)
// Нийтлэгдсэн дэлгүүр + хуудас + бараа буцаана
router.get("/site", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await resolveStore(prisma, { host: req.query.host, slug: req.query.slug });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    if (store.status !== "published") return res.status(404).json({ error: "Дэлгүүр нийтлэгдээгүй байна" });

    const [pages, products] = await Promise.all([
      prisma.storePage.findMany({ where: { storeId: store.id, published: true }, orderBy: { sortOrder: "asc" } }),
      prisma.product.findMany({ where: { storeId: store.id, active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] }),
    ]);

    res.json({
      store: {
        id: store.id,
        name: store.name,
        slug: store.slug,
        theme: store.theme,
        currency: store.currency,
        templateId: store.templateId,
      },
      pages,
      products: products.map(publicProduct),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /storefront/:slug/products
router.get("/:slug/products", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { slug: String(req.params.slug).toLowerCase() }, select: { id: true, status: true } });
    if (!store || store.status !== "published") return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const products = await prisma.product.findMany({ where: { storeId: store.id, active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] });
    res.json({ products: products.map(publicProduct) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /storefront/:slug/product/:id
router.get("/:slug/product/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { slug: String(req.params.slug).toLowerCase() }, select: { id: true, status: true } });
    if (!store || store.status !== "published") return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const product = await prisma.product.findFirst({ where: { id: req.params.id, storeId: store.id, active: true } });
    if (!product) return res.status(404).json({ error: "Бараа олдсонгүй" });
    res.json({ product: publicProduct(product) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Checkout ─────────────────────────────────────────────────────────────────

// POST /storefront/:slug/checkout
// body: { items: [{ productId, qty }], customer: { name, phone, email, address }, note }
router.post("/:slug/checkout", async (req, res) => {
  try {
    const { items, customer = {}, note } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Сагс хоосон байна" });

    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { slug: String(req.params.slug).toLowerCase() } });
    if (!store || store.status !== "published") return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    // Бараануудыг DB-ээс татаж үнийг СЕРВЕР талд тооцоолно (client-ийн дүнд итгэхгүй)
    const ids = [...new Set(items.map((i) => i.productId))];
    const products = await prisma.product.findMany({ where: { id: { in: ids }, storeId: store.id, active: true } });
    const byId = new Map(products.map((p) => [p.id, p]));

    const lineItems = [];
    let total = 0;
    for (const it of items) {
      const p = byId.get(it.productId);
      if (!p) return res.status(400).json({ error: `Бараа олдсонгүй: ${it.productId}` });
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      if (p.stock > 0 && qty > p.stock) return res.status(400).json({ error: `"${p.name}" — нөөц хүрэлцэхгүй (үлдсэн: ${p.stock})` });
      const lineTotal = p.price * qty;
      total += lineTotal;
      lineItems.push({ productId: p.id, name: p.name, price: p.price, qty, lineTotal, image: Array.isArray(p.images) ? p.images[0] || null : null });
    }

    const order = await prisma.storeOrder.create({
      data: {
        storeId: store.id,
        orgId: store.orgId,
        customerName: customer.name || null,
        customerPhone: customer.phone || null,
        customerEmail: customer.email || null,
        deliveryAddress: customer.address || null,
        items: lineItems,
        totalAmount: total,
        notes: note || null,
        status: "NEW",
        qpayStatus: "PENDING",
      },
    });

    // QPay invoice — org-ийн merchant/банкны мэдээлэл байвал
    const org = await prisma.organization.findUnique({ where: { id: store.orgId } });
    if (!org?.qpayMerchantId || !org?.qpayAccountNumber) {
      // QPay тохируулаагүй — захиалга үүснэ, гэхдээ онлайн төлбөргүй
      return res.json({ order: { id: order.id, totalAmount: total, items: lineItems }, payment: null, message: "Захиалга хүлээн авлаа. Худалдагч тантай холбогдоно." });
    }

    const result = await qpay.createInvoice({
      merchantId: org.qpayMerchantId,
      branchCode: org.qpayBranchCode || "BRANCH_001",
      amount: total,
      description: `${store.name} — захиалга #${order.id.slice(-6).toUpperCase()}`,
      customerName: customer.name || "Хэрэглэгч",
      bankAccounts: [{
        default: true,
        account_bank_code: org.qpayBankCode,
        account_number: org.qpayAccountNumber,
        account_name: org.qpayAccountName,
        is_default: true,
      }],
      callbackUrl: `${process.env.API_URL || "https://api.mongolagent.mn"}/webhook/qpay-store/${order.id}`,
    });

    await prisma.storeOrder.update({
      where: { id: order.id },
      data: { qpayInvoiceId: result.invoice_id, qpayQrText: result.qr_text, qpayUrls: result.urls || [], qpayStatus: "PENDING" },
    });

    res.json({
      order: { id: order.id, totalAmount: total, items: lineItems },
      payment: { invoiceId: result.invoice_id, qrText: result.qr_text, qrImage: result.qr_image, urls: result.urls || [] },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /storefront/order/:id/status — төлбөрийн төлөв шалгах (polling)
router.get("/order/:id/status", async (req, res) => {
  try {
    const prisma = getPrisma();
    const order = await prisma.storeOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });

    // Аль хэдийн төлсөн бол шууд буцаана
    if (order.qpayStatus === "PAID") return res.json({ status: "PAID", orderStatus: order.status });
    if (!order.qpayInvoiceId) return res.json({ status: order.qpayStatus || "PENDING", orderStatus: order.status });

    const result = await qpay.checkPayment(order.qpayInvoiceId);
    const paid = result.invoice_status === "PAID";
    if (paid) {
      await prisma.storeOrder.update({ where: { id: order.id }, data: { qpayStatus: "PAID", status: "PAID" } });
      return res.json({ status: "PAID", orderStatus: "PAID" });
    }
    res.json({ status: "PENDING", orderStatus: order.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
