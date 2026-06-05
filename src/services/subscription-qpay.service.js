"use strict";
const axios = require("axios");

const BASE_URL = "https://merchant.qpay.mn";

// Token cache — 24 цагт нэг удаа авна
let _token = null;
let _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;

  const username = process.env.SUB_QPAY_USERNAME;
  const password = process.env.SUB_QPAY_PASSWORD;
  if (!username || !password) throw new Error("SUB_QPAY_USERNAME / SUB_QPAY_PASSWORD env тохируулаагүй");

  const res = await axios.post(`${BASE_URL}/v2/auth/token`, "", {
    auth: { username, password },
    headers: { "Content-Type": "application/json" },
  });

  _token = res.data.access_token;
  _tokenExp = Date.now() + 23 * 60 * 60 * 1000;
  return _token;
}

async function _refreshToken() {
  _token = null;
  _tokenExp = 0;
  return getToken();
}

function _headers(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function _withRetry(fn) {
  try {
    return await fn(await getToken());
  } catch (err) {
    if (err.response?.status === 401) return fn(await _refreshToken());
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    throw new Error(msg);
  }
}

// Subscription invoice үүсгэх
async function createInvoice({ orgId, plan, amount, description }) {
  const invoiceCode = process.env.SUB_QPAY_INVOICE_CODE || "MONGOL_AGENT_INVOICE";
  const apiUrl = process.env.API_URL || "https://api.mongolagent.mn";

  const body = {
    invoice_code: invoiceCode,
    sender_invoice_no: `${orgId.slice(-8)}-${Date.now()}`,
    invoice_receiver_code: "terminal",
    sender_branch_code: "MAIN",
    invoice_description: description || `Mongol Agent — ${plan} план`,
    amount: Math.round(amount),
    callback_url: `${apiUrl}/webhook/sub-qpay/${orgId}`,
  };

  return _withRetry((token) =>
    axios.post(`${BASE_URL}/v2/invoice`, body, { headers: _headers(token) }).then((r) => r.data)
  );
}

// Төлбөр шалгах
async function checkPayment(invoiceId) {
  return _withRetry((token) =>
    axios.post(
      `${BASE_URL}/v2/payment/check`,
      { object_type: "INVOICE", object_id: invoiceId, offset: { page_number: 1, page_limit: 100 } },
      { headers: _headers(token) }
    ).then((r) => r.data)
  );
}

module.exports = { getToken, createInvoice, checkPayment };
