"use strict";
// Бүтээгдэхүүний ангилал бүрийн ҮЗҮҮЛЭЛТИЙН загвар (category attribute templates).
// Бараа нэмэхэд тухайн ангилалын үзүүлэлтийн талбарууд гарч ирнэ (Чадал, Камер, Материал г.м).
// Размер/Өнгө нь variant (нөөцтэй) тул энд ОРУУЛАХГҮЙ — энэ нь бүтээгдэхүүний ЕРӨНХИЙ спец.
//
// Загвар: { "<ангилал>": [{ key, unit?, eg? }] }.
//   key = үзүүлэлтийн нэр, unit = нэгж (нэмэлт), eg = бодит жишээ утга (placeholder-д харагдана).
// Org өөрийн загвараа TuruuSettings-д хадгалж болно; байхгүй бол доорх анхдагчийг ашиглана.

const DEFAULT_CATEGORY_ATTRIBUTES = {
  "Гутал":            [{ key: "Материал", eg: "Жинхэнэ арьс" }, { key: "Улирал", eg: "Дөрвөн улирал" }],
  "Цамц":             [{ key: "Материал", eg: "100% хөвөн" }, { key: "Ханцуй", eg: "Богино" }],
  "Хувцас":           [{ key: "Материал", eg: "Хөвөн" }],
  "Өмд":              [{ key: "Материал", eg: "Жинс" }, { key: "Тайрдас", eg: "Slim fit" }],
  "Хүрэм":            [{ key: "Материал", eg: "Нейлон" }, { key: "Дулаалга", eg: "Хөвөн" }, { key: "Улирал", eg: "Өвөл" }],
  "Цүнх":             [{ key: "Материал", eg: "Арьс" }, { key: "Хэмжээ", eg: "30×20×12 см" }],
  "Малгай":           [{ key: "Материал", eg: "Ноос" }],
  "Цахилгаан бараа":  [{ key: "Чадал", unit: "W", eg: "2000" }, { key: "Хүчдэл", unit: "V", eg: "220" }, { key: "Баталгаат хугацаа", eg: "1 жил" }],
  "Гар утас":         [{ key: "Багтаамж", unit: "GB", eg: "128" }, { key: "RAM", unit: "GB", eg: "8" }, { key: "Дэлгэц", unit: "″", eg: "6.5" }, { key: "Камер", unit: "MP", eg: "48" }, { key: "Батерей", unit: "mAh", eg: "5000" }],
  "Компьютер":        [{ key: "Процессор", eg: "Intel Core i5" }, { key: "RAM", unit: "GB", eg: "16" }, { key: "Багтаамж", unit: "GB", eg: "512" }, { key: "Дэлгэц", unit: "″", eg: "15.6" }, { key: "Видео карт", eg: "RTX 3050" }],
  "Цаг":              [{ key: "Материал", eg: "Ган" }, { key: "Механизм", eg: "Кварц" }, { key: "Ус тэсвэрлэлт", eg: "50 м" }],
  "Гэр ахуй":         [{ key: "Материал", eg: "Шаазан" }, { key: "Хэмжээ", eg: "25 см" }],
  "Тавилга":          [{ key: "Материал", eg: "Модон" }, { key: "Хэмжээ", eg: "120×60×75 см" }],
  "Гоо сайхан":       [{ key: "Багтаамж", unit: "мл", eg: "50" }, { key: "Арьсны төрөл", eg: "Бүх төрөл" }, { key: "Найрлага", eg: "Гиалурон хүчил" }],
  "Хүнс":             [{ key: "Жин", unit: "г", eg: "500" }, { key: "Хадгалах хугацаа", eg: "6 сар" }, { key: "Гарал үүсэл", eg: "Монгол" }],
};

// Нэг ангилалын үзүүлэлтийн загварыг ол — org-ийн хадгалсан загвар давуу эрхтэй, дараа нь анхдагч.
// Үсгийн жижиг/томд үл харгалзан таарна ("цахилгаан бараа" = "Цахилгаан бараа").
function templateFor(category, orgTemplates = {}) {
  if (!category) return [];
  const sub = category.includes(" / ") ? category.split(" / ")[1]?.trim() : category.trim();
  if (!sub) return [];
  const all = mergedTemplates(orgTemplates);
  const key = Object.keys(all).find((k) => k.toLowerCase() === sub.toLowerCase());
  return key ? all[key] : [];
}

// Org-ийн бүх (хадгалсан + анхдагч) загварыг нэгтгэж буцаана (frontend-д харуулах).
function mergedTemplates(orgTemplates = {}) {
  const out = { ...DEFAULT_CATEGORY_ATTRIBUTES };
  for (const [k, v] of Object.entries(orgTemplates || {})) {
    if (Array.isArray(v)) out[k] = v; // org өөрчилсөн бол дарна
  }
  return out;
}

module.exports = { DEFAULT_CATEGORY_ATTRIBUTES, templateFor, mergedTemplates };
