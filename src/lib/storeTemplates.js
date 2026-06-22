"use strict";

/**
 * Website builder template-ууд (Shopify theme store маяг).
 *
 * Template бүр:
 *   theme        — өнгө, фонт
 *   pages        — нүүр хуудасны Puck блокууд (Hero/ProductGrid/About/Footer г.м)
 *   demoProducts — жишээ бараа (хэрэглэгч сонгоход дэлгүүр шууд дүүрэн харагдана)
 *
 * Зургийг picsum.photos-оор demo болгож авна (хэрэглэгч дараа нь өөрийн зургаар солино).
 */

const img = (seed, w = 600, h = 600) => `https://picsum.photos/seed/${seed}/${w}/${h}`;

function homePage(content) {
  return [{ title: "Нүүр", path: "/", type: "home", content }];
}

// Бүх template-д default-аар орох "Захиалгын мэдээлэл" хэсэг
const INFO_CARDS = {
  type: "InfoCards",
  props: {
    id: "info",
    heading: "Захиалгын мэдээлэл",
    subheading: "Та манайхаар үйлчлүүлэхээсээ өмнө доорх мэдээлэлтэй танилцана уу?",
    items: [
      { title: "Хүргэлтийн нөхцөл", text: "Хүргэлтийн төлбөр 7,000₮. 50,000₮-с дээш худалдан авалтад хүргэлт үнэгүй. Захиалга баталгаажсанаас хойш 24-48 цагт хүргэнэ." },
      { title: "Төлбөрийн мэдээлэл", text: "Та бүтээгдэхүүний төлбөр + хүргэлтийн төлбөрөө 100% төлснөөр захиалга баталгаажна. QPay болон банкны шилжүүлгийг хүлээн авна." },
      { title: "Үйлчилгээний нөхцөл", text: "Бараагаа зөв сонгоно уу. Буцаалт, солилт хийх боломжгүйг анхаарна уу. Гэмтэлтэй бараа ирсэн тохиолдолд бид хариуцна." },
    ],
  },
};

