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

// Гүйдэг зар (announcement) — олон template-д ашиглана
const announce = (text, bgColor, txtColor) => ({ type: "Announcement", props: { id: "ann", text, bgColor, txtColor: txtColor || "#ffffff" } });
// Ангилал картууд
const categories = (id, heading, items, extra = {}) => ({ type: "Categories", props: { id, heading, items, columns: String(items.length > 4 ? 4 : items.length), gap: "md", radius: "lg", ratio: "4/3", overlay: 30, ...extra } });
// Сэтгэгдэл
const testimonials = (id, heading, items, extra = {}) => ({ type: "Testimonials", props: { id, heading, items, columns: "3", gap: "md", radius: "lg", cardStyle: "fill", ...extra } });

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
        announce("✦ Шинэ улирлын цуглуулга ирлээ · Үнэгүй хүргэлт 100,000₮-с дээш · -20% хүртэл хямдрал", "#111111"),
        { type: "Hero", props: { id: "h", heading: "Шинэ улирлын цуглуулга", subheading: "Загварлаг, чанартай хувцасны шинэ түрээ.", image: img("aurora-hero", 1400, 700), ctaText: "Дэлгүүр үзэх", ctaHref: "#products", ctaColor: "#111111", align: "center", height: "lg", headingSize: "xl", overlay: 35 } },
        categories("cat", "Ангилал", [
          { label: "Дээд хувцас", image: img("aurora-cat1", 600, 450) },
          { label: "Гадуур хувцас", image: img("aurora-cat2", 600, 450) },
          { label: "Гутал", image: img("aurora-cat3", 600, 450) },
        ]),
        { type: "ProductGrid", props: { id: "g", heading: "Онцлох бараа", columns: "3", limit: 6, gap: "md", cardRadius: "md", pad: "md" } },
        { type: "ImageText", props: { id: "it", heading: "Бидний түүх", text: "Aurora нь чанар, загвар хоёрыг хослуулсан монгол брэнд. Бид дэлхийн жишигт нийцсэн материалаар хязгаарлагдмал цуглуулга бүтээдэг.", image: img("aurora-story", 800, 600), imagePosition: "left", buttonText: "Дэлгэрэнгүй", buttonHref: "#products", radius: "lg", ratio: "4/3", align: "left" } },
        { type: "Features", props: { id: "fe", heading: "Яагаад Aurora гэж?", columns: "3", gap: "md", align: "center", items: [
          { title: "Чанарын баталгаа", text: "Сонгомол материал, нямбай оёдол." },
          { title: "Хурдан хүргэлт", text: "Улаанбаатарт 24-48 цагт." },
          { title: "Амар буцаалт", text: "14 хоногийн дотор солилт." },
        ] } },
        testimonials("ts", "Үйлчлүүлэгчдийн сэтгэгдэл", [
          { name: "Ану", role: "Байнгын үйлчлүүлэгч", text: "Чанар нь үнэхээр гайхалтай. Дахин авна!" },
          { name: "Тэмүүлэн", role: "", text: "Хүргэлт хурдан, баглаа боодол гоё." },
          { name: "Сэлэнгэ", role: "", text: "Загвар нь онцгой, бусдаас ялгарна." },
        ]),
        INFO_CARDS,
        { type: "Newsletter", props: { id: "nl", heading: "Шинэ цуглуулгаас түрүүлж аваарай", text: "Имэйлээ үлдээгээд хямдрал, шинэ бараагаа хамгийн түрүүнд аваарай.", buttonText: "Бүртгүүлэх", align: "center" } },
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
        announce("⚡ Бүх бараанд албан ёсны баталгаа · Үнэгүй хүргэлт · QPay-ээр хялбар төлбөр", "#6366f1"),
        { type: "Slideshow", props: { id: "ss", height: "lg", align: "center", overlay: 45, speed: 5, slides: [
          { image: img("nova-slide1", 1400, 700), heading: "Ирээдүйн технологи", subheading: "Шилдэг гаджетуудыг нэг дороос.", ctaText: "Худалдаж авах", ctaHref: "#products" },
          { image: img("nova-slide2", 1400, 700), heading: "Шинэ үеийн дэлгэц", subheading: "4K тод байдал, өндөр гүйцэтгэл.", ctaText: "Үзэх", ctaHref: "#products" },
        ] } },
        categories("cat", "Бүлгүүд", [
          { label: "Аудио", image: img("nova-cat1", 600, 450) },
          { label: "Компьютер", image: img("nova-cat2", 600, 450) },
          { label: "Гаджет", image: img("nova-cat3", 600, 450) },
          { label: "Дагалдах", image: img("nova-cat4", 600, 450) },
        ], { columns: "4" }),
        { type: "ProductGrid", props: { id: "g", heading: "Шинэ бараа", columns: "4", limit: 8, gap: "md", cardRadius: "lg", pad: "md" } },
        { type: "Banner", props: { id: "bn", heading: "Зуны их хямдрал", text: "Сонгосон гаджетууд -30% хүртэл хямдарлаа.", buttonText: "Хямдралыг үзэх", buttonHref: "#products", bgColor: "#6366f1", btnColor: "#ffffff", btnTextColor: "#4338ca", align: "center", headingSize: "lg", radius: "lg" } },
        { type: "Stats", props: { id: "st", columns: "4", size: "lg", valueColor: "#6366f1", items: [
          { value: "50k+", label: "Үйлчлүүлэгч" },
          { value: "12k+", label: "Захиалга" },
          { value: "4.9", label: "Дундаж үнэлгээ" },
          { value: "24/7", label: "Тусламж" },
        ] } },
        { type: "Features", props: { id: "fe", heading: "Манай давуу тал", columns: "3", gap: "md", iconColor: "#eef0fe", align: "center", items: [
          { title: "Албан ёсны баталгаа", text: "Бүх бараа 1+ жилийн баталгаатай." },
          { title: "Үнэгүй хүргэлт", text: "100,000₮-с дээш захиалгад." },
          { title: "Найдвартай төлбөр", text: "QPay болон картаар аюулгүй." },
        ] } },
        INFO_CARDS,
        { type: "Newsletter", props: { id: "nl", heading: "Шинэ бүтээгдэхүүний мэдээ", text: "Технологийн шинэ бараа, онцгой саналыг имэйлээр аваарай.", buttonText: "Бүртгүүлэх", align: "center", btnColor: "#6366f1" } },
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
        announce("🌸 Байгалийн найрлага · Амьтан туршилтгүй · Үнэгүй дээж бэлэглэнэ", "#db2777"),
        { type: "Hero", props: { id: "h", heading: "Байгалийн гоо сайхан", subheading: "Арьсандаа ээлтэй, чанартай бүтээгдэхүүн.", image: img("bloom-hero", 1400, 700), ctaText: "Дэлгүүр үзэх", ctaHref: "#products", ctaColor: "#db2777", align: "left", height: "lg", headingSize: "xl", overlay: 25 } },
        categories("cat", "Ангилал", [
          { label: "Арьс арчилгаа", image: img("bloom-cat1", 600, 450) },
          { label: "Гоо сайхан", image: img("bloom-cat2", 600, 450) },
          { label: "Үнэртэн", image: img("bloom-cat3", 600, 450) },
        ], { radius: "full", overlay: 20 }),
        { type: "ProductGrid", props: { id: "g", heading: "Хамгийн их зарагдсан", columns: "3", limit: 6, gap: "lg", cardRadius: "lg", pad: "md" } },
        { type: "ImageText", props: { id: "it", heading: "Цэвэр найрлага", text: "Манай бүх бүтээгдэхүүн байгалийн гаралтай, парабен болон хортой нэмэлтгүй. Арьсыг гэмтээхгүйгээр гялалзуулна.", image: img("bloom-story", 800, 600), imagePosition: "right", buttonText: "", radius: "lg", ratio: "1/1", align: "left", btnColor: "#db2777" } },
        { type: "Gallery", props: { id: "gal", heading: "Инстаграм", columns: "4", gap: "sm", radius: "md", ratio: "1/1", images: [
          { src: img("bloom-g1", 400, 400) }, { src: img("bloom-g2", 400, 400) }, { src: img("bloom-g3", 400, 400) }, { src: img("bloom-g4", 400, 400) },
        ] } },
        testimonials("ts", "Хэрэглэгчид юу гэж хэлдэг вэ?", [
          { name: "Номин", role: "", text: "Арьс минь үнэхээр зөөлөрсөн. Хайртай боллоо!" },
          { name: "Алтанцэцэг", role: "", text: "Үнэр нь гайхалтай, найрлага цэвэрхэн." },
          { name: "Энхжин", role: "", text: "Мэдрэг арьсанд тохирч байна. Баярлалаа." },
        ], { cardStyle: "shadow" }),
        INFO_CARDS,
        { type: "Newsletter", props: { id: "nl", heading: "Гоо сайхны зөвлөгөө аваарай", text: "Шинэ бараа, арьс арчилгааны зөвлөгөөг имэйлээр хүлээн аваарай.", buttonText: "Бүртгүүлэх", align: "center", btnColor: "#db2777" } },
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
        announce("ЭНГИЙН. ГОЁ. — Хязгаарлагдмал цуглуулга · Үнэгүй хүргэлт", "#18181b"),
        { type: "Hero", props: { id: "h", heading: "Энгийн. Гоё.", subheading: "Чанарт төвлөрсөн минимал дэлгүүр.", image: "", ctaText: "Бараа үзэх", ctaHref: "#products", ctaColor: "#18181b", align: "center", height: "md", headingSize: "xl" } },
        { type: "Features", props: { id: "fe", heading: "", columns: "3", gap: "lg", align: "left", iconColor: "#18181b", items: [
          { title: "Илүүдэлгүй дизайн", text: "Зөвхөн хэрэгтэй нь, цэвэрхэн." },
          { title: "Удаан эдэлгээ", text: "Чанартай материал, бат бөх." },
          { title: "Цаг үеэс ангид", text: "Загвар нь хэзээ ч хуучрахгүй." },
        ] } },
        { type: "ProductGrid", props: { id: "g", heading: "Бүтээгдэхүүн", columns: "3", limit: 6, gap: "lg", cardRadius: "none", pad: "lg" } },
        { type: "About", props: { id: "a", heading: "Манай философи", text: "Илүүдэлгүй, зөвхөн хэрэгтэй нь. Чанар бол бидний эхлэл. Бид цөөн боловч төгс зүйлд итгэдэг.", align: "center", headingSize: "lg", bg: "#f4f4f5", pad: "lg" } },
        { type: "Gallery", props: { id: "gal", heading: "", columns: "3", gap: "sm", radius: "none", ratio: "1/1", images: [
          { src: img("mono-g1", 400, 400) }, { src: img("mono-g2", 400, 400) }, { src: img("mono-g3", 400, 400) },
        ] } },
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
        announce("🥬 Өдөр бүр шинэхэн · Фермээс шууд · Тухайн өдөртөө хүргэнэ", "#16a34a"),
        { type: "Hero", props: { id: "h", heading: "Шинэхэн, эрүүл бүтээгдэхүүн", subheading: "Өдөр бүр шинэ, чанартай хүнс.", image: img("fresh-hero", 1400, 700), ctaText: "Захиалах", ctaHref: "#products", ctaColor: "#16a34a", align: "center", height: "lg", headingSize: "xl", overlay: 35 } },
        categories("cat", "Ангилал", [
          { label: "Жимс", image: img("fresh-cat1", 600, 450) },
          { label: "Ногоо", image: img("fresh-cat2", 600, 450) },
          { label: "Талх", image: img("fresh-cat3", 600, 450) },
          { label: "Уух зүйл", image: img("fresh-cat4", 600, 450) },
        ], { columns: "4", radius: "lg" }),
        { type: "ProductGrid", props: { id: "g", heading: "Өнөөдрийн шинэ", columns: "4", limit: 8, gap: "md", cardRadius: "lg", pad: "md" } },
        { type: "Features", props: { id: "fe", heading: "Бидний амлалт", columns: "4", gap: "md", iconColor: "#dcfce7", align: "center", items: [
          { title: "100% шинэхэн", text: "Тухайн өдрийн ургац." },
          { title: "Фермээс шууд", text: "Зуучлагчгүй, шударга үнэ." },
          { title: "Хурдан хүргэлт", text: "2-4 цагт гэрт тань." },
          { title: "Органик", text: "Химийн бордоогүй." },
        ] } },
        { type: "ImageText", props: { id: "it", heading: "Фермээс шууд", text: "Бид орон нутгийн фермерүүдтэй хамтран ажиллаж, хамгийн шинэхэн бүтээгдэхүүнийг таны гэрт хүргэдэг. Эрүүл хооллолт шинэхэн орцноос эхэлдэг.", image: img("fresh-story", 800, 600), imagePosition: "left", buttonText: "Захиалах", buttonHref: "#products", radius: "lg", ratio: "4/3", align: "left", btnColor: "#16a34a" } },
        testimonials("ts", "Үйлчлүүлэгчдийн сэтгэгдэл", [
          { name: "Б. Оюун", role: "", text: "Ногоо нь үнэхээр шинэхэн. Гэр бүлээрээ хэрэглэдэг." },
          { name: "Г. Болор", role: "", text: "Хүргэлт хурдан, чанар нь гайхалтай." },
          { name: "Д. Мөнх", role: "", text: "Үнэ хямд, чанар сайн. Санал болгож байна." },
        ], { cardStyle: "border" }),
        INFO_CARDS,
        { type: "Newsletter", props: { id: "nl", heading: "Долоо хоног бүрийн шинэ ургац", text: "Имэйлээ үлдээгээд шинэ бараа, хямдралын мэдээг аваарай.", buttonText: "Бүртгүүлэх", align: "center", btnColor: "#16a34a" } },
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
