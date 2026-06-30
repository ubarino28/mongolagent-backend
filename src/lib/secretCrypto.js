"use strict";
// Эмзэг талбарын (fbPageToken, telegramBotToken, qpay данс г.м) at-rest шифрлэлт.
// AES-256-GCM. ENCRYPTION_KEY (32 байт, hex эсвэл base64) env тохируулсан үед л идэвхжинэ —
// эс бол NO-OP (одоогийн зан хадгална, юу ч эвдэхгүй).
//
// Урагшлах нийцтэй байдал: decrypt нь "enc:v1:" угтвартай утгыг л тайлна; угтваргүй (хуучин
// plaintext) утгыг хэвээр буцаана. Тиймээс хэсэгчлэн шифрлэгдсэн өгөгдөл ажиллана.
const crypto = require("crypto");

const PREFIX = "enc:v1:";

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  let buf;
  try { buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64"); }
  catch { return null; }
  return buf.length === 32 ? buf : null;
}

function isEnabled() { return !!getKey(); }

function encrypt(plain) {
  const key = getKey();
  if (!key || plain == null || typeof plain !== "string" || plain.startsWith(PREFIX)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

function decrypt(value) {
  if (value == null || typeof value !== "string" || !value.startsWith(PREFIX)) return value; // plaintext legacy
  const key = getKey();
  if (!key) return value; // түлхүүргүй бол тайлж чадахгүй — байгаагаар нь буцаана
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch { return value; }
}

module.exports = { encrypt, decrypt, isEnabled, PREFIX };
