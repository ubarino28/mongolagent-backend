"use strict";

// Sentry observability — ЗӨВХӨН SENTRY_DSN тохируулсан үед идэвхжинэ.
// DSN байхгүй эсвэл package олдохгүй бол бүрэн no-op (серверийг хэзээ ч унагахгүй).
let Sentry = null;

function initSentry() {
  if (!process.env.SENTRY_DSN) return null;
  try {
    Sentry = require("@sentry/node");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || "production",
      tracesSampleRate: Number(process.env.SENTRY_TRACES || 0.1),
    });
    console.log("[sentry] initialized");
  } catch (e) {
    console.error("[sentry] init failed:", e.message);
    Sentry = null;
  }
  return Sentry;
}

function captureException(err, context) {
  try { if (Sentry) Sentry.captureException(err, context ? { extra: context } : undefined); } catch { /* no-op */ }
}

module.exports = { initSentry, captureException };
