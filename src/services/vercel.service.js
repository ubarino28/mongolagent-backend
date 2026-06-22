"use strict";
const axios = require("axios");

/**
 * Vercel домэйн автоматжуулалт.
 *
 * mongolagent.mn нь гадны DNS (dns.mn) дээр учраас Vercel wildcard SSL-г
 * автоматаар үүсгэж чадахгүй. Тиймээс дэлгүүр нийтлэгдэх бүрд тухайн
 * `{slug}.mongolagent.mn` subdomain-г store project-д бүртгэнэ — `*` CNAME
 * нь трафикийг Vercel руу чиглүүлдэг тул Vercel HTTP-01-ээр subdomain бүрт
 * тусдаа SSL гэрчилгээ автоматаар үүсгэнэ. (Multi-tenant SaaS-ийн стандарт арга.)
 *
 * Шаардлагатай env:
 *   VERCEL_TOKEN            — vercel.com/account/tokens дээр үүсгэнэ
 *   VERCEL_STORE_PROJECT_ID — store project id (prj_...)
 *   VERCEL_TEAM_ID          — team/org id (team_...)
 *   STORE_ROOT_DOMAIN       — үндсэн домэйн (default mongolagent.mn)
 */

const TOKEN = process.env.VERCEL_TOKEN;
const PROJECT = process.env.VERCEL_STORE_PROJECT_ID;
const TEAM = process.env.VERCEL_TEAM_ID;
const ROOT = process.env.STORE_ROOT_DOMAIN || "mongolagent.mn";

function enabled() {
  return !!(TOKEN && PROJECT);
}

function domainFor(slug) {
  return `${slug}.${ROOT}`;
}

function teamQuery(prefix = "?") {
  return TEAM ? `${prefix}teamId=${TEAM}` : "";
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

// {slug}.mongolagent.mn-г store project-д нэмнэ (SSL автоматаар үүснэ)
async function addStoreDomain(slug) {
  if (!enabled()) return { skipped: true, reason: "VERCEL env тохируулаагүй" };
  const name = domainFor(slug);
  try {
    const url = `https://api.vercel.com/v10/projects/${PROJECT}/domains${teamQuery()}`;
    await axios.post(url, { name }, { headers: authHeaders() });
    console.log(`[vercel] domain нэмэгдлээ: ${name}`);
    return { ok: true, domain: name };
  } catch (e) {
    const data = e.response?.data?.error;
    // Аль хэдийн бүртгэгдсэн бол алдаа биш
    if (data?.code === "domain_already_in_use" || data?.code === "domain_already_exists" || e.response?.status === 409) {
      return { ok: true, already: true, domain: name };
    }
    console.error(`[vercel] addStoreDomain(${name}):`, data?.message || e.message);
    return { ok: false, error: data?.message || e.message, domain: name };
  }
}

// {slug}.mongolagent.mn-г project-оос хасна (slug солих / устгахад)
async function removeStoreDomain(slug) {
  if (!enabled()) return { skipped: true };
  const name = domainFor(slug);
  try {
    const url = `https://api.vercel.com/v9/projects/${PROJECT}/domains/${name}${teamQuery()}`;
    await axios.delete(url, { headers: authHeaders() });
    console.log(`[vercel] domain хасагдлаа: ${name}`);
    return { ok: true };
  } catch (e) {
    const data = e.response?.data?.error;
    if (e.response?.status === 404) return { ok: true, notFound: true };
    console.error(`[vercel] removeStoreDomain(${name}):`, data?.message || e.message);
    return { ok: false, error: data?.message || e.message };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// {slug}.mongolagent.mn дээр HTTPS (SSL) ажиллаж байгаа эсэхийг шалгана.
// TLS handshake амжвал true; гэрчилгээ гараагүй бол алдаа шиднэ → false.
async function checkSSL(slug) {
  const host = domainFor(slug);
  try {
    await axios.head(`https://${host}`, { timeout: 6000, maxRedirects: 0, validateStatus: () => true });
    return true;
  } catch (e) {
    return false;
  }
}

// Гэрчилгээ гацсан үед дахин trigger хийх — домэйнийг хасаад дахин нэмнэ
async function reprovisionStoreDomain(slug) {
  await removeStoreDomain(slug);
  await sleep(1500);
  return addStoreDomain(slug);
}

// Домэйнийг нэмээд, SSL ажиллах хүртэл хүлээнэ. Хэт удвал нэг удаа дахин trigger хийнэ.
// → { ok, domain, ssl }
async function ensureStoreDomain(slug, { maxWaitMs = 18000, nudgeAfterMs = 7000, intervalMs = 2500 } = {}) {
  const add = await addStoreDomain(slug);
  if (!enabled()) return { ...add, ssl: false };
  const start = Date.now();
  let nudged = false;
  while (Date.now() - start < maxWaitMs) {
    if (await checkSSL(slug)) return { ok: true, domain: domainFor(slug), ssl: true };
    if (!nudged && Date.now() - start >= nudgeAfterMs) {
      nudged = true;
      await reprovisionStoreDomain(slug).catch(() => {});
    }
    await sleep(intervalMs);
  }
  const ssl = await checkSSL(slug);
  return { ok: true, domain: domainFor(slug), ssl };
}

module.exports = { addStoreDomain, removeStoreDomain, reprovisionStoreDomain, ensureStoreDomain, checkSSL, enabled, domainFor };