const TEMPLATES = [
  // ── 1. Aurora — хувцас / загвар ──────────────────────────────
  {
    id: "aurora",
    name: "Aurora",
    description: "Хувцас, загварын дэлгүүрт тохирох гоёмсог, цэвэрхэн загвар.",
    category: "Хувцас",
    theme: { primaryColor: "#111111", bgColor: "#ffffff", textColor: "#1a1a1a", font: "Lora" },
    pages: homePage({
      root: { props: { title: "Нүүр" } },
      content: [
        { type: "Hero", props: { id: "h", heading: "Шинэ улирлын цуглуулга", subheading: "Загварлаг, чанартай хувцасны шинэ түрээ.", image: img("aurora-hero", 1400, 600), ctaText: "Дэлгүүр үзэх", ctaHref: "#products" } },
        { type: "ProductGrid", props: { id: "g", heading: "Онцлох бараа", columns: "3", limit: 6 } },
        { type: "About", props: { id: "a", heading: "Бидний тухай", text: "Бид дэлхийн жишигт нийцсэн чанартай бүтээгдэхүүнийг хайраар хүргэдэг." } },
        INFO_CARDS,
        { type: "Footer", props: { id: "f", text: "© 2026 Aurora — Бүх эрх хуулиар хамгаалагдсан" } },
      ],
    }),
    demoProducts: [
      { name: "Оверсайз цамц", price: 89000, compareAtPrice: 120000, category: "Дээд хувцас", images: [img("aurora-1")] },
      { name: "Хөвөн футболк", price: 45000, category: "Дээд хувцас", images: [img("aurora-2")] },
      { name: "Деним хүрэм", price: 159000, category: "Гадуур хувцас", images: [img("aurora-3")] },
      { name: "Маалинган өмд", price: 98000, category: "Доод хувцас", images: [img("aurora-4")] },
      { name: "Нэхмэл цамц", price: 75000, compareAtPrice: 95000, category: "Дээд хувцас", images: [img("aurora-5")] },
      { name: "Арьсан гутал", price: 210000, category: "Гутал", images: [img("aurora-6")] },
    ],
  },

  // ── 2. Nova — технологи / электроник ─────────────────────────
  {
    id: "nova",
    name: "Nova",
    description: "Электроник, гаджетын дэлгүүрт тохирох орчин үеийн загвар.",
    category: "Технологи",
    theme: { primaryColor: "#6366f1", bgColor: "#ffffff", textColor: "#0f172a", font: "Inter" },
    pages: homePage({
      root: { props: { title: "Нүүр" } },
      content: [
        { type: "Hero", props: { id: "h", heading: "Ирээдүйн технологи", subheading: "Шилдэг гаджетуудыг нэг дороос.", image: img("nova-hero", 1400, 600), ctaText: "Худалдаж авах", ctaHref: "#products" } },
        { type: "ProductGrid", props: { id: "g", heading: "Шинэ бараа", columns: "4", limit: 8 } },
        { type: "Text", props: { id: "t", text: "Бүх бараанд албан ёсны баталгаа болон хүргэлт үнэгүй.", align: "center" } },
        INFO_CARDS,
        { type: "Footer", props: { id: "f", text: "© 2026 Nova Store" } },
      ],
    }),
    demoProducts: [
      { name: "Утасгүй чихэвч", price: 189000, compareAtPrice: 230000, category: "Аудио", images: [img("nova-1")] },
      { name: "Ухаалаг цаг", price: 320000, category: "Гаджет", images: [img("nova-2")] },
      { name: "Bluetooth чанга яригч", price: 145000, category: "Аудио", images: [img("nova-3")] },
      { name: "Зөөврийн цэнэглэгч", price: 79000, category: "Дагалдах", images: [img("nova-4")] },
      { name: "Механик гар", price: 260000, compareAtPrice: 300000, category: "Компьютер", images: [img("nova-5")] },
      { name: "USB-C хаб", price: 98000, category: "Дагалдах", images: [img("nova-6")] },
      { name: "Веб камер 4K", price: 175000, category: "Компьютер", images: [img("nova-7")] },
      { name: "Тоглоомын хулгана", price: 110000, category: "Компьютер", images: [img("nova-8")] },
    ],
  },

  // ── 3. Bloom — гоо сайхан / арьс арчилгаа ────────────────────
  {
    id: "bloom",
    name: "Bloom",
    description: "Гоо сайхан, арьс арчилгааны бараанд тохирох зөөлөн загвар.",
    category: "Гоо сайхан",
    theme: { primaryColor: "#db2777", bgColor: "#fff7fb", textColor: "#3f1d2e", font: "Montserrat" },
    pages: homePage({
      root: { props: { title: "Нүүр" } },
      content: [
        { type: "Hero", props: { id: "h", heading: "Байгалийн гоо сайхан", subheading: "Арьсандаа ээлтэй, чанартай бүтээгдэхүүн.", image: img("bloom-hero", 1400, 600), ctaText: "Дэлгүүр үзэх", ctaHref: "#products" } },
        { type: "ProductGrid", props: { id: "g", heading: "Хамгийн их зарагдсан", columns: "3", limit: 6 } },
        { type: "About", props: { id: "a", heading: "Цэвэр найрлага", text: "Манай бүх бүтээгдэхүүн байгалийн гаралтай, амьтан туршилтгүй." } },
        INFO_CARDS,
        { type: "Footer", props: { id: "f", text: "© 2026 Bloom Beauty" } },
      ],
    }),
    demoProducts: [
      { name: "Чийгшүүлэгч тос", price: 68000, category: "Арьс арчилгаа", images: [img("bloom-1")] },
      { name: "Нүүрний цэвэрлэгч", price: 42000, compareAtPrice: 55000, category: "Арьс арчилгаа", images: [img("bloom-2")] },
      { name: "Сэрум C аминдэм", price: 89000, category: "Арьс арчилгаа", images: [img("bloom-3")] },
      { name: "Уруулын тос", price: 35000, category: "Гоо сайхан", images: [img("bloom-4")] },
      { name: "Нүдний маск", price: 28000, category: "Арьс арчилгаа", images: [img("bloom-5")] },
      { name: "Үнэртэн", price: 120000, compareAtPrice: 150000, category: "Үнэртэн", images: [img("bloom-6")] },
    ],
  },

  // ── 4. Mono — минимал / монохром ─────────────────────────────
  {
    id: "mono",
    name: "Mono",
    description: "Хар цагаан, маш цэвэрхэн минимал загвар — аливаа бараанд тохирно.",
    category: "Минимал",
    theme: { primaryColor: "#18181b", bgColor: "#fafafa", textColor: "#18181b", font: "Inter" },
    pages: homePage({
      root: { props: { title: "Нүүр" } },
      content: [
        { type: "Hero", props: { id: "h", heading: "Энгийн. Гоё.", subheading: "Чанарт төвлөрсөн минимал дэлгүүр.", image: "", ctaText: "Бараа үзэх", ctaHref: "#products" } },
        { type: "ProductGrid", props: { id: "g", heading: "Бүтээгдэхүүн", columns: "3", limit: 6 } },
        { type: "About", props: { id: "a", heading: "Манай философи", text: "Илүүдэлгүй, зөвхөн хэрэгтэй нь. Чанар бол бидний эхлэл." } },
        INFO_CARDS,
        { type: "Footer", props: { id: "f", text: "© 2026 Mono" } },
      ],
    }),
    demoProducts: [
      { name: "Керамик аяга", price: 32000, category: "Гэр ахуй", images: [img("mono-1")] },
      { name: "Тэмдэглэлийн дэвтэр", price: 18000, category: "Бичиг хэрэг", images: [img("mono-2")] },
      { name: "Модон тавиур", price: 56000, category: "Гэр ахуй", images: [img("mono-3")] },
      { name: "Хөвөн алчуур", price: 24000, compareAtPrice: 30000, category: "Гэр ахуй", images: [img("mono-4")] },
      { name: "Шилэн ваар", price: 45000, category: "Гэр ахуй", images: [img("mono-5")] },
      { name: "Лааны суурь", price: 38000, category: "Гэр ахуй", images: [img("mono-6")] },
    ],
  },

  // ── 5. Fresh — хүнс / органик ────────────────────────────────
  {
    id: "fresh",
    name: "Fresh",
    description: "Хүнс, органик бүтээгдэхүүний дэлгүүрт тохирох дулаан загвар.",
    category: "Хүнс",
    theme: { primaryColor: "#16a34a", bgColor: "#f7faf5", textColor: "#14271a", font: "Inter" },
    pages: homePage({
      root: { props: { title: "Нүүр" } },
      content: [
        { type: "Hero", props: { id: "h", heading: "Шинэхэн, эрүүл бүтээгдэхүүн", subheading: "Өдөр бүр шинэ, чанартай хүнс.", image: img("fresh-hero", 1400, 600), ctaText: "Захиалах", ctaHref: "#products" } },
        { type: "ProductGrid", props: { id: "g", heading: "Өнөөдрийн шинэ", columns: "4", limit: 8 } },
        { type: "About", props: { id: "a", heading: "Фермээс шууд", text: "Бид орон нутгийн фермерүүдтэй хамтран ажиллаж, хамгийн шинэхэн бүтээгдэхүүнийг хүргэдэг." } },
        INFO_CARDS,
        { type: "Footer", props: { id: "f", text: "© 2026 Fresh Market" } },
      ],
    }),
    demoProducts: [
      { name: "Органик зөгийн бал", price: 28000, category: "Хүнс", images: [img("fresh-1")] },
      { name: "Шинэ жимс багц", price: 35000, compareAtPrice: 42000, category: "Жимс", images: [img("fresh-2")] },
      { name: "Гар хийц талх", price: 12000, category: "Талх", images: [img("fresh-3")] },
      { name: "Органик өндөг (10ш)", price: 9000, category: "Хүнс", images: [img("fresh-4")] },
      { name: "Ногоон цай", price: 22000, category: "Уух зүйл", images: [img("fresh-5")] },
      { name: "Самрын хольц", price: 31000, category: "Зууш", images: [img("fresh-6")] },
      { name: "Цэвэр ус 5л", price: 6000, category: "Уух зүйл", images: [img("fresh-7")] },
      { name: "Органик ногоо багц", price: 26000, category: "Ногоо", images: [img("fresh-8")] },
    ],
  },
];

// Жагсаалтад content/demoProducts-г бүхэлд нь явуулахгүй — товч мэдээлэл
function listTemplates() {
  return TEMPLATES.map(({ id, name, description, category, theme }) => ({ id, name, description, category, theme }));
}

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

module.exports = { TEMPLATES, listTemplates, getTemplate };
