"use strict";
const express = require("express");
const { getPrisma } = require("../lib/db");
const qpay = require("../services/qpay.service");
const { decrementStockForOrder } = require("../services/stock.service");
const { markStoreOrderPaid } = require("../services/payment.service");
const { rateLimit } = require("../middleware/rateLimit");
const checkoutLimiter = rateLimit({ windowMs: 60_000, max: 12 }); // checkout/discount spam-аас
const reviewLimiter = rateLimit({ windowMs: 60_000, max: 6 }); // сэтгэгдэл спам-аас

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
    variants: Array.isArray(p.variants) ? p.variants : [],
    stock: p.stock,
    category: p.category,
    sku: p.sku,
  };
}

// Купон шалгаж, хямдруулах дүнг тооцоолох
// → { ok, discount, amount, error }
async function evalDiscount(prisma, storeId, code, subtotal) {
  const norm = String(code || "").toUpperCase().trim().replace(/\s+/g, "");
  if (!norm) return { ok: false, error: "Код оруулна уу", amount: 0 };
  const d = await prisma.discount.findFirst({ where: { storeId, code: norm } });
  if (!d || !d.active) return { ok: false, error: "Купон олдсонгүй", amount: 0 };
  const now = new Date();
  if (d.startsAt && now < new Date(d.startsAt)) return { ok: false, error: "Купон идэвхжээгүй байна", amount: 0 };
  if (d.endsAt && now > new Date(d.endsAt)) return { ok: false, error: "Купоны хугацаа дууссан", amount: 0 };
  if (d.maxUses != null && d.usedCount >= d.maxUses) return { ok: false, error: "Купоны хязгаар дууссан", amount: 0 };
  if (subtotal < (d.minAmount || 0)) return { ok: false, error: `Доод дүн ${Number(d.minAmount).toLocaleString()}₮`, amount: 0 };
  let amount = d.type === "percent" ? Math.round(subtotal * (d.value / 100)) : Math.round(d.value);
  amount = Math.min(amount, subtotal); // нийт дүнгээс хэтрэхгүй
  return { ok: true, discount: d, amount };
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
        layout: store.layout || {},
        currency: store.currency,
        templateId: store.templateId,
        phone: store.phone,
        email: store.email,
        address: store.address,
        delivery: store.delivery || {},
      },
      pages,
      products: products.map(publicProduct),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /storefront/:slug/categories
router.get("/:slug/categories", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { slug: String(req.params.slug).toLowerCase() }, select: { id: true, status: true } });
    if (!store || store.status !== "published") return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const categories = await prisma.storeCategory.findMany({ where: { storeId: store.id }, orderBy: { sortOrder: "asc" } });
    res.json({ categories });
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

