"use strict";
const axios = require("axios");

const BASE_URL = "https://quickqr.qpay.mn";

// Token 24 цагт нэг удаа авдаг — cache хийнэ
let _token = null;
let _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;

  const username = process.env.QPAY_USERNAME;
  const password = process.env.QPAY_PASSWORD;
  if (!username || !password) throw new Error("QPAY_USERNAME / QPAY_PASSWORD env тохируулаагүй");

  const body = { terminal_id: process.env.QPAY_TERMINAL_ID || username };

  const res = await axios.post(`${BASE_URL}/v2/auth/token`, body, {
    auth: { username, password },
    headers: { "Content-Type": "application/json" },
  });

  _token = res.data.access_token;
  _tokenExp = Date.now() + 23 * 60 * 60 * 1000; // 23 цаг (24-аас бага)
  return _token;
}

async function _refreshToken() {
  _token = null;
  _tokenExp = 0;
  return getToken();
}

function _authHeaders(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// 401 бол token refresh хийгээд дахин оролдоно
async function _withRetry(fn) {
  try {
    return await fn(await getToken());
  } catch (err) {
    if (err.response?.status === 401) {
      return fn(await _refreshToken());
    }
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    throw new Error(msg);
  }
}

// ─── Merchant ────────────────────────────────────────────────────────────────

// Компани хэлбэрээр sub-merchant бүртгэх
async function createMerchantCompany(data) {
  return _withRetry((token) =>
    axios.post(`${BASE_URL}/v2/merchant/company`, data, { headers: _authHeaders(token) }).then((r) => r.data)
  );
}

// Хувь хүн хэлбэрээр sub-merchant бүртгэх
async function createMerchantPerson(data) {
  return _withRetry((token) =>
    axios.post(`${BASE_URL}/v2/merchant/person`, data, { headers: _authHeaders(token) }).then((r) => r.data)
  );
}

// Merchant мэдээлэл авах
async function getMerchant(merchantId) {
  return _withRetry((token) =>
    axios.get(`${BASE_URL}/v2/merchant/${merchantId}`, { headers: _authHeaders(token) }).then((r) => r.data)
  );
}

// Merchant жагсаалт
async function listMerchants({ page = 1, limit = 20 } = {}) {
  return _withRetry((token) =>
    axios.post(
      `${BASE_URL}/v2/merchant/list`,
      { offset: { page_number: page, page_limit: limit } },
      { headers: _authHeaders(token) }
    ).then((r) => r.data)
  );
}

// Хот/аймгийн жагсаалт
async function getCities() {
  return _withRetry((token) =>
    axios.get(`${BASE_URL}/v2/aimaghot`, { headers: _authHeaders(token) }).then((r) => r.data)
  );
}

// Дүүрэг/сумын жагсаалт
async function getDistricts(cityCode) {
  return _withRetry((token) =>
    axios.get(`${BASE_URL}/v2/sumduureg/${cityCode}`, { headers: _authHeaders(token) }).then((r) => r.data)
  );
}

// ─── Invoice ─────────────────────────────────────────────────────────────────

/**
 * QPay invoice үүсгэж QR + deeplinks буцаана
 * @param {object} params
 * @param {string} params.merchantId     - org.qpayMerchantId
 * @param {string} params.branchCode     - org.qpayBranchCode || "BRANCH_001"
 * @param {number} params.amount         - захиалгын нийт дүн (₮)
 * @param {string} params.description    - invoice тайлбар
 * @param {string} params.customerName   - хэрэглэгчийн нэр
 * @param {Array}  params.bankAccounts   - [{ account_bank_code, account_number, account_name, default: true }]
 * @param {string} params.callbackUrl    - төлбөр дууссаны дараа QPay дуудах URL
 * @returns {{ invoice_id, qr_text, qr_image, urls }}
 */
async function createInvoice({ merchantId, branchCode, amount, description, customerName, bankAccounts, callbackUrl }) {
  const body = {
    merchant_id: merchantId,
    branch_code: branchCode || "BRANCH_001",
    amount: Math.round(amount),
    currency: "MNT",
    customer_name: customerName || "Хэрэглэгч",
    customer_logo: "",
    callback_url: callbackUrl || `${process.env.API_URL || "https://api.mongolagent.mn"}/webhook/qpay`,
    description: description || "Захиалгын төлбөр",
    mcc_code: "",
    bank_accounts: bankAccounts,
  };

  return _withRetry((token) =>
    axios.post(`${BASE_URL}/v2/invoice`, body, { headers: _authHeaders(token) }).then((r) => r.data)
  );
}

// Invoice мэдээлэл авах
async function getInvoice(invoiceId) {
  return _withRetry((token) =>
    axios.get(`${BASE_URL}/v2/invoice/${invoiceId}`, { headers: _authHeaders(token) }).then((r) => r.data)
  );
}

// ─── Payment ─────────────────────────────────────────────────────────────────

// Төлбөр хийгдсэн эсэх шалгах
async function checkPayment(invoiceId) {
  return _withRetry((token) =>
    axios.post(
      `${BASE_URL}/v2/payment/check`,
      { invoice_id: invoiceId },
      { headers: _authHeaders(token) }
    ).then((r) => r.data)
  );
}

// ─── Helper ──────────────────────────────────────────────────────────────────

// QPay deeplinks-с хэрэглэгчид явуулах мессеж бүтээх
function buildPaymentMessage(invoiceResult, amount, orderRef) {
  const lines = [
    `💳 QPay төлбөр — ₮${Number(amount).toLocaleString()}`,
    `📋 Захиалга #${orderRef}`,
    "",
    "Банкны аппаасаа дараах холбоосоор нэвтэрч төлнө үү:",
  ];

  const urls = invoiceResult.urls || [];
  for (const u of urls.slice(0, 6)) {
    if (u.link) lines.push(`• ${u.name || u.description}: ${u.link}`);
  }

  if (urls.length === 0 && invoiceResult.qr_text) {
    lines.push("QR код: " + invoiceResult.qr_text);
  }

  return lines.join("\n");
}

// Монголын банкны кодууд (dashboard-д select болгоход)
const BANK_CODES = [
  { code: "050000", name: "Хаан банк" },
  { code: "150000", name: "Голомт банк" },
  { code: "040000", name: "ТДБ (Trade and Development Bank)" },
  { code: "290000", name: "М банк" },
  { code: "320000", name: "ХасБанк (XacBank)" },
  { code: "160000", name: "Төрийн банк" },
  { code: "240000", name: "Капитрон банк" },
  { code: "220000", name: "Богд банк" },
  { code: "380000", name: "Ариг банк" },
  { code: "300000", name: "Үндэсний хөрөнгө оруулалтын банк" },
];

module.exports = {
  getToken,
  createMerchantCompany,
  createMerchantPerson,
  getMerchant,
  listMerchants,
  getCities,
  getDistricts,
  createInvoice,
  getInvoice,
  checkPayment,
  buildPaymentMessage,
  BANK_CODES,
};
