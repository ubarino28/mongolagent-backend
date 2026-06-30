"use strict";
const { PrismaClient } = require("@prisma/client");

let prisma;

// Connection pool-ийг хязгаарлана — олон зэрэг хүсэлт дээр Supabase-ийн холболтын лимит цохиж
// "too many connections" алдаа гарахаас сэргийлнэ. URL-д аль хэдийн заасан бол хөндөхгүй.
function buildDbUrl() {
  let url = process.env.DATABASE_URL || "";
  if (url && !/[?&]connection_limit=/.test(url)) {
    url += (url.includes("?") ? "&" : "?") + "connection_limit=10&pool_timeout=20";
  }
  return url;
}

function getPrisma() {
  if (!prisma) {
    const url = buildDbUrl();
    prisma = url
      ? new PrismaClient({ datasources: { db: { url } }, log: ["warn", "error"] })
      : new PrismaClient({ log: ["warn", "error"] });
  }
  return prisma;
}

module.exports = { getPrisma };
