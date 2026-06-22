"use strict";
// Mongol Agent платформын subscription төлбөр — quickqr.qpay.mn ашиглана
// Token-г qpay.service.js-тэй хуваалцана (нэг account)
const { getToken } = require("./qpay.service");
const axios = require("axios");

const BASE_URL = "https://quickqr.qpay.mn";

function _headers(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// Subscription invoice үүсгэх → Mongol Agent-ийн өөрийн данс руу
async function createInvoice({ orgId, plan, amount, description }) {
  const merchantId = process.env.PLATFORM_QPAY_MERCHANT_ID;
  const bankCode   = process.env.PLATFORM_BANK_CODE   || "050000";
  const accountNo  = process.env.PLATFORM_ACCOUNT_NUMBER;
  const accountName= process.env.PLATFORM_ACCOUNT_NAME || "Пүрвээ Төрболд";
  const apiUrl     = process.env.API_URL || "https://api.mongolagent.mn";

  if (!merchantId) throw new Error("PLATFORM_QPAY_MERCHANT_ID env тохируулаагүй");
  if (!accountNo)  throw new Error("PLATFORM_ACCOUNT_NUMBER env тохируулаагүй");

  const token = await getToken();
  const res = await axios.post(`${BASE_URL}/v2/invoice`, {
    merchant_id:   merchantId,
    branch_code:   "BRANCH_001",
    amount:        Math.round(amount),
    currency:      "MNT",
    customer_name: "Mongol Agent",
    customer_logo: "",
    callback_url:  `${apiUrl}/webhook/sub-qpay/${orgId}`,
    description:   description || `Mongol Agent — ${plan} план`,
    mcc_code:      "",
    bank_accounts: [{
      account_bank_code: bankCode,
      account_number:    accountNo,
      account_name:      accountName,
      is_default:        true,
    }],
  }, { headers: _headers(token) });

  // QuickQR response-д: id (invoice_id), qr_code (qr_text), qr_image, urls
  const d = res.data;
  return {
    invoice_id: d.id,
    qr_text:    d.qr_code,
    qr_image:   d.qr_image,
    urls:       d.urls || [],
  };
}

// Домэйн худалдан авалтын invoice — ТУСДАА данс руу (subscription-д хүрэхгүй)
async function createDomainInvoice({ orgId, amount, description }) {
  const merchantId = process.env.DOMAIN_QPAY_MERCHANT_ID || process.env.PLATFORM_QPAY_MERCHANT_ID;
  const bankCode   = process.env.DOMAIN_BANK_CODE   || process.env.PLATFORM_BANK_CODE || "050000";
  const accountNo  = process.env.DOMAIN_ACCOUNT_NUMBER || process.env.PLATFORM_ACCOUNT_NUMBER;
  const accountName= process.env.DOMAIN_ACCOUNT_NAME || process.env.PLATFORM_ACCOUNT_NAME || "Mongol Agent";
  const apiUrl     = process.env.API_URL || "https://api.mongolagent.mn";

  if (!merchantId) throw new Error("QPay merchant тохируулаагүй");
  if (!accountNo)  throw new Error("Домэйн дансны дугаар тохируулаагүй");

  const token = await getToken();
  const res = await axios.post(`${BASE_URL}/v2/invoice`, {
    merchant_id:   merchantId,
    branch_code:   "BRANCH_001",
    amount:        Math.round(amount),
    currency:      "MNT",
    customer_name: "Mongol Agent — Domain",
    customer_logo: "",
    callback_url:  `${apiUrl}/webhook/domain-qpay/${orgId}`,
    description:   description || "Домэйн худалдан авалт",
    mcc_code:      "",
    bank_accounts: [{
      account_bank_code: bankCode,
      account_number:    accountNo,
      account_name:      accountName,
      is_default:        true,
    }],
  }, { headers: _headers(token) });

  const d = res.data;
  return { invoice_id: d.id, qr_text: d.qr_code, qr_image: d.qr_image, urls: d.urls || [] };
}

// Төлбөр шалгах
async function checkPayment(invoiceId) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE_URL}/v2/payment/check`,
    { invoice_id: invoiceId },
    { headers: _headers(token) }
  );
  return res.data;
}

module.exports = { createInvoice, createDomainInvoice, checkPayment };
