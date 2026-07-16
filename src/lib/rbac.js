"use strict";
// Эрхийн дүрэм — ЦОРЫН ГАНЦ эх сурвалж (цэвэр функц тул CI-д тестлэгдэнэ).
// Ажилтны token-д role: "staff" | "viewer" явдаг. Эзний token-д role байхгүй эсвэл "owner".
// ЧУХАЛ: role тодорхойгүй бол "owner" гэж үзнэ — хуучин (role-гүй) эзний token-ууд
// хөндөгдөхгүйн тулд. Ажилтны token-ыг ЗӨВХӨН signStaffToken үүсгэдэг тул role заавал явна.

const ROLES = ["owner", "staff", "viewer"];

// req/token payload-оос эрхийг найдвартай гаргаж авна
function roleOf(reqOrOrg) {
  const r = reqOrOrg?.org?.role ?? reqOrOrg?.role;
  return ROLES.includes(r) ? r : "owner";
}

const isOwner = (role) => roleOf({ role }) === "owner";

// "viewer" зөвхөн харна — бичих (GET биш) үйлдлийг блоклоно
function canWrite(role, method) {
  return !(String(method || "").toUpperCase() !== "GET" && roleOf({ role }) === "viewer");
}

// ─── Express middleware ─────────────────────────────────────────────────────
// Зөвхөн эзэмшигч — мөнгө, бүртгэлийн мэдээлэл, гадаад холболт, багийн удирдлагад
function requireOwner(req, res, next) {
  if (!isOwner(roleOf(req))) return res.status(403).json({ error: "Зөвхөн эзэмшигчид зөвшөөрөгдөнө" });
  next();
}

// viewer-ийн бичих оролдлогыг блоклоно
function blockViewerWrites(req, res, next) {
  if (!canWrite(roleOf(req), req.method)) return res.status(403).json({ error: "Танд зөвхөн харах эрх байна" });
  next();
}

module.exports = { ROLES, roleOf, isOwner, canWrite, requireOwner, blockViewerWrites };
