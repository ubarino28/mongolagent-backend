"use strict";
const OpenAI = require("openai");

let _openai;
function openai() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// AI-д зөвшөөрөгдсөн блокууд + ямар талбар бөглөж болох (бусад нь default авна).
// Энэ allowlist нь editor эвдрэхээс хамгаалж, AI-ийн гаргацыг хатуу баталгаажуулна.
const ICONS = ["truck", "shield", "card", "star", "gift", "clock", "heart", "tag", "zap", "award", "phone", "mail", "leaf"];
const ALLOWED = {
  Hero: ["heading", "subheading", "ctaText"],
  Banner: ["heading", "text", "buttonText"],
  CTA: ["heading", "text", "buttonText"],
  About: ["heading", "text"],
  Newsletter: ["heading", "text", "buttonText"],
  ImageText: ["heading", "text", "imagePosition", "buttonText"],
  Features: ["heading", "items"], // items: {title,text,icon}
  Stats: ["items"],                // items: {value,label}
  Testimonials: ["heading", "items"], // items: {name,role,text,rating}
  FAQ: ["heading", "items"],       // items: {question,answer}
};
const ITEM_FIELDS = {
  Features: ["title", "text", "icon"],
  Stats: ["value", "label"],
  Testimonials: ["name", "role", "text", "rating"],
  FAQ: ["question", "answer"],
};

function clampStr(v, n) { return v == null ? undefined : String(v).slice(0, n); }

function sanitizeBlock(b) {
  if (!b || typeof b !== "object") return null;
  const type = b.type;
  if (!ALLOWED[type]) return null;
  const allowed = ALLOWED[type];
  const src = b.props && typeof b.props === "object" ? b.props : b;
  const props = {};
  for (const key of allowed) {
    if (key === "items") {
      if (!Array.isArray(src.items)) continue;
      const fields = ITEM_FIELDS[type] || [];
      props.items = src.items.slice(0, 8).map((it) => {
        const o = {};
        for (const f of fields) {
          let v = it?.[f];
          if (f === "icon") v = ICONS.includes(v) ? v : "star";
          else if (f === "rating") v = String(Math.max(0, Math.min(5, parseInt(v, 10) || 5)));
          else v = clampStr(v, 400);
          if (v !== undefined) o[f] = v;
        }
        return o;
      }).filter((o) => Object.keys(o).length);
    } else if (key === "imagePosition") {
      props.imagePosition = src.imagePosition === "right" ? "right" : "left";
    } else {
      const v = clampStr(src[key], 600);
      if (v) props[key] = v;
    }
  }
  return { type, props };
}

async function generateSections(prompt) {
  if (!process.env.OPENAI_API_KEY) throw new Error("AI үйлчилгээ идэвхгүй байна");
  const sys = `Чи бол Монгол онлайн дэлгүүрийн вэб дизайны туслах. Хэрэглэгчийн бизнесийн тайлбараас дэлгүүрийн нүүр хуудасны хэсгүүдийг (section) үүсгэнэ.
Зөвхөн дараах төрлүүдийг ашиглана: Hero, Banner, CTA, ImageText, Features, Stats, Testimonials, FAQ, Newsletter, About.
Талбарууд:
- Hero: { heading, subheading, ctaText }
- Banner: { heading, text, buttonText }
- CTA: { heading, text, buttonText }
- ImageText: { heading, text, imagePosition("left"|"right"), buttonText }
- About: { heading, text }
- Newsletter: { heading, text, buttonText }
- Features: { heading, items:[{ title, text, icon }] }  icon нь зөвхөн: ${ICONS.join(", ")}
- Stats: { items:[{ value, label }] }
- Testimonials: { heading, items:[{ name, role, text, rating("1".."5") }] }
- FAQ: { heading, items:[{ question, answer }] }
Бүх текст МОНГОЛ хэлээр, тухайн бизнест тохирсон, жинхэнэ дуудлагатай байх. 4-6 хэсэг үүсгэ (эхэнд Hero). Зөвхөн JSON буцаа: { "blocks": [ { "type": "...", "props": { ... } } ] }`;

  const res = await openai().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    max_tokens: 1800,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: String(prompt || "").slice(0, 800) },
    ],
  });

  let parsed;
  try { parsed = JSON.parse(res.choices[0].message.content || "{}"); } catch { parsed = {}; }
  const raw = Array.isArray(parsed.blocks) ? parsed.blocks : [];
  const blocks = raw.map(sanitizeBlock).filter(Boolean).slice(0, 8);
  if (!blocks.length) throw new Error("AI хэсэг үүсгэж чадсангүй. Дахин оролдоно уу.");
  return blocks;
}

module.exports = { generateSections };
