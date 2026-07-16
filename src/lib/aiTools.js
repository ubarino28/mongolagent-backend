"use strict";
// AI tool тодорхойлолтуудын ЦОРЫН ГАНЦ эх сурвалж.
// Өмнө нь Messenger (ai.service.js) болон тест-чат (client.routes.js) хоёр ижил tool
// JSON-уудыг ТУС ТУСДАА бичдэг байсан → tool нэмэх/схем засах бүрд 2 газар засах шаардлагатай,
// нэгийг нь мартвал 2 гадаргуугийн зан төлөв зөрдөг байсан. Эндээс дундаас нь татна.
// (Search-ийн ДОТООД логик 2 гадаргуунд өөр хэвээр — Messenger vision-д variantImages,
//  тест-чат нэг хариу зураг өгдөг тул зориуд салгасан.)

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "Хэрэглэгчийн асуултад хамаарах мэдээллийг мэдлэгийн сангаас хайна. Бүтээгдэхүүн, үнэ, хүргэлт, буцаалт, ажлын цаг болон компанийн мэдээлэл авахад ашиглана.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Хайх үгс — монгол хэлээр, тодорхой" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_lead",
      description: "Хэрэглэгч үйлчилгээ сонирхоход нэр, холбоо барих мэдээлэл хадгална.",
      parameters: {
        type: "object",
        properties: {
          name:            { type: "string" },
          phone:           { type: "string" },
          email:           { type: "string" },
          company:         { type: "string" },
          serviceInterest: { type: "string" },
          budget:          { type: "string" },
          notes:           { type: "string" },
        },
        required: ["phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_consultation",
      description: "Хэрэглэгч consultation цаг захиалахыг хүсэхэд дуудна.",
      parameters: {
        type: "object",
        properties: {
          name:            { type: "string" },
          phone:           { type: "string" },
          email:           { type: "string" },
          serviceInterest: { type: "string" },
          preferredTime:   { type: "string" },
        },
        required: ["phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_order",
      description: "Хэрэглэгч захиалгаа баталгаажуулж нэр, утас, хаяг өгсний дараа дуудна. ЧУХАЛ: бараа нь өнгө/размер-тэй (variant) бол заавал хэрэглэгчийн СОНГОСОН өнгө болон размерийг тодруулсны дараа л дуудна — мэдэхгүй байхад дуудаж болохгүй.",
      parameters: {
        type: "object",
        properties: {
          customerName:    { type: "string" },
          customerPhone:   { type: "string" },
          customerEmail:   { type: "string" },
          deliveryAddress: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name:  { type: "string", description: "Барааны нэр" },
                color: { type: "string", description: "Сонгосон өнгө (variant байвал заавал)" },
                size:  { type: "string", description: "Сонгосон размер (variant байвал заавал)" },
                qty:   { type: "number" },
                price: { type: "number" },
              },
              required: ["name", "qty", "price"],
            },
          },
          totalAmount: { type: "number" },
          notes:       { type: "string" },
          payOnPickup: { type: "boolean", description: "Хэрэглэгч очиж авахдаа (дэлгүүр дээр) төлбөрөө төлнө гэвэл true. Энэ тохиолдолд QPay холбоос үүсгэхгүй." },
        },
        required: ["customerName", "customerPhone", "items", "totalAmount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flag_unanswered",
      description: "Хэрэглэгчийн асуултад мэдлэгийн санд хариулт байхгүй бол энэ tool-ийг ЭХЛЭЭД дуудна, дараа нь contact fallback хариулт өг.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Хариулагдаагүй хэрэглэгчийн асуулт" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_handoff",
      description: "Хэрэглэгч хүнтэй ярихыг хүсвэл эсвэл AI шийдэж чадахгүй нөхцөл үүсвэл дуудна.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Handoff хүссэн шалтгаан" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_staff",
      description: "Байгаа мастеруудын жагсаалтыг авна — нэр, үйлчилгээ, ажлын цаг. Цаг захиалах яриа эхлэхэд эхлээд дуудна.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Тухайн мастерын тодорхой өдрийн боломжит цагуудыг авна. staffId болон date YYYY-MM-DD форматаар заавал дамжуулна. Хэрэглэгч тодорхой цаг хүссэн бол timeSlot-д HH:MM (24цаг) хэлбэрээр дамжуул — result-ийн requestedAvailable нь тэр цаг чөлөөтэй эсэхийг ХЭЛНЭ.",
      parameters: {
        type: "object",
        properties: {
          staffId:     { type: "string", description: "Мастерын ID (check_staff-с авна)" },
          date:        { type: "string", description: "Огноо YYYY-MM-DD форматаар" },
          serviceName: { type: "string", description: "Үйлчилгээний нэр (байвал тэрнийх duration ашиглана)" },
          timeSlot:    { type: "string", description: "Хэрэглэгчийн хүссэн цаг HH:MM (24цаг). Жишээ: '2 цагт'→'14:00'. Байвал requestedAvailable буцаана." },
        },
        required: ["staffId", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_appointment",
      description: "Хэрэглэгч цаг захиалгаа баталгаажуулсны дараа хадгалах. customerName болон customerPhone ЗААВАЛ авсан байна.",
      parameters: {
        type: "object",
        properties: {
          staffId:         { type: "string" },
          staffName:       { type: "string" },
          serviceName:     { type: "string" },
          durationMinutes: { type: "number" },
          date:            { type: "string", description: "YYYY-MM-DD" },
          timeSlot:        { type: "string", description: "HH:MM" },
          customerName:    { type: "string" },
          customerPhone:   { type: "string" },
          depositAmount:   { type: "number" },
          notes:           { type: "string" },
        },
        required: ["staffId", "serviceName", "durationMinutes", "date", "timeSlot", "customerName", "customerPhone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_appointment",
      description: "Хэрэглэгч цаг захиалгаа өөрчлөх/шилжүүлэх хүсвэл дуудна. Хуучин цагийг шинэ цаг руу шилжүүлнэ.",
      parameters: {
        type: "object",
        properties: {
          phone:      { type: "string", description: "Хэрэглэгчийн утасны дугаар" },
          oldDate:    { type: "string", description: "Хуучин огноо YYYY-MM-DD" },
          oldTime:    { type: "string", description: "Хуучин цаг HH:MM" },
          newDate:    { type: "string", description: "Шинэ огноо YYYY-MM-DD" },
          newTime:    { type: "string", description: "Шинэ цаг HH:MM" },
        },
        required: ["phone", "newDate", "newTime"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_order",
      description: "Хэрэглэгчийн захиалгын статус шалгах. Утасны дугаараар хайна. Утас өгөөгүй бол одоогийн чатын хэрэглэгчийн сүүлийн захиалгыг шалгана.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "Хэрэглэгчийн утасны дугаар" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_payment",
      description: "Хэрэглэгч 'төлчлөө', 'явуулчлаа', 'шилжүүлсэн' гэх мэт төлбөр хийснээ мэдэгдсэн үед дуудна. Захиалгын статусыг PAYMENT_SENT болгож эзэнд мэдэгдэл явуулна.",
      parameters: {
        type: "object",
        properties: {
          notes: { type: "string", description: "Хэрэглэгчийн нэмэлт тайлбар (байвал)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_menu",
      description: "Бараа/бүтээгдэхүүний жагсаалтыг авна. Хэрэглэгч ТОДОРХОЙ ТӨРӨЛ/АНГИЛАЛ асуувал (жишээ: 'гутал юу байна', 'пүүз байгаа юу', 'цамц харах', 'малгай юу байна') тэр төрлийн нэрийг `category`-д ЗААВАЛ дамжуул (ярианы үг бол каноноор: 'пүүз'→'гутал') — зөвхөн тэр ангилал буцна, token ихээхэн хэмнэнэ. Зөвхөн ЕРӨНХИЙ ('юу зардаг вэ', 'бүх бараагаа харуул') үед л category-г ХООСОН орхи.",
      parameters: { type: "object", properties: { category: { type: "string", description: "Тодорхой ангилал (жишээ: 'гутал', 'цамц'). Ерөнхий асуулт бол хоосон." } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_tables",
      description: "Ресторанын сул ширээ шалгана. date, time, guests дамжуулна.",
      parameters: {
        type: "object",
        properties: {
          date:   { type: "string", description: "YYYY-MM-DD" },
          time:   { type: "string", description: "HH:MM" },
          guests: { type: "number", description: "Хэдэн хүн" },
        },
        required: ["date", "time", "guests"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_reservation",
      description: "Ширээ захиалга хадгалах. customerName, customerPhone ЗААВАЛ авсан байна.",
      parameters: {
        type: "object",
        properties: {
          tableId:       { type: "string" },
          date:          { type: "string", description: "YYYY-MM-DD" },
          timeSlot:      { type: "string", description: "HH:MM" },
          guestCount:    { type: "number" },
          customerName:  { type: "string" },
          customerPhone: { type: "string" },
          notes:         { type: "string" },
        },
        required: ["tableId", "date", "timeSlot", "guestCount", "customerName", "customerPhone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_reservation",
      description: "Ширээ захиалга цуцлах. Утасны дугаараар хайж CANCELLED болгоно. Тухайн ширээ/цаг автоматаар чөлөөтэй болно.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "Хэрэглэгчийн утасны дугаар" },
          date:  { type: "string", description: "Захиалсан огноо YYYY-MM-DD (байвал)" },
        },
        required: ["phone"],
      },
    },
  },
];

// Tool-г нэрээр нь хурдан олох индекс (pickTools-д ашиглана)
const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.function.name, t]));

// Дурын нэрсийн жагсаалтаар tool-уудыг сонгож авна (тест-чат subset угсрахад).
// TOOLS дэх ДАРААЛЛААР буцаана (тогтвортой), олдоогүй нэрийг чимээгүй алгасна.
function pickTools(names) {
  const want = new Set(names);
  return TOOLS.filter((t) => want.has(t.function.name));
}

// ── Tool-ийг бизнес төрлөөр шүүх — тухайн төрөлд ХЭРЭГГҮЙ tool-уудыг илгээхгүй (токен хэмнэнэ) ──
// Зөвхөн ТОДОРХОЙ (order/appointment/table урсгал нь мэдэгдэж буй) төрлүүдийг шүүнэ.
// "other"/тодорхойгүй төрөл → бүх tool (аюулгүй тал, ямар ч урсгалыг дэмжинэ).
const TOOL_ALWAYS = ["search_knowledge", "save_lead", "save_consultation", "flag_unanswered", "request_handoff"];
const TOOLS_BY_TYPE = {
  shop:       [...TOOL_ALWAYS, "check_menu", "save_order", "check_order", "confirm_payment"],
  restaurant: [...TOOL_ALWAYS, "check_menu", "save_order", "check_order", "confirm_payment", "check_tables", "save_reservation", "cancel_reservation"],
  salon:      [...TOOL_ALWAYS, "check_staff", "check_availability", "save_appointment", "reschedule_appointment"],
  clinic:     [...TOOL_ALWAYS, "check_staff", "check_availability", "save_appointment", "reschedule_appointment"],
  service:    [...TOOL_ALWAYS, "check_staff", "check_availability", "save_appointment", "reschedule_appointment"],
};
function toolsForType(businessType) {
  const names = TOOLS_BY_TYPE[businessType];
  return names ? TOOLS.filter((t) => names.includes(t.function.name)) : TOOLS;
}

// Growth+ багцаас нээгддэг tool-ууд (Захиалга/QPay, Цаг захиалга, Хүн handoff).
// Starter багцад эдгээрийг activeTools-оос хасна — AI дуудаж чадахгүй болно.
const GROWTH_ONLY_TOOLS = new Set([
  "save_order", "check_order", "confirm_payment",
  "save_appointment", "reschedule_appointment", "check_availability", "check_staff",
  "save_reservation", "cancel_reservation", "check_tables",
  "request_handoff",
]);

module.exports = { TOOLS, TOOLS_BY_NAME, pickTools, TOOL_ALWAYS, TOOLS_BY_TYPE, toolsForType, GROWTH_ONLY_TOOLS };
