"use strict";
const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../lib/jwtSecret");

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });

  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, jwtSecret(), { algorithms: ["HS256"] });
    // ЗААВАЛ admin claim шалгана — энгийн хэрэглэгчийн token-оор admin болохоос сэргийлнэ
    if (payload.admin !== true) return res.status(403).json({ error: "Forbidden" });
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = { authMiddleware };