// POST /storefront/:slug/validate-discount — сагсан дээр купон шалгах
// body: { code, subtotal }
router.post("/:slug/validate-discount", checkoutLimiter, async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { slug: String(req.params.slug).toLowerCase() }, select: { id: true, status: true } });
    if (!store || store.status !== "published") return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const r = await evalDiscount(prisma, store.id, req.body.code, Math.max(0, Number(req.body.subtotal) || 0));
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true, code: r.discount.code, type: r.discount.type, value: r.discount.value, amount: r.amount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /storefront/:slug/checkout
// body: { items: [{ productId, qty }], customer: { name, phone, email, address }, note, discountCode }
router.post("/:slug/checkout", checkoutLimiter, async (req, res) => {
  try {
    const { items, customer = {}, note, discountCode, deliveryMethod } = req.body;
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
      lineItems.push({ productId: p.id, name: p.name, price: p.price, qty, lineTotal, image: Array.isArray(p.images) ? p.images[0] || null : null, variant: it.variant ? String(it.variant).slice(0, 120) : null });
    }

    // Купон хямдрал (байвал) — сервер талд дахин шалгаж тооцоолно
    const subtotal = total;
    let discountAmount = 0;
    let appliedDiscount = null;
    if (discountCode) {
      const r = await evalDiscount(prisma, store.id, discountCode, subtotal);
      if (!r.ok) return res.status(400).json({ error: r.error });
      discountAmount = r.amount;
      appliedDiscount = r.discount;
      total = Math.max(0, subtotal - discountAmount);
    }

    // Хүргэлтийн төлбөр — store.delivery тохиргооноос сервер талд тооцоолно
    const dconf = store.delivery || {};
    const enabled = { inUB: !!dconf.inUB, countryside: !!dconf.countryside, pickup: !!dconf.pickup };
    let dmethod = deliveryMethod && enabled[deliveryMethod] ? deliveryMethod : null;
    let deliveryFee = 0;
    if (dmethod && dmethod !== "pickup") {
      const free = Number(dconf.freeOver) > 0 && subtotal >= Number(dconf.freeOver);
      deliveryFee = free ? 0 : Math.max(0, Number(dconf.fee) || 0);
    }
    total = Math.max(0, total + deliveryFee);

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
        discountCode: appliedDiscount ? appliedDiscount.code : null,
        discountAmount,
        deliveryMethod: dmethod,
        deliveryFee,
        notes: note || null,
        status: "NEW",
        qpayStatus: "PENDING",
      },
    });

    // Купоны ашиглалт нь ТӨЛБӨР ТӨЛӨГДСӨНИЙ ДАРАА л тоологдоно (markStoreOrderPaid дотор).
    // → төлөөгүй/орхигдсон захиалга купоны лимитийг иддэггүй.

    // QPay invoice — org-ийн merchant/банкны мэдээлэл байвал
    const org = await prisma.organization.findUnique({ where: { id: store.orgId } });
    if (!org?.qpayMerchantId || !org?.qpayAccountNumber) {
      // QPay тохируулаагүй — захиалга үүснэ, гэхдээ онлайн төлбөргүй
      return res.json({ order: { id: order.id, totalAmount: total, subtotal, discountAmount, discountCode: order.discountCode, deliveryFee, deliveryMethod: dmethod, items: lineItems }, payment: null, message: "Захиалга хүлээн авлаа. Худалдагч тантай холбогдоно." });
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
      order: { id: order.id, totalAmount: total, subtotal, discountAmount, discountCode: order.discountCode, deliveryFee, deliveryMethod: dmethod, items: lineItems },
      payment: { invoiceId: result.invoice_id, qrText: result.qr_text, qrImage: result.qr_image, urls: result.urls || [] },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /storefront/order/:id — захиалгын төлөв + товч мэдээлэл (хянах хуудсанд)
router.get("/order/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const o = await prisma.storeOrder.findUnique({ where: { id: req.params.id } });
    if (!o) return res.status(404).json({ error: "Захиалга олдсонгүй" });
    res.json({
      order: {
        id: o.id,
        status: o.status,
        qpayStatus: o.qpayStatus,
        totalAmount: o.totalAmount,
        discountAmount: o.discountAmount,
        deliveryFee: o.deliveryFee,
        deliveryMethod: o.deliveryMethod,
        trackingNo: o.trackingNo,
        refundedAmount: o.refundedAmount,
        items: o.items,
        customerName: o.customerName,
        createdAt: o.createdAt,
      },
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
      await markStoreOrderPaid(prisma, order); // идемпотент — давхар хасахгүй
      return res.json({ status: "PAID", orderStatus: "PAID" });
    }
    res.json({ status: "PENDING", orderStatus: order.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /storefront/:slug/product/:productId/reviews — батлагдсан сэтгэгдэл + дундаж үнэлгээ
router.get("/:slug/product/:productId/reviews", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { slug: String(req.params.slug).toLowerCase() }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const reviews = await prisma.review.findMany({
      where: { storeId: store.id, productId: req.params.productId, approved: true },
      orderBy: { createdAt: "desc" },
      select: { id: true, customerName: true, rating: true, comment: true, createdAt: true },
      take: 100,
    });
    const count = reviews.length;
    const avg = count ? reviews.reduce((s, r) => s + r.rating, 0) / count : 0;
    res.json({ reviews, count, avg: Math.round(avg * 10) / 10 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /storefront/:slug/reviews — сэтгэгдэл үлдээх (нийтийн)
router.post("/:slug/reviews", reviewLimiter, async (req, res) => {
  try {
    const { productId, name, rating, comment } = req.body || {};
    if (!productId) return res.status(400).json({ error: "Бараа заагаагүй байна" });
    const r = Math.max(1, Math.min(5, Math.floor(Number(rating) || 0)));
    if (!r) return res.status(400).json({ error: "Үнэлгээ (1-5) өгнө үү" });
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { slug: String(req.params.slug).toLowerCase() }, select: { id: true, orgId: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    // Бараа тухайн дэлгүүрийнх мөн эсэхийг шалгана
    const product = await prisma.product.findFirst({ where: { id: String(productId), storeId: store.id }, select: { id: true } });
    if (!product) return res.status(400).json({ error: "Бараа олдсонгүй" });
    const review = await prisma.review.create({
      data: {
        storeId: store.id, orgId: store.orgId, productId: product.id,
        customerName: name ? String(name).slice(0, 80) : null,
        rating: r,
        comment: comment ? String(comment).slice(0, 1000) : null,
        approved: true,
      },
      select: { id: true, customerName: true, rating: true, comment: true, createdAt: true },
    });
    res.json({ review });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
