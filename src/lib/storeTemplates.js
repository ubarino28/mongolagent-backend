"use strict";

const img = (seed, w = 600, h = 600) => `https://picsum.photos/seed/${seed}/${w}/${h}`;
const unsplash = (id, w = 600, h = 600) => `https://images.unsplash.com/photo-${id}?w=${w}&h=${h}&fit=crop&q=80`;

function aboutContent() {
  return {
    root: { props: { title: "Бидний тухай" } },
    content: [
      { type: "About", props: { id: "ab", heading: "Бидний тухай", text: "Бид чанартай бүтээгдэхүүн, найдвартай үйлчилгээг үнэ цэнэтэйгээр хүргэхийг зорьдог. Үйлчлүүлэгч бүртээ хамгийн сайн туршлагыг бэлэглэхээр ажилладаг.", align: "center", headingSize: "lg", pad: "md" } },
      { type: "Features", props: { id: "abf", heading: "Бидний давуу тал", columns: "3", gap: "md", align: "center", items: [
        { title: "Чанарын баталгаа", text: "Сонгомол, шалгасан бараа." },
        { title: "Хурдан хүргэлт", text: "Улаанбаатарт 24-48 цагт." },
        { title: "Найдвартай төлбөр", text: "QPay-ээр аюулгүй төлнө." },
      ] } },
      { type: "ContactForm", props: { id: "abc", heading: "Бидэнтэй холбогдох", text: "Асуулт, саналаа доор үлдээгээрэй. Бид удахгүй хариулна." } },
    ],
  };
}

function productTemplateContent() {
  return {
    root: { props: { title: "Барааны хуудас" } },
    content: [
      { type: "TrustBadges", props: { id: "pt-badges", align: "center", items: [
        { label: "Найдвартай төлбөр" }, { label: "Хурдан хүргэлт" }, { label: "Баталгаат бараа" }, { label: "24/7 тусламж" },
      ] } },
      { type: "Newsletter", props: { id: "pt-nl", heading: "Шинэ бараа, хямдралын мэдээ", text: "Имэйлээ үлдээгээд онцгой саналуудыг түрүүлж аваарай.", buttonText: "Бүртгүүлэх", align: "center" } },
    ],
  };
}

function homePage(content) {
  return [
    { title: "Нүүр", path: "/", type: "home", content },
    { title: "Бидний тухай", path: "/about", type: "about", content: aboutContent() },
    { title: "Захиалга хянах", path: "/track", type: "tracking", content: { root: { props: { title: "Захиалга хянах" } }, content: [] } },
    { title: "Барааны хуудас", path: "/__product", type: "product", content: productTemplateContent() },
  ];
}

function defaultExtraPages() {
  return [
    { title: "Бидний тухай", path: "/about", type: "about", content: aboutContent() },
    { title: "Захиалга хянах", path: "/track", type: "tracking", content: { root: { props: { title: "Захиалга хянах" } }, content: [] } },
    { title: "Барааны хуудас", path: "/__product", type: "product", content: productTemplateContent() },
  ];
}

