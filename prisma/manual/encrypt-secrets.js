"use strict";
// Нэг удаагийн migration — Organization-ийн эмзэг талбаруудыг at-rest шифрлэнэ.
// ⚠️ Эхлээд ENCRYPTION_KEY env тохируулсан байх ёстой (32 байт hex/base64).
// ⚠️ STAGING дээр эхэлж туршина. Ажиллуулах: node prisma/manual/encrypt-secrets.js
//
// Идемпотент: аль хэдийн шифрлэгдсэн (enc:v1: угтвартай) утгыг алгасна.
// Энэ нь зөвхөн ӨГӨГДЛИЙГ шифрлэнэ. Кодын уншилтын зам бүрт decrypt холбосон байх ёстой
//  require("../lib/secretCrypto").decrypt(...)-ийг нэмнэ). Холболтыг хийгээгүй бол БҮҮ ажиллуул.

require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { encrypt, isEnabled, PREFIX } = require("../../src/lib/secretCrypto");

const FIELDS = ["fbPageToken", "qpayMerchantId", "qpayAccountNumber", "qpayAccountName"];

(async () => {
  if (!isEnabled()) { console.error("ENCRYPTION_KEY тохируулаагүй — зогсоов."); process.exit(1); }
  const prisma = new PrismaClient();
  const orgs = await prisma.organization.findMany({ select: { id: true, ...Object.fromEntries(FIELDS.map((f) => [f, true])) } });
  let changed = 0;
  for (const org of orgs) {
    const data = {};
    for (const f of FIELDS) {
      const v = org[f];
      if (typeof v === "string" && v && !v.startsWith(PREFIX)) data[f] = encrypt(v);
    }
    if (Object.keys(data).length) { await prisma.organization.update({ where: { id: org.id }, data }); changed++; }
  }
  console.log(`[encrypt-secrets] ${changed}/${orgs.length} organization шифрлэгдлээ`);
  await prisma.$disconnect();
})();
