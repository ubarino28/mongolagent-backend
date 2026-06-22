"use strict";
const express = require("express");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { getPrisma } = require("../lib/db");
const { clientAuthMiddleware } = require("../middleware/clientAuth");
const { listTemplates, getTemplate } = require("../lib/storeTemplates");
const vercel = require("../services/vercel.service");

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Зургийн хэмжээ хэтэрсэн байна (дээд тал нь 5MB)" });
    return res.status(400).json({ error: "Файл хүлээн авахад алдаа гарлаа" });
  }
  next(err);
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// slug-г цэвэрлэх (subdomain-д тохиромжтой)
function normalizeSlug(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Давхцахгүй slug олох
async function uniqueStoreSlug(prisma, base, excludeStoreId) {
  let slug = normalizeSlug(base) || "store";
  let candidate = slug;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await prisma.store.findUnique({ where: { slug: candidate } });
    if (!existing || existing.id === excludeStoreId) return candidate;
    n += 1;
    candidate = `${slug}-${n}`;
  }
}

// Бүх route auth шаардана
router.use(clientAuthMiddleware);

// ─── Templates ────────────────────────────────────────────────────────────────

// GET /store/templates — боломжит template-ууд
router.get("/templates", (req, res) => {
  res.json({ templates: listTemplates() });
});

// ─── Store ──────────────────────────────────────────────────────────────────

