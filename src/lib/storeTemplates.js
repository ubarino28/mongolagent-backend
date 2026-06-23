"use strict";

const img = (seed, w = 600, h = 600) => `https://picsum.photos/seed/${seed}/${w}/${h}`;

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
          image: img("gym-hero-power", 1400, 700), ctaText: "ДЭЛГҮҮР ҮЗЭХ", ctaHref: "#products",
          ctaColor: "#ffffff", align: "center", height: "lg", headingSize: "xl", overlay: 45
        }},

        // Ангилал — Gymshark: Men / Women / Accessories
        categories("cat", "", [
          { label: "ЭРЭГТЭЙ", image: img("gym-men", 600, 450) },
          { label: "ЭМЭГТЭЙ", image: img("gym-women", 600, 450) },
          { label: "АКСЕССУАР", image: img("gym-acc", 600, 450) },
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
          image: img("gym-brand-story", 800, 600), imagePosition: "left",
          buttonText: "ДЭЛГЭРЭНГҮЙ", buttonHref: "/about",
          radius: "md", ratio: "4/3", align: "left", btnColor: "#111111"
        }},

        // Slideshow — хоёр дахь hero section (Gymshark collection маяг)
        { type: "Slideshow", props: {
          id: "slide", height: "md", align: "center", overlay: 50, speed: 5,
          slides: [
            { image: img("gym-slide1", 1400, 600), heading: "ESSENTIAL COLLECTION", subheading: "Өдөр тутмын дасгалд зориулсан үндсэн цуглуулга.", ctaText: "ҮЗЭХ", ctaHref: "#products" },
            { image: img("gym-slide2", 1400, 600), heading: "WINTER TRAINING", subheading: "Өвлийн хүйтэнд ч халуун дасгал.", ctaText: "ХУДАЛДАЖ АВАХ", ctaHref: "#products" },
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
      { name: "Essential футболк", price: 45000, category: "Эрэгтэй", description: "Хөнгөн, амьсгалдаг материалаар хийсэн дасгалын футболк. Хөлрөхөд хурдан хатаж, тав тухтай байдлыг хадгална. Аль ч дасгалын төрөлд тохиромжтой.", images: [img("gym-tee1")] },
      { name: "Flex леггинг", price: 65000, compareAtPrice: 79000, category: "Эмэгтэй", description: "4-талт уян хатан материалтай леггинг. Иога, пилатес, фитнессд тохиромжтой. Бүсэлхийд таатай суух, ямар ч хөдөлгөөнд саадгүй.", images: [img("gym-legging1")] },
      { name: "Training хүрэм", price: 89000, category: "Эрэгтэй", description: "Дулаан fleece доторлогчтой хүрэм. Дасгалын өмнө болон дараа өмсөхөд тохиромжтой. Том халаас, тохируулагддаг малгайтай.", images: [img("gym-hoodie1")] },
      { name: "Sport шорт", price: 39000, category: "Эрэгтэй", description: "Хөнгөн, хурдан хатдаг материалтай дасгалын шорт. Дотор давхар доторлогчтой, хажуу халаастай.", images: [img("gym-shorts1")] },
      { name: "Seamless спорт шүүгээ", price: 55000, category: "Эмэгтэй", description: "Оёдолгүй загварын спорт шүүгээ. Дунд зэргийн тулгуур, тав тухтай. Дасгалд болон өдөр тутамд.", images: [img("gym-bra1")] },
      { name: "Performance футболк", price: 49000, category: "Эмэгтэй", description: "Croppped загварын дасгалын футболк. DryFit технологи, хурдан хатдаг, хөнгөн, загварлаг.", images: [img("gym-crop1")] },
      { name: "Дасгалын бээлий", price: 25000, category: "Аксессуар", description: "Эрэгтэй, эмэгтэй хоёуланд зориулсан бат бөх дасгалын бээлий. Алганд гулсалтгүй, бугуйг хамгаалах сунадаг хэсэгтэй.", images: [img("gym-gloves")] },
      { name: "Спорт цүнх", price: 69000, compareAtPrice: 85000, category: "Аксессуар", description: "42л багтаамжтай спорт цүнх. Гутлын тусгай хэсэг, нойтон хувцасны халаас, усны савны халаас. Тэсвэртэй материал.", images: [img("gym-bag1")] },
      { name: "Ус савлагч 1л", price: 18000, category: "Аксессуар", description: "1 литр багтаамжтай BPA-free ус савлагч. Нэг гараар нээгддэг, угаалгын машинд хийж болно.", images: [img("gym-bottle1")] },
      { name: "Jogger өмд", price: 75000, category: "Эрэгтэй", description: "Тав тухтай slim-fit jogger өмд. Зөөлөн French Terry материал, шагайн манжеттай, халаастай.", images: [img("gym-jogger1")] },
      { name: "Vital леггинг", price: 59000, category: "Эмэгтэй", description: "Scrunch загварын леггинг. Өндөр бүсэлхий, биеийн галбирыг онцолсон загвар. 4-талт уян материал.", images: [img("gym-vital1")] },
      { name: "Толгойн оосор", price: 12000, category: "Аксессуар", description: "Хөлрөлт шингээдэг спорт толгойн оосор. Уян хатан, аль ч толгойн хэмжээнд тохирно.", images: [img("gym-headband")] },
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
