"use strict";
// JWT нууц түлхүүр. Тохируулаагүй бол МЭДЭГДЭХҮЙЦ алдаа шиднэ —
// hardcode fallback ашиглахгүй (хэн ч token хуурамчаар үүсгэхээс сэргийлнэ).
function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error("JWT_SECRET тохируулаагүй эсвэл хэт богино байна (>=16 тэмдэгт шаардлагатай)");
  }
  return s;
}

module.exports = { jwtSecret };
