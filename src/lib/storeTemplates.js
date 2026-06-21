"use strict";

/**
 * Website builder template-ууд.
 *
 * `content` нь Puck (@measured/puck) форматтай: { root, content: [{ type, props }] }.
 * Builder dashboard (mongolagent-website) эдгээрийг засна, renderer (mongolagent-store)
 * эдгээрийг React component болгож харуулна. Block type бүр хоёр талд ижил нэртэй байна.
 *
 * Template сонгоход доорх `pages` болон `theme`-г шинэ Store-д хууж тавина.
 */

const TEMPLATES = [
  {
    id: "minimal",
    name: "Minimal",
    description: "Цэвэрхэн, цагаан суурьтай энгийн дэлгүүр.",
    thumbnail: "/templates/minimal.png",
    theme: {
      primaryColor: "#111827",
      bgColor: "#ffffff",
      textColor: "#111827",
      font: "Inter",
      logoUrl: "",
    },
    pages: [
      {
        title: "Нүүр",
        path: "/",
        type: "home",
        content: {
          root: { props: { title: "Нүүр" } },
          content: [
            { type: "Hero", props: { id: "hero-1", heading: "Тавтай морил", subheading: "Манай бараа бүтээгдэхүүнтэй танилцана уу.", image: "", ctaText: "Дэлгүүр үзэх", ctaHref: "#products" } },
            { type: "ProductGrid", props: { id: "grid-1", heading: "Онцлох бараа", columns: 3, limit: 6 } },
            { type: "Footer", props: { id: "footer-1", text: "© 2026 Манай дэлгүүр" } },
          ],
        },
      },
    ],
  },
  {
    id: "boutique",
    name: "Boutique",
    description: "Дулаан өнгөтэй, хувцас/гоо сайхны дэлгүүрт тохирно.",
    thumbnail: "/templates/boutique.png",
    theme: {
      primaryColor: "#b45309",
      bgColor: "#fffaf3",
      textColor: "#3f3f46",
      font: "Playfair Display",
      logoUrl: "",
    },
    pages: [
      {
        title: "Нүүр",
        path: "/",
        type: "home",
        content: {
          root: { props: { title: "Нүүр" } },
          content: [
            { type: "Hero", props: { id: "hero-1", heading: "Шинэ цуглуулга", subheading: "Улирлын онцлох загварууд.", image: "", ctaText: "Дэлгүүр үзэх", ctaHref: "#products" } },
            { type: "ProductGrid", props: { id: "grid-1", heading: "Бараанууд", columns: 2, limit: 8 } },
            { type: "About", props: { id: "about-1", heading: "Бидний тухай", text: "Бид чанартай бүтээгдэхүүнийг хайраар хүргэдэг." } },
            { type: "Footer", props: { id: "footer-1", text: "© 2026 Boutique" } },
          ],
        },
      },
    ],
  },
  {
    id: "modern",
    name: "Modern",
    description: "Бараан суурьтай, технологи/электроникийн дэлгүүрт тохирно.",
    thumbnail: "/templates/modern.png",
    theme: {
      primaryColor: "#6366f1",
      bgColor: "#0b0b14",
      textColor: "#e5e7eb",
      font: "Inter",
      logoUrl: "",
    },
    pages: [
      {
        title: "Нүүр",
        path: "/",
        type: "home",
        content: {
          root: { props: { title: "Нүүр" } },
          content: [
            { type: "Hero", props: { id: "hero-1", heading: "Ирээдүйн технологи", subheading: "Шилдэг бүтээгдэхүүнийг нэг дороос.", image: "", ctaText: "Худалдаж авах", ctaHref: "#products" } },
            { type: "ProductGrid", props: { id: "grid-1", heading: "Шинэ бараа", columns: 3, limit: 9 } },
            { type: "Footer", props: { id: "footer-1", text: "© 2026 Modern Store" } },
          ],
        },
      },
    ],
  },
];

function listTemplates() {
  // Жагсаалтад content-г бүхэлд нь явуулахгүй — зөвхөн товч мэдээлэл
  return TEMPLATES.map(({ id, name, description, thumbnail, theme }) => ({ id, name, description, thumbnail, theme }));
}

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

module.exports = { TEMPLATES, listTemplates, getTemplate };
