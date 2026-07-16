"use strict";
// Монгол хэлэнд тохирсон хайлтын туслах — substring-ийн оронд ҮНДСЭЭР тулгана.
// Дагавар тайрах (stemming) + гээгдэх эгшиг + синоним + fuzzy (typo).
// Гадаад үйлчилгээ/DB шаардахгүй, цэвэр JS.

// Түгээмэл синоним/ярианы хэлбэр → канон үг. Цаг хугацаанд гараар өргөтгөнө.
const SYNONYMS = {
  "пүүз": "гутал", "пүүзэн": "гутал", "пүүзнүүд": "гутал",
  "гутик": "гутал", "гуталчин": "гутал",
  "дугаар": "утас", "дугаараа": "утас",
  "хямдхан": "хямд", "хямдрал": "хямд", "хямдруулах": "хямд", "хөнгөлөлт": "хямд", "хямдралтай": "хямд",
  "ханш": "үнэ", "прайс": "үнэ", "өртөг": "үнэ",
  "онгойдог": "цаг", "онгойно": "цаг", "хаадаг": "цаг", "цагаар": "цаг",
  "солилт": "буцаалт", "солих": "буцаалт", "буцаах": "буцаалт", "буцааж": "буцаалт",
  "хүргэдэг": "хүргэлт", "хүргэнэ": "хүргэлт", "хүргэж": "хүргэлт", "хүргүүлэх": "хүргэлт", "хүргэ": "хүргэлт",
  "хүргүүлье": "хүргэлт", "delivery": "хүргэлт",
  "захиалмаар": "захиалга", "захиалах": "захиалга", "захиалъя": "захиалга", "order": "захиалга", "бук": "захиалга",
  // Байршил/хаяг — өөр язгуултай тул fuzzy барихгүй, зөвхөн энэ толь холбоно
  "байршил": "хаяг", "байрлал": "хаяг", "location": "хаяг", "address": "хаяг", "хаана": "хаяг",
  // Ажлын цаг — нээх/хаах ярианы хэлбэр
  "нээлттэй": "цаг", "хаалттай": "цаг", "амардаг": "цаг",
  // Бусад канон руу (утас/үнэ/хямд/буцаалт)
  "phone": "утас", "телефон": "утас", "тариф": "үнэ", "sale": "хямд", "return": "буцаалт",
};

// Дагаврын жагсаалт — УРТ→БОГИНО (эхлээд урт нь таарч тайрагдана)
const SUFFIXES = [
  "уудаас", "үүдээс", "нуудын", "нүүдийн", "ийнхээ", "ынхаа",
  "аас", "ээс", "оос", "өөс", "ийг", "ыг", "ийн", "ын", "ны", "ний",
  "аар", "ээр", "оор", "өөр", "тай", "тэй", "той", "руу", "рүү", "луу", "лүү",
  "ууд", "үүд", "нууд", "нүүд", "нар", "нэр", "чууд", "чүүд",
  "даг", "дэг", "дог", "дөг", "сан", "сэн", "сон", "сөн", "лаа", "лээ", "лоо", "лөө",
  "маар", "мээр", "моор", "мөөр",
  "аа", "ээ", "оо", "өө", "ий", "ы",
];

const VOWELS = "аэоөуүяеёиый";
const CONS = "бвгджзйклмнпрстфхцчшщ";
const FLEETING = new RegExp(`([${CONS}])[${VOWELS}]([${CONS}])$`);

// Гээгдэх эгшиг: CvC$ → CC$  (гутАл → гутл, ижилсэнэ гутлын-тай)
function collapse(w) {
  if (w.length < 4) return w;
  return w.replace(FLEETING, "$1$2");
}

// Нэг дагавар тайрч, гээгдэх эгшгийг цуглуулна. Үндэс ≥3 үсэг байх ёстой.
function stem(w) {
  let x = w;
  for (const s of SUFFIXES) {
    if (x.length - s.length >= 3 && x.endsWith(s)) { x = x.slice(0, x.length - s.length); break; }
  }
  return collapse(x);
}

function normalize(s) {
  return (s || "").toLowerCase().trim().replace(/[?!。？！.,;:/]/g, " ").replace(/\s+/g, " ").trim();
}

// Текстийг: normalize → үг хуваах → синоним буулгах → үндэслэх
function normalizeMongol(s) {
  return normalize(s).split(" ")
    .filter((w) => w.length > 1)
    .map((w) => SYNONYMS[w] || w)
    .map(stem)
    .filter((w) => w.length > 0);
}

// Levenshtein зай (typo тэсвэрлэхэд)
function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 1) return 2; // 1-ээс их зөрвөл шууд таслах (хурд)
  const d = Array.from({ length: m + 1 }, (_, i) => { const r = new Array(n + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// 2 үндэс таарах эсэх: тэнцүү / prefix(≥3) / fuzzy(≥5 үсэгт ≤1 зөрүү)
function wordMatch(q, k) {
  if (q === k) return true;
  const short = Math.min(q.length, k.length);
  if (short >= 3 && (q.startsWith(k) || k.startsWith(q))) return true;
  if (short >= 5 && lev(q, k) <= 1) return true;
  return false;
}

// query үндсүүд KB үндсүүдтэй хэдэн таарсан бэ (score)
function overlapScore(qWords, kbWords) {
  let score = 0;
  for (const q of qWords) if (kbWords.some((k) => wordMatch(q, k))) score++;
  return score;
}

module.exports = { stem, normalize, normalizeMongol, wordMatch, overlapScore, SYNONYMS, SUFFIXES };