// GET /store — миний дэлгүүр (байхгүй бол null)
router.get("/", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({
      where: { orgId: req.org.orgId },
      include: { _count: { select: { products: true, pages: true, orders: true } } },
    });
    res.json({ store: store || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store — дэлгүүр үүсгэх (template-ээс seed хийнэ). Аль хэдийн байвал буцаана.
router.post("/", async (req, res) => {
  try {
    const { name, templateId, slug } = req.body;
    const prisma = getPrisma();

    const existing = await prisma.store.findUnique({ where: { orgId: req.org.orgId } });
    if (existing) return res.status(409).json({ error: "Дэлгүүр аль хэдийн үүссэн байна", store: existing });

    const template = templateId ? getTemplate(templateId) : null;
    const org = await prisma.organization.findUnique({ where: { id: req.org.orgId }, select: { slug: true, name: true } });

    // Домэйн (subdomain)-г дэлгүүрийн нэрнээс үүсгэнэ (жишээ: "Inca" → inca.mongolagent.mn).
    // Хэрэглэгч тусгай slug дамжуулсан бол түүнийг, эс бөгөөс нэрийг, эцэст нь org slug-г ашиглана.
    const storeSlug = await uniqueStoreSlug(prisma, slug || name || org?.slug || req.org.slug, null);
    const theme = template?.theme || {};

    const store = await prisma.store.create({
      data: {
        orgId: req.org.orgId,
        name: name || org?.name || "Миний дэлгүүр",
        slug: storeSlug,
        templateId: templateId || null,
        theme,
        // Дэлгүүр үүсэмгүй шууд амьд (нийтлэх алхамгүй)
        status: "published",
        publishedAt: new Date(),
        pages: template
          ? {
              create: template.pages.map((p, i) => ({
                title: p.title,
                path: p.path,
                type: p.type,
                content: p.content,
                published: true,
                sortOrder: i,
              })),
            }
          : undefined,
        // Template-ийн demo бараа — дэлгүүр шууд дүүрэн харагдана
        products: template?.demoProducts
          ? {
              create: template.demoProducts.map((p, i) => ({
                orgId: req.org.orgId,
                name: p.name,
                description: p.description || null,
                price: p.price,
                compareAtPrice: p.compareAtPrice ?? null,
                images: p.images || [],
                category: p.category || null,
                stock: 50,
                active: true,
                sortOrder: i,
              })),
            }
          : undefined,
      },
      include: { pages: true },
    });

    // Домэйнийг ҮҮСГЭХ агшинд бүртгэж, SSL гарах хүртэл хүлээнэ (гацвал автоматаар
    // дахин trigger хийнэ) — ингэснээр линк үүсэмгүй шууд ажиллана.
    const domain = await vercel.ensureStoreDomain(store.slug);

    res.json({ store, domain });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /store — дэлгүүрийн тохиргоо шинэчлэх (нэр, theme, slug, домэйн)
router.put("/", async (req, res) => {
  try {
    const { name, theme, slug, customDomain, templateId, currency, phone, email, address, delivery } = req.body;
    const prisma = getPrisma();

    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    const data = {};
    if (name !== undefined) data.name = name;
    if (theme !== undefined) data.theme = theme;
    if (templateId !== undefined) data.templateId = templateId;
    if (currency !== undefined) data.currency = currency;
    if (phone !== undefined) data.phone = phone || null;
    if (email !== undefined) data.email = email || null;
    if (address !== undefined) data.address = address || null;
    if (delivery !== undefined) data.delivery = delivery || {};

    if (slug !== undefined) {
      const wanted = normalizeSlug(slug);
      if (!wanted) return res.status(400).json({ error: "slug буруу байна" });
      if (wanted !== store.slug) {
        const taken = await prisma.store.findUnique({ where: { slug: wanted } });
        if (taken) return res.status(409).json({ error: "Энэ slug аль хэдийн ашиглагдсан байна" });
        data.slug = wanted;
      }
    }

    if (customDomain !== undefined) {
      const dom = customDomain ? String(customDomain).toLowerCase().trim() : null;
      if (dom) {
        const taken = await prisma.store.findFirst({ where: { customDomain: dom, NOT: { id: store.id } } });
        if (taken) return res.status(409).json({ error: "Энэ домэйн өөр дэлгүүрт холбогдсон байна" });
      }
      data.customDomain = dom;
    }

    const updated = await prisma.store.update({ where: { id: store.id }, data });

    // slug өөрчлөгдсөн бөгөөд нийтлэгдсэн байвал Vercel домэйнийг шинэчилнэ
    if (data.slug && store.slug !== data.slug && store.status === "published") {
      await vercel.removeStoreDomain(store.slug);
      await vercel.addStoreDomain(data.slug);
    }

    res.json({ store: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/recheck-domain — домэйн/SSL ажиллахгүй байвал дахин шалгаж засах
router.post("/recheck-domain", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { slug: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    // Хэрэглэгч дарж байгаа учир шууд дахин trigger хийгээд хүлээнэ
    const r = await vercel.ensureStoreDomain(store.slug, { maxWaitMs: 25000, nudgeAfterMs: 0 });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /store — дэлгүүрийг бүхэлд нь устгах (хуудас, бараа, захиалга, купон cascade)
router.delete("/", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    // Vercel subdomain-г хасах (амжилтгүй ч устгалыг үргэлжлүүлнэ)
    await vercel.removeStoreDomain(store.slug).catch(() => {});

    // Cascade delete — холбоотой pages/products/orders/discounts бүгд устана
    await prisma.store.delete({ where: { id: store.id } });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/apply-template — сонгосон загварыг одоо байгаа дэлгүүрт хэрэглэх
router.post("/apply-template", async (req, res) => {
  try {
    const { templateId } = req.body;
    const template = getTemplate(templateId);
    if (!template) return res.status(400).json({ error: "Загвар олдсонгүй" });

    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    // theme + загвар шинэчилнэ
    await prisma.store.update({ where: { id: store.id }, data: { templateId, theme: template.theme } });

    // нүүр хуудсыг загварын агуулгаар тавина
    const home = template.pages.find((p) => p.path === "/") || template.pages[0];
    const existingHome = await prisma.storePage.findFirst({ where: { storeId: store.id, path: "/" } });
    if (existingHome) {
      await prisma.storePage.update({ where: { id: existingHome.id }, data: { content: home.content, title: home.title, published: true } });
    } else {
      await prisma.storePage.create({ data: { storeId: store.id, title: home.title, path: "/", type: home.type, content: home.content, published: true, sortOrder: 0 } });
    }

    // бараа байхгүй бол demo бараа seed хийнэ
    const productCount = await prisma.product.count({ where: { storeId: store.id } });
    let seeded = 0;
    if (productCount === 0 && template.demoProducts?.length) {
      await prisma.product.createMany({
        data: template.demoProducts.map((p, i) => ({
          storeId: store.id, orgId: req.org.orgId, name: p.name, description: p.description || null,
          price: p.price, compareAtPrice: p.compareAtPrice ?? null, images: p.images || [],
          category: p.category || null, stock: 50, active: true, sortOrder: i,
        })),
      });
      seeded = template.demoProducts.length;
    }

    const updated = await prisma.store.findUnique({
      where: { id: store.id },
      include: { _count: { select: { products: true, pages: true, orders: true } } },
    });
    res.json({ store: updated, seededProducts: seeded });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/publish — нийтлэх / нуух
router.post("/publish", async (req, res) => {
  try {
    const { publish = true } = req.body;
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    const updated = await prisma.store.update({
      where: { id: store.id },
      data: { status: publish ? "published" : "draft", publishedAt: publish ? new Date() : store.publishedAt },
    });

    // Нийтлэхэд {slug}.mongolagent.mn-г Vercel store project-д бүртгэнэ (SSL автоматаар)
    let domain = null;
    if (publish) domain = await vercel.addStoreDomain(updated.slug);

    res.json({ store: updated, domain });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Pages ────────────────────────────────────────────────────────────────────

// GET /store/pages — бүх хуудас
router.get("/pages", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const pages = await prisma.storePage.findMany({ where: { storeId: store.id }, orderBy: { sortOrder: "asc" } });
    res.json({ pages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/pages — шинэ хуудас
router.post("/pages", async (req, res) => {
  try {
    const { title, path, type, content } = req.body;
    if (!title || !path) return res.status(400).json({ error: "title, path шаардлагатай" });
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    const normPath = "/" + normalizeSlug(path).replace(/^\/+/, "");
    const dup = await prisma.storePage.findFirst({ where: { storeId: store.id, path: normPath } });
    if (dup) return res.status(409).json({ error: "Энэ замтай хуудас аль хэдийн байна" });

    const count = await prisma.storePage.count({ where: { storeId: store.id } });
    // Хоосон бол эхлэлийн агуулга өгнө (хэрэглэгч засагчаар дэлгэрэнгүй өөрчилнө)
    const starter = {
      root: { props: { title } },
      content: [{ type: "About", props: { id: "a1", heading: title, text: "Энд агуулгаа бичнэ үү. Хуудсыг засагчаар дэлгэрэнгүй өөрчилж болно." } }],
    };
    const pageContent = content && Object.keys(content).length ? content : starter;
    const page = await prisma.storePage.create({
      data: { storeId: store.id, title, path: normPath, type: type || "custom", content: pageContent, published: true, sortOrder: count },
    });
    res.json({ page });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /store/pages/:id — хуудас шинэчлэх (Puck content хадгалах)
router.put("/pages/:id", async (req, res) => {
  try {
    const { title, content, published, sortOrder } = req.body;
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    const page = await prisma.storePage.findFirst({ where: { id: req.params.id, storeId: store.id } });
    if (!page) return res.status(404).json({ error: "Хуудас олдсонгүй" });

    const data = {};
    if (title !== undefined) data.title = title;
    if (content !== undefined) data.content = content;
    if (published !== undefined) data.published = !!published;
    if (sortOrder !== undefined) data.sortOrder = Number(sortOrder);

    const updated = await prisma.storePage.update({ where: { id: page.id }, data });
    res.json({ page: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /store/pages/:id
router.delete("/pages/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const page = await prisma.storePage.findFirst({ where: { id: req.params.id, storeId: store.id } });
    if (!page) return res.status(404).json({ error: "Хуудас олдсонгүй" });
    if (page.path === "/") return res.status(400).json({ error: "Нүүр хуудсыг устгах боломжгүй" });
    await prisma.storePage.delete({ where: { id: page.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Products ─────────────────────────────────────────────────────────────────

// GET /store/products
router.get("/products", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const products = await prisma.product.findMany({ where: { storeId: store.id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] });
    res.json({ products });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/products
router.post("/products", async (req, res) => {
  try {
    const { name, description, price, compareAtPrice, images, stock, sku, category, active } = req.body;
    if (!name) return res.status(400).json({ error: "name шаардлагатай" });
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        orgId: req.org.orgId,
        name,
        description: description || null,
        price: Number(price) || 0,
        compareAtPrice: compareAtPrice != null ? Number(compareAtPrice) : null,
        images: Array.isArray(images) ? images : [],
        stock: Number(stock) || 0,
        sku: sku || null,
        category: category || null,
        active: active !== undefined ? !!active : true,
      },
    });
    res.json({ product });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /store/products/:id
router.put("/products/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const product = await prisma.product.findFirst({ where: { id: req.params.id, storeId: store.id } });
    if (!product) return res.status(404).json({ error: "Бараа олдсонгүй" });

    const b = req.body;
    const data = {};
    if (b.name !== undefined) data.name = b.name;
    if (b.description !== undefined) data.description = b.description;
    if (b.price !== undefined) data.price = Number(b.price) || 0;
    if (b.compareAtPrice !== undefined) data.compareAtPrice = b.compareAtPrice != null ? Number(b.compareAtPrice) : null;
    if (b.images !== undefined) data.images = Array.isArray(b.images) ? b.images : [];
    if (b.stock !== undefined) data.stock = Number(b.stock) || 0;
    if (b.sku !== undefined) data.sku = b.sku;
    if (b.category !== undefined) data.category = b.category;
    if (b.active !== undefined) data.active = !!b.active;
    if (b.sortOrder !== undefined) data.sortOrder = Number(b.sortOrder);

    const updated = await prisma.product.update({ where: { id: product.id }, data });
    res.json({ product: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /store/products/:id
router.delete("/products/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const product = await prisma.product.findFirst({ where: { id: req.params.id, storeId: store.id } });
    if (!product) return res.status(404).json({ error: "Бараа олдсонгүй" });
    await prisma.product.delete({ where: { id: product.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Orders (эзэн харах) ────────────────────────────────────────────────────────

// GET /store/orders
router.get("/orders", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const orders = await prisma.storeOrder.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "desc" } });
    res.json({ orders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /store/orders/:id — захиалгын статус шинэчлэх
router.patch("/orders/:id", async (req, res) => {
  try {
    const { status } = req.body;
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const order = await prisma.storeOrder.findFirst({ where: { id: req.params.id, storeId: store.id } });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });
    const updated = await prisma.storeOrder.update({ where: { id: order.id }, data: { status: status || order.status } });
    res.json({ order: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Customers (захиалгаас цуглуулсан худалдан авагчид) ──────────────────────

// GET /store/customers — захиалгуудаас хэрэглэгчдийг (утас/имэйлээр) нэгтгэж гаргана
router.get("/customers", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const orders = await prisma.storeOrder.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "desc" } });

    const map = new Map();
    for (const o of orders) {
      const key = (o.customerPhone || o.customerEmail || o.customerName || o.id).trim().toLowerCase();
      if (!key) continue;
      let c = map.get(key);
      if (!c) {
        c = { key, name: o.customerName || null, phone: o.customerPhone || null, email: o.customerEmail || null, address: o.deliveryAddress || null, orders: 0, totalSpent: 0, paidOrders: 0, lastOrderAt: o.createdAt, firstOrderAt: o.createdAt };
        map.set(key, c);
      }
      c.orders += 1;
      if (o.qpayStatus === "PAID" || o.status === "PAID" || o.status === "SHIPPED" || o.status === "DONE") { c.totalSpent += o.totalAmount || 0; c.paidOrders += 1; }
      if (!c.name && o.customerName) c.name = o.customerName;
      if (!c.email && o.customerEmail) c.email = o.customerEmail;
      if (!c.address && o.deliveryAddress) c.address = o.deliveryAddress;
      if (new Date(o.createdAt) > new Date(c.lastOrderAt)) c.lastOrderAt = o.createdAt;
      if (new Date(o.createdAt) < new Date(c.firstOrderAt)) c.firstOrderAt = o.createdAt;
    }
    const customers = [...map.values()].sort((a, b) => new Date(b.lastOrderAt) - new Date(a.lastOrderAt));
    res.json({ customers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Discounts (купон / хямдрал) ─────────────────────────────────────────────

function normalizeCode(s) {
  return String(s || "").toUpperCase().trim().replace(/\s+/g, "");
}

// GET /store/discounts
router.get("/discounts", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const discounts = await prisma.discount.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "desc" } });
    res.json({ discounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/discounts
router.post("/discounts", async (req, res) => {
  try {
    const { code, type, value, minAmount, maxUses, active, startsAt, endsAt } = req.body;
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const norm = normalizeCode(code);
    if (!norm) return res.status(400).json({ error: "Купон код шаардлагатай" });
    if (!["percent", "fixed"].includes(type)) return res.status(400).json({ error: "Төрөл буруу" });
    const exists = await prisma.discount.findFirst({ where: { storeId: store.id, code: norm } });
    if (exists) return res.status(409).json({ error: "Энэ код аль хэдийн байна" });
    const discount = await prisma.discount.create({
      data: {
        storeId: store.id, orgId: req.org.orgId, code: norm, type,
        value: Math.max(0, Number(value) || 0),
        minAmount: Math.max(0, Number(minAmount) || 0),
        maxUses: maxUses ? Math.max(1, Math.floor(Number(maxUses))) : null,
        active: active !== false,
        startsAt: startsAt ? new Date(startsAt) : null,
        endsAt: endsAt ? new Date(endsAt) : null,
      },
    });
    res.json({ discount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /store/discounts/:id
router.put("/discounts/:id", async (req, res) => {
  try {
    const { code, type, value, minAmount, maxUses, active, startsAt, endsAt } = req.body;
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const existing = await prisma.discount.findFirst({ where: { id: req.params.id, storeId: store.id } });
    if (!existing) return res.status(404).json({ error: "Купон олдсонгүй" });
    const data = {};
    if (code !== undefined) {
      const norm = normalizeCode(code);
      if (!norm) return res.status(400).json({ error: "Купон код шаардлагатай" });
      const dup = await prisma.discount.findFirst({ where: { storeId: store.id, code: norm, NOT: { id: existing.id } } });
      if (dup) return res.status(409).json({ error: "Энэ код аль хэдийн байна" });
      data.code = norm;
    }
    if (type !== undefined) data.type = type;
    if (value !== undefined) data.value = Math.max(0, Number(value) || 0);
    if (minAmount !== undefined) data.minAmount = Math.max(0, Number(minAmount) || 0);
    if (maxUses !== undefined) data.maxUses = maxUses ? Math.max(1, Math.floor(Number(maxUses))) : null;
    if (active !== undefined) data.active = !!active;
    if (startsAt !== undefined) data.startsAt = startsAt ? new Date(startsAt) : null;
    if (endsAt !== undefined) data.endsAt = endsAt ? new Date(endsAt) : null;
    const discount = await prisma.discount.update({ where: { id: existing.id }, data });
    res.json({ discount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /store/discounts/:id
router.delete("/discounts/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const existing = await prisma.discount.findFirst({ where: { id: req.params.id, storeId: store.id } });
    if (!existing) return res.status(404).json({ error: "Купон олдсонгүй" });
    await prisma.discount.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Зураг upload ───────────────────────────────────────────────────────────

// POST /store/upload — бараа/баннер зураг
router.post("/upload", upload.single("file"), handleUploadError, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file шаардлагатай" });
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: "Зөвхөн зураг (jpg, png, webp, gif) оруулна уу" });

    const ext = req.file.originalname.split(".").pop().toLowerCase();
    const filename = `store/${req.org.orgId}/${Date.now()}.${ext}`;
    const supabase = getSupabase();

    const { error } = await supabase.storage.from("turuuai-assets").upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) {
      console.error("[store/upload] Supabase storage error:", error.message);
      return res.status(500).json({ error: "Зураг байршуулахад алдаа гарлаа. Дахин оролдоно уу." });
    }
    const { data } = supabase.storage.from("turuuai-assets").getPublicUrl(filename);
    res.json({ url: data.publicUrl });
  } catch (e) {
    console.error("[store/upload] Error:", e.message);
    res.status(500).json({ error: "Зураг байршуулахад алдаа гарлаа. Дахин оролдоно уу." });
  }
});

module.exports = router;
