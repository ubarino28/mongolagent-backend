"use strict";
const axios = require("axios");

/**
 * Vercel Domains Registrar API — домэйн хайх, үнэ авах, худалдаж авах.
 * Платформ (MongolAgent) домэйн зардаг: хэрэглэгчээс QPay-ээр авч, энд Vercel-аас бүртгэнэ.
 *
 * Env:
 *   VERCEL_REGISTRAR_TOKEN — registrar эрхтэй access token (vercel.com/account/tokens)
 *                            (байхгүй бол VERCEL_TOKEN ашиглана)
 *   VERCEL_TEAM_ID         — team id
 *   DOMAIN_USD_MNT         — USD→MNT ханш (default 3600)
 *   DOMAIN_MARKUP_PCT      — нэмэгдэл ашиг % (default 40)
 */

const BASE = "https://api.vercel.com/v1/registrar";
const TOKEN = process.env.VERCEL_REGISTRAR_TOKEN || process.env.VERCEL_TOKEN;
const TEAM = process.env.VERCEL_TEAM_ID;
const FX = Number(process.env.DOMAIN_USD_MNT) || 3700;          // буфертэй ханш
const FLAT = Number(process.env.DOMAIN_FLAT_MARKUP) || 30000;  // домэйн тутамд тогтмол ашиг

// Хэрэглэгчид санал болгох 15 TLD
const OFFER_TLDS = ["com", "store", "shop", "online", "site", "xyz", "net", "co", "org", "biz", "info", "app", "me", "club", "pro"];

function enabled() { return !!TOKEN; }
function headers() { return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }; }
function teamQ(prefix = "?") { return TEAM ? `${prefix}teamId=${TEAM}` : ""; }

// USD → MNT: өртөг (буфертэй ханш) + тогтмол ашиг, 1000-д бөөрөнхийлнө
function toMnt(usd) {
  return Math.ceil((usd * FX + FLAT) / 1000) * 1000;
}

// "Миний Дэлгүүр" / "miniharsh.com" → "miniharsh" (суурь нэр)
function baseName(q) {
  return String(q || "").toLowerCase().trim().split(".")[0].replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
}

async function availability(domain) {
  const r = await axios.get(`${BASE}/domains/${domain}/availability${teamQ()}`, { headers: headers() });
  return !!r.data.available;
}
async function priceData(domain) {
  const r = await axios.get(`${BASE}/domains/${domain}/price${teamQ()}`, { headers: headers() });
  return r.data; // { years, purchasePrice, renewalPrice, transferPrice }
}

// Нэр хайх → боломжтой домэйнууд + үнэ (MNT)
async function search(q) {
  const base = baseName(q);
  if (!base || base.length < 2) return [];
  const results = await Promise.all(OFFER_TLDS.map(async (tld) => {
    const domain = `${base}.${tld}`;
    try {
      const avail = await availability(domain);
      if (!avail) return { domain, tld, available: false };
      const pd = await priceData(domain).catch(() => null);
      if (!pd || pd.purchasePrice == null) return { domain, tld, available: false };
      return {
        domain, tld, available: true,
        priceMnt: toMnt(pd.purchasePrice),
        renewalMnt: toMnt(pd.renewalPrice ?? pd.purchasePrice),
        priceUsd: pd.purchasePrice,
      };
    } catch { return { domain, tld, available: false }; }
  }));
  // Боломжтойг эхэнд, .com тэргүүлүүлж эрэмбэлнэ
  const order = (d) => OFFER_TLDS.indexOf(d.tld);
  return results.sort((a, b) => (Number(b.available) - Number(a.available)) || (order(a) - order(b)));
}

// TLD бүрийн суурь үнэ (нэрээс хамаарахгүй) — жагсаалтад харуулна. 6 цаг cache.
let _tldCache = null, _tldCacheAt = 0;
async function tldPrices() {
  if (_tldCache && Date.now() - _tldCacheAt < 6 * 3600 * 1000) return _tldCache;
  const out = await Promise.all(OFFER_TLDS.map(async (tld) => {
    try {
      const pd = await priceData(`pricecheck1742.${tld}`);
      if (pd.purchasePrice == null) return null;
      return { tld, priceMnt: toMnt(pd.purchasePrice), renewalMnt: toMnt(pd.renewalPrice ?? pd.purchasePrice) };
    } catch { return null; }
  }));
  _tldCache = out.filter(Boolean);
  _tldCacheAt = Date.now();
  return _tldCache;
}

// Домэйн худалдаж авах (Vercel картаас цэнэглэнэ)
async function buy(domain, { expectedPrice, years = 1, renew = true } = {}) {
  const body = { name: domain, expectedPrice, years, renew };
  const r = await axios.post(`${BASE}/domains/buy${teamQ()}`, body, { headers: headers() });
  return r.data; // { orderId, ... } эсвэл domain мэдээлэл
}
async function orderStatus(orderId) {
  const r = await axios.get(`${BASE}/orders/${orderId}${teamQ()}`, { headers: headers() });
  return r.data;
}

module.exports = { enabled, search, tldPrices, availability, priceData, buy, orderStatus, toMnt, baseName, OFFER_TLDS };