const announce = (text, bgColor, txtColor) => ({ type: "Announcement", props: { id: "ann", text, bgColor, txtColor: txtColor || "#ffffff" } });
const categories = (id, heading, items, extra = {}) => ({ type: "Categories", props: { id, heading, items, columns: String(items.length > 4 ? 4 : items.length), gap: "md", radius: "lg", ratio: "4/3", overlay: 30, ...extra } });
const testimonials = (id, heading, items, extra = {}) => ({ type: "Testimonials", props: { id, heading, items, columns: "3", gap: "md", radius: "lg", cardStyle: "fill", ...extra } });

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
  // ── 1. Power — Gymshark-inspired фитнесс / спорт хувцас ──────────
  {
    id: "power",
    name: "Power",
    description: "Gymshark-аас сэдэвлэсэн спорт хувцасны дэлгүүр. Хүчирхэг, хар өнгөний загвар.",
    category: "Спорт хувцас",
    preview: "zagvar1",
    theme: { primaryColor: "#111111", bgColor: "#ffffff", textColor: "#111111", font: "Inter" },
    pages: homePage({
      root: { props: { title: "Нүүр" } },
      content: [
        announce("🔥 ШИНЭ ЦУГЛУУЛГА ИРЛЭЭ · ҮНЭГҮЙ ХҮРГЭЛТ 80,000₮+ · БУЦААЛТ 14 ХОНОГ", "#111111"),

        // Hero — Gymshark маягийн бүтэн дэлгэцийн banner
        { type: "Hero", props: {
          id: "hero", heading: "ХЯЗГААРГҮЙ БОЛОМЖ", subheading: "Чиний дасгалын хамтрагч. Чанартай спорт хувцас, Монголоос монголчуудад.",
          image: unsplash("1534438327276-14e5300c3a48", 1400, 700), ctaText: "ДЭЛГҮҮР ҮЗЭХ", ctaHref: "#products",
          ctaColor: "#ffffff", align: "center", height: "lg", headingSize: "xl", overlay: 45
        }},

        // Ангилал — Gymshark: Men / Women / Accessories
        categories("cat", "", [
          { label: "ЭРЭГТЭЙ", image: unsplash("1581009146145-b5ef050c2e1e", 600, 800) },
          { label: "ЭМЭГТЭЙ", image: unsplash("1518310383802-640c2de311b2", 600, 800) },
          { label: "АКСЕССУАР", image: unsplash("1526506118085-60ce8714f8c5", 600, 800) },
        ], { radius: "md", overlay: 40, ratio: "3/4", gap: "sm" }),

        // Шинэ бараа
        { type: "ProductGrid", props: { id: "new", heading: "ШИНЭ ИРСЭН", columns: "4", limit: 8, gap: "md", cardRadius: "sm", pad: "md" } },

        // Motivational banner
        { type: "Banner", props: {
          id: "cta1", heading: "БҮТЭЭ. ТЭМЦЭЛ. ЯЛАЛТ.", text: "Дасгал бүр чамайг хүчтэй болгоно. Зөв хувцас, зөв урам.",
          buttonText: "БҮХ БАРАА ҮЗЭХ", buttonHref: "#products",
          bgColor: "#111111", btnColor: "#ffffff", btnTextColor: "#111111",
          align: "center", headingSize: "xl", radius: "none"
        }},

        // Давуу тал — Gymshark маягаар
        { type: "Features", props: {
          id: "feat", heading: "ЯАГААД БИД ГЭЖ?", columns: "4", gap: "md", align: "center",
          iconColor: "#111111", iconFg: "#ffffff",
          items: [
            { title: "Чанартай материал", text: "4-талт уян материал, тэсвэртэй, арьсанд ээлтэй.", icon: "shield" },
            { title: "Үнэгүй хүргэлт", text: "80,000₮-с дээш захиалгад хүргэлт үнэгүй.", icon: "truck" },
            { title: "14 хоногийн буцаалт", text: "Таалагдаагүй бол 14 хоногт буцаах боломжтой.", icon: "refresh" },
            { title: "Хурдан хүргэлт", text: "Улаанбаатарт 24 цагт хүргэнэ.", icon: "zap" },
          ]
        }},

        // Тоо баримт
        { type: "Stats", props: {
          id: "stats", columns: "4", size: "lg", valueColor: "#111111",
          items: [
            { value: "25K+", label: "Идэвхтэй хэрэглэгч" },
            { value: "50K+", label: "Борлуулсан бараа" },
            { value: "4.9", label: "Дундаж үнэлгээ" },
            { value: "24/7", label: "Хэрэглэгчийн тусламж" },
          ]
        }},

        // Брэндийн түүх
        { type: "ImageText", props: {
          id: "story", heading: "БИДНИЙ ТҮҮХ", text: "Бид 2024 онд Улаанбаатарт үүсгэн байгуулагдсан. Монгол тамирчид, фитнесс сонирхогчдод зориулсан чанартай спорт хувцас бүтээх нь бидний зорилго. Дэлхийн жишигт нийцсэн материал, загвараар монгол хүмүүстээ зориулж ажилладаг.",
          image: unsplash("1571019614242-c5c5dee9f50c", 800, 600), imagePosition: "left",
          buttonText: "ДЭЛГЭРЭНГҮЙ", buttonHref: "/about",
          radius: "md", ratio: "4/3", align: "left", btnColor: "#111111"
        }},

        // Slideshow — хоёр дахь hero section (Gymshark collection маяг)
        { type: "Slideshow", props: {
          id: "slide", height: "md", align: "center", overlay: 50, speed: 5,
          slides: [
            { image: unsplash("1517836357463-d25dfeac3438", 1400, 600), heading: "ESSENTIAL COLLECTION", subheading: "Өдөр тутмын дасгалд зориулсан үндсэн цуглуулга.", ctaText: "ҮЗЭХ", ctaHref: "#products" },
            { image: unsplash("1549060279-7e168fcee0c2", 1400, 600), heading: "WINTER TRAINING", subheading: "Өвлийн хүйтэнд ч халуун дасгал.", ctaText: "ХУДАЛДАЖ АВАХ", ctaHref: "#products" },
          ]
        }},

        // Сэтгэгдэл
        testimonials("test", "ХЭРЭГЛЭГЧДИЙН СЭТГЭГДЭЛ", [
          { name: "Б. Тэмүүжин", role: "Фитнесс тренер", text: "Чанар нь үнэхээр гайхалтай. Дасгалын үед тав тухтай, хөлрөхөд ч хурдан хатдаг. Тренерүүддээ санал болгодог." },
          { name: "М. Сарантуяа", role: "Иога багш", text: "Леггинг нь маш уян хатан, ямар ч хөдөлгөөнд саадгүй. Дахин дахин захиалдаг." },
          { name: "Д. Ганбат", role: "Бодибилдер", text: "Футболк нь биед сайн таарч, дасгалын үед чөлөөтэй хөдөлнө. Материал нь бат бөх." },
        ], { cardStyle: "shadow" }),

        INFO_CARDS,

        // Newsletter
        { type: "Newsletter", props: {
          id: "nl", heading: "ШИНЭ ЦУГЛУУЛГА, ХЯМДРАЛААС ХАМГИЙН ТҮРҮҮНД МЭДЭЖ АВ",
          text: "Имэйлээ бүртгүүлээд 10% хямдрал, шинэ бараагаа хамгийн түрүүнд аваарай.",
          buttonText: "БҮРТГҮҮЛЭХ", align: "center", btnColor: "#111111"
        }},

        // Footer
        { type: "Footer", props: { id: "f", text: "© 2026 Power — Бүх эрх хуулиар хамгаалагдсан" } },
      ],
    }),
    demoProducts: [
      { name: "Essential футболк", price: 45000, category: "Эрэгтэй", description: "Хөнгөн, амьсгалдаг материалаар хийсэн дасгалын футболк. Хөлрөхөд хурдан хатаж, тав тухтай байдлыг хадгална.", images: [unsplash("1521572163474-6864f9cf17ab", 600, 800)] },
      { name: "Flex леггинг", price: 65000, compareAtPrice: 79000, category: "Эмэгтэй", description: "4-талт уян хатан материалтай леггинг. Иога, пилатес, фитнессд тохиромжтой.", images: [unsplash("1506629082955-511b1aa562c8", 600, 800)] },
      { name: "Training хүрэм", price: 89000, category: "Эрэгтэй", description: "Дулаан fleece доторлогчтой хүрэм. Дасгалын өмнө болон дараа өмсөхөд тохиромжтой.", images: [unsplash("1556906781-9a412961c28c", 600, 800)] },
      { name: "Sport шорт", price: 39000, category: "Эрэгтэй", description: "Хөнгөн, хурдан хатдаг материалтай дасгалын шорт.", images: [unsplash("1562157873-818bc0726f68", 600, 800)] },
      { name: "Seamless спорт шүүгээ", price: 55000, category: "Эмэгтэй", description: "Оёдолгүй загварын спорт шүүгээ. Дунд зэргийн тулгуур, тав тухтай.", images: [unsplash("1571731956672-f2b94d7dd0d6", 600, 800)] },
      { name: "Performance футболк", price: 49000, category: "Эмэгтэй", description: "Cropped загварын дасгалын футболк. DryFit технологи.", images: [unsplash("1515775538093-d82e3bfdbfc1", 600, 800)] },
      { name: "Дасгалын бээлий", price: 25000, category: "Аксессуар", description: "Бат бөх дасгалын бээлий. Алганд гулсалтгүй.", images: [unsplash("1583454110551-21f2fa2afe61", 600, 800)] },
      { name: "Спорт цүнх", price: 69000, compareAtPrice: 85000, category: "Аксессуар", description: "42л багтаамжтай спорт цүнх. Гутлын тусгай хэсэгтэй.", images: [unsplash("1553062407-98d43420e9e7", 600, 800)] },
      { name: "Ус савлагч 1л", price: 18000, category: "Аксессуар", description: "1 литр BPA-free ус савлагч.", images: [unsplash("1523362628745-0c100150b504", 600, 800)] },
      { name: "Jogger өмд", price: 75000, category: "Эрэгтэй", description: "Тав тухтай slim-fit jogger өмд. Зөөлөн French Terry материал.", images: [unsplash("1552374196-1ab2a1c593e8", 600, 800)] },
      { name: "Vital леггинг", price: 59000, category: "Эмэгтэй", description: "Scrunch загварын леггинг. Өндөр бүсэлхий.", images: [unsplash("1540497077202-7c8a3999166f", 600, 800)] },
      { name: "Толгойн оосор", price: 12000, category: "Аксессуар", description: "Хөлрөлт шингээдэг спорт толгойн оосор.", images: [unsplash("1517344884509-a0c97ec11bcc", 600, 800)] },
    ],
  },
];

function listTemplates() {
  return TEMPLATES.map(({ id, name, description, category, theme, preview }) => ({ id, name, description, category, theme, preview }));
}

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

module.exports = { TEMPLATES, listTemplates, getTemplate, defaultExtraPages };
