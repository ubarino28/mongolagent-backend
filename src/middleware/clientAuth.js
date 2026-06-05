"use strict";
const jwt = require("jsonwebtoken");

function clientAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });

  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "mongolagent_admin_secret_change_me");
    if (!payload.orgId) return res.status(401).json({ error: "Invalid token" });
    req.org = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = { clientAuthMiddleware };
