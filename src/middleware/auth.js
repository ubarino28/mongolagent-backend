"use strict";
const jwt = require("jsonwebtoken");

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });

  const token = auth.slice(7);
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET || "turuuai_admin_secret_change_me");
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = { authMiddleware };
