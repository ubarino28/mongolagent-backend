"use strict";
const express = require("express");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { getPrisma } = require("../lib/db");
const { clientAuthMiddleware } = require("../middleware/clientAuth");
const { listTemplates, getTemplate } = require("../lib/storeTemplates");
const vercel = require("../services/vercel.service");
const vdomains = require("../services/vercelDomains.service");
const platformQpay = require("../services/subscription-qpay.service");
const { fulfillDomainOrder } = require("../services/domain.service");

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
        status: "published",
        publishedAt: new Date(),
        webPlan: "trial",
        trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
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
    const { name, description, price, compareAtPrice, images, variants, stock, sku, category, active } = req.body;
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
        variants: Array.isArray(variants) ? variants : [],
        stock: Number(stock) || 0,
        sku: sku || null,
        category: category || null,
        active: active !== undefined ? !!active : true,
      },
    });
    res.json({ product });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/products/bulk — олон бараа нэг дор оруулах (CSV/Excel import)
router.post("/products/bulk", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.products) ? req.body.products : [];
    if (!items.length) return res.status(400).json({ error: "products массив хоосон байна" });
    if (items.length > 1000) return res.status(400).json({ error: "Нэг удаад дээд тал нь 1000 бараа" });
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    const data = items
      .filter((p) => p && String(p.name || "").trim())
      .map((p, i) => ({
        storeId: store.id,
        orgId: req.org.orgId,
        name: String(p.name).trim(),
        description: p.description ? String(p.description) : null,
        price: Number(p.price) || 0,
        compareAtPrice: p.compareAtPrice != null && p.compareAtPrice !== "" ? Number(p.compareAtPrice) : null,
        images: Array.isArray(p.images) ? p.images : (p.images ? String(p.images).split(/[, ]+/).filter(Boolean) : []),
        stock: Number(p.stock) || 0,
        sku: p.sku ? String(p.sku) : null,
        category: p.category ? String(p.category) : null,
        active: p.active !== undefined ? !!p.active : true,
        sortOrder: i,
      }));
    if (!data.length) return res.status(400).json({ error: "Хүчинтэй бараа алга (нэр шаардлагатай)" });

    const result = await prisma.product.createMany({ data });
    res.json({ created: result.count });
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
    if (b.variants !== undefined) data.variants = Array.isArray(b.variants) ? b.variants : [];
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
    const { status, trackingNo } = req.body;
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const order = await prisma.storeOrder.findFirst({ where: { id: req.params.id, storeId: store.id } });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });

    const ALLOWED = ["NEW", "PAID", "SHIPPED", "DONE", "CANCELLED", "REFUNDED"];
    const data = {};
    if (status !== undefined) {
      if (!ALLOWED.includes(status)) return res.status(400).json({ error: "Буруу төлөв" });
      data.status = status;
    }
    if (trackingNo !== undefined) data.trackingNo = trackingNo ? String(trackingNo).slice(0, 120) : null;
    if (Object.keys(data).length === 0) return res.json({ order });

    const updated = await prisma.storeOrder.update({ where: { id: order.id }, data });
    res.json({ order: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/orders/:id/refund — буцаалт бүртгэх (дүн + шалтгаан). Бүтэн бол status=REFUNDED
router.post("/orders/:id/refund", async (req, res) => {
  try {
    const { amount, reason } = req.body || {};
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const order = await prisma.storeOrder.findFirst({ where: { id: req.params.id, storeId: store.id } });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });

    const amt = Math.max(0, Math.min(Number(amount) || 0, order.totalAmount));
    if (!amt) return res.status(400).json({ error: "Буцаах дүнг зөв оруулна уу" });
    const full = amt >= order.totalAmount;

    const updated = await prisma.storeOrder.update({
      where: { id: order.id },
      data: {
        refundedAmount: amt,
        refundReason: reason ? String(reason).slice(0, 300) : null,
        refundedAt: new Date(),
        status: full ? "REFUNDED" : order.status,
      },
    });
    res.json({ order: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Reviews (барааны сэтгэгдэл — модераци) ──────────────────────────────────

// GET /store/reviews — бүх сэтгэгдэл (бараа тус бүрийн нэртэй)
router.get("/reviews", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const reviews = await prisma.review.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "desc" }, take: 500 });
    const ids = [...new Set(reviews.map((r) => r.productId))];
    const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nameById = new Map(products.map((p) => [p.id, p.name]));
    res.json({ reviews: reviews.map((r) => ({ ...r, productName: nameById.get(r.productId) || "—" })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /store/reviews/:id — нуух/харуулах (approved)
router.patch("/reviews/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const review = await prisma.review.findFirst({ where: { id: req.params.id, storeId: store.id } });
    if (!review) return res.status(404).json({ error: "Сэтгэгдэл олдсонгүй" });
    const updated = await prisma.review.update({ where: { id: review.id }, data: { approved: !!req.body.approved } });
    res.json({ review: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /store/reviews/:id
router.delete("/reviews/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const review = await prisma.review.findFirst({ where: { id: req.params.id, storeId: store.id } });
    if (!review) return res.status(404).json({ error: "Сэтгэгдэл олдсонгүй" });
    await prisma.review.delete({ where: { id: review.id } });
    res.json({ ok: true });
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

// ─── Домэйн зарах (Vercel registrar дээр) ────────────────────────────────────

// GET /store/domain/search?q=нэр
router.get("/domain/search", async (req, res) => {
  try {
    if (!vdomains.enabled()) return res.status(503).json({ error: "Домэйн үйлчилгээ идэвхгүй байна" });
    const results = await vdomains.search(req.query.q || "");
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /store/domain/tlds — TLD бүрийн суурь үнэ (жагсаалтад)
router.get("/domain/tlds", async (req, res) => {
  try {
    if (!vdomains.enabled()) return res.status(503).json({ error: "Домэйн үйлчилгээ идэвхгүй байна" });
    res.json({ tlds: await vdomains.tldPrices() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/domain/purchase { domain } — QPay invoice үүсгэнэ
router.post("/domain/purchase", async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain || !/^[a-z0-9-]+\.[a-z]{2,}$/i.test(domain)) return res.status(400).json({ error: "Домэйн буруу байна" });
    if (!vdomains.enabled()) return res.status(503).json({ error: "Домэйн үйлчилгээ идэвхгүй байна" });
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    // Боломж + үнийг сервер талд дахин шалгана
    const avail = await vdomains.availability(domain);
    if (!avail) return res.status(409).json({ error: "Энэ домэйн боломжгүй болсон байна" });
    const pd = await vdomains.priceData(domain);
    const priceMnt = vdomains.toMnt(pd.purchasePrice);

    const order = await prisma.domainOrder.create({ data: { storeId: store.id, orgId: req.org.orgId, domain, priceMnt, priceUsd: pd.purchasePrice, status: "pending", qpayStatus: "PENDING" } });
    const inv = await platformQpay.createDomainInvoice({ orgId: req.org.orgId, amount: priceMnt, description: `Домэйн худалдан авалт: ${domain}` });
    await prisma.domainOrder.update({ where: { id: order.id }, data: { qpayInvoiceId: inv.invoice_id, qpayQrText: inv.qr_text, qpayUrls: inv.urls || [] } });

    res.json({ orderId: order.id, domain, priceMnt, payment: { qrText: inv.qr_text, qrImage: inv.qr_image, urls: inv.urls || [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /store/domain/purchase/:id/status — төлбөр баталгаажвал худалдаж аваад дэлгүүрт холбоно
router.get("/domain/purchase/:id/status", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });
    const order = await prisma.domainOrder.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });

    if (order.status === "registered") return res.json({ status: "registered", domain: order.domain });
    if (order.status === "failed") return res.json({ status: "failed", error: order.errorMsg || "Алдаа гарлаа" });
    if (!order.qpayInvoiceId) return res.json({ status: order.status });

    const pay = await platformQpay.checkPayment(order.qpayInvoiceId);
    if (pay.invoice_status !== "PAID") return res.json({ status: "pending" });

    // Төлсөн — ИДЕМПОТЕНТ биелүүлэлт (polling + webhook давхар ажиллавал ч нэг л удаа авна)
    if (order.status === "pending") {
      const r = await fulfillDomainOrder(prisma, { vdomains, vercel }, order);
      if (r.status === "registered") return res.json({ status: "registered", domain: order.domain });
      if (r.status === "failed") return res.json({ status: "failed", error: "Домэйн бүртгэхэд алдаа гарлаа. Бидэнтэй холбогдоно уу." });
      return res.json({ status: r.status || "paid" });
    }
    res.json({ status: order.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Ангилал (Categories) ────────────────────────────────────────────────────

function slugify(text) {
  return text.toLowerCase().replace(/[^\wЀ-ӿ]+/g, "-").replace(/^-|-$/g, "") || "cat";
}

// GET /store/categories
router.get("/categories", async (req, res) => {
  try {
    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    const categories = await prisma.storeCategory.findMany({
      where: { storeId: store.id },
      orderBy: { sortOrder: "asc" },
    });

    const productCounts = await prisma.product.groupBy({
      by: ["category"],
      where: { storeId: store.id, active: true },
      _count: true,
    });
    const countMap = {};
    for (const pc of productCounts) {
      if (pc.category) countMap[pc.category] = pc._count;
    }

    res.json({ categories: categories.map(c => ({ ...c, productCount: countMap[c.name] || 0 })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/categories
router.post("/categories", async (req, res) => {
  try {
    const { name, image } = req.body;
    if (!name) return res.status(400).json({ error: "Ангилалын нэр шаардлагатай" });

    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    const count = await prisma.storeCategory.count({ where: { storeId: store.id } });
    let slug = slugify(name);
    const exists = await prisma.storeCategory.findUnique({ where: { storeId_slug: { storeId: store.id, slug } } });
    if (exists) slug = `${slug}-${Date.now().toString(36)}`;

    const cat = await prisma.storeCategory.create({
      data: { storeId: store.id, orgId: req.org.orgId, name, slug, image: image || null, sortOrder: count },
    });
    res.json({ category: cat });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /store/categories/:id
router.patch("/categories/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const cat = await prisma.storeCategory.findUnique({ where: { id: req.params.id } });
    if (!cat || cat.orgId !== req.org.orgId) return res.status(404).json({ error: "Ангилал олдсонгүй" });

    const data = {};
    if (req.body.name !== undefined) { data.name = req.body.name; data.slug = slugify(req.body.name); }
    if (req.body.image !== undefined) data.image = req.body.image;
    if (req.body.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder);

    const updated = await prisma.storeCategory.update({ where: { id: req.params.id }, data });
    res.json({ category: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /store/categories/:id
router.delete("/categories/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const cat = await prisma.storeCategory.findUnique({ where: { id: req.params.id } });
    if (!cat || cat.orgId !== req.org.orgId) return res.status(404).json({ error: "Ангилал олдсонгүй" });

    await prisma.storeCategory.delete({ where: { id: req.params.id } });
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

// ─── Trial / Subscription Expiry ────────────────────────────────────────────

// POST /store/cron/expire — trial/subscription дууссан дэлгүүрүүдийг draft болгоно
router.post("/cron/expire", async (req, res) => {
  const secret = req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) return res.status(403).json({ error: "forbidden" });

  try {
    const prisma = getPrisma();
    const now = new Date();

    const expired = await prisma.store.updateMany({
      where: {
        status: "published",
        OR: [
          { webPlan: "trial", trialEndsAt: { lt: now } },
          { webPlan: "active", webExpiresAt: { lt: now } },
        ],
      },
      data: { status: "draft", webPlan: "expired" },
    });

    res.json({ ok: true, expiredCount: expired.count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Subscription & Wallet ──────────────────────────────────────────────────

const WEB_PLAN_PRICE = 99000; // ₮/сар

// GET /store/subscription — subscription + wallet мэдээлэл
router.get("/subscription", async (req, res) => {
  try {
    const prisma = getPrisma();
    let store = await prisma.store.findUnique({
      where: { orgId: req.org.orgId },
      select: { id: true, webPlan: true, trialEndsAt: true, webExpiresAt: true, slug: true, status: true, createdAt: true },
    });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    if (store.webPlan === "trial" && !store.trialEndsAt) {
      const trialEndsAt = new Date(store.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      await prisma.store.update({ where: { id: store.id }, data: { trialEndsAt } });
      store = { ...store, trialEndsAt };
    }

    let wallet = await prisma.webWallet.findUnique({ where: { orgId: req.org.orgId } });
    if (!wallet) wallet = await prisma.webWallet.create({ data: { orgId: req.org.orgId } });

    const txs = await prisma.webWalletTx.findMany({
      where: { orgId: req.org.orgId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    res.json({
      plan: store.webPlan,
      trialEndsAt: store.trialEndsAt,
      webExpiresAt: store.webExpiresAt,
      storeStatus: store.status,
      slug: store.slug,
      wallet: { balance: wallet.balance },
      transactions: txs,
      price: WEB_PLAN_PRICE,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/subscription/topup — хэтэвч цэнэглэх QPay invoice
router.post("/subscription/topup", async (req, res) => {
  try {
    const { amount } = req.body;
    const topupAmount = Number(amount);
    if (!topupAmount || topupAmount < 1000) return res.status(400).json({ error: "Хамгийн бага цэнэглэх дүн 1,000₮" });

    const prisma = getPrisma();
    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { slug: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    const apiUrl = process.env.API_URL || "https://api.mongolagent.mn";
    const inv = await platformQpay.createInvoice({
      orgId: req.org.orgId,
      plan: "website-topup",
      amount: topupAmount,
      description: `MA-WEBSITE-${store.slug.toUpperCase()}`,
      callbackUrl: `${apiUrl}/webhook/web-wallet/${req.org.orgId}`,
    });

    const tx = await prisma.webWalletTx.create({
      data: {
        orgId: req.org.orgId,
        amount: topupAmount,
        type: "topup",
        description: `Хэтэвч цэнэглэлт ${topupAmount.toLocaleString()}₮`,
        qpayInvoiceId: inv.invoice_id,
        qpayStatus: "PENDING",
      },
    });

    res.json({
      txId: tx.id,
      qr_text: inv.qr_text,
      qr_image: inv.qr_image,
      urls: inv.urls,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/subscription/topup/:txId/check — төлбөр шалгах
router.post("/subscription/topup/:txId/check", async (req, res) => {
  try {
    const prisma = getPrisma();
    const tx = await prisma.webWalletTx.findUnique({ where: { id: req.params.txId } });
    if (!tx || tx.orgId !== req.org.orgId) return res.status(404).json({ error: "Гүйлгээ олдсонгүй" });
    if (tx.qpayStatus === "PAID") return res.json({ status: "PAID", balance: (await prisma.webWallet.findUnique({ where: { orgId: req.org.orgId } }))?.balance ?? 0 });

    const result = await platformQpay.checkPayment(tx.qpayInvoiceId);
    const paid = (result.count != null ? result.count > 0 : false) || result.payment_status === "PAID";
    if (!paid) return res.json({ status: "PENDING" });

    const { applyWalletTopup } = require("../services/payment.service");
    await applyWalletTopup(prisma, tx); // идемпотент — давхар цэнэглэхгүй
    const wallet = await prisma.webWallet.findUnique({ where: { orgId: req.org.orgId } });

    res.json({ status: "PAID", balance: wallet?.balance ?? 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /store/subscription/activate — хэтэвчээс хасаж 1 сар сунгах
router.post("/subscription/activate", async (req, res) => {
  try {
    const prisma = getPrisma();
    const wallet = await prisma.webWallet.findUnique({ where: { orgId: req.org.orgId } });
    if (!wallet || wallet.balance < WEB_PLAN_PRICE) {
      return res.status(400).json({ error: `Хэтэвчинд хүрэлцэхгүй байна. ${WEB_PLAN_PRICE.toLocaleString()}₮ шаардлагатай.` });
    }

    const store = await prisma.store.findUnique({ where: { orgId: req.org.orgId }, select: { id: true, webExpiresAt: true } });
    if (!store) return res.status(404).json({ error: "Дэлгүүр олдсонгүй" });

    const now = new Date();
    const currentEnd = store.webExpiresAt && store.webExpiresAt > now ? store.webExpiresAt : now;
    const newEnd = new Date(currentEnd.getTime() + 30 * 24 * 60 * 60 * 1000);

    await prisma.$transaction([
      prisma.webWallet.update({
        where: { orgId: req.org.orgId },
        data: { balance: { decrement: WEB_PLAN_PRICE } },
      }),
      prisma.webWalletTx.create({
        data: {
          orgId: req.org.orgId,
          amount: -WEB_PLAN_PRICE,
          type: "deduct",
          description: `Үйлчилгээний эрх сунгалт (1 сар)`,
          qpayStatus: "PAID",
        },
      }),
      prisma.store.update({
        where: { orgId: req.org.orgId },
        data: { webPlan: "active", webExpiresAt: newEnd, status: "published" },
      }),
    ]);

    res.json({ ok: true, webExpiresAt: newEnd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
