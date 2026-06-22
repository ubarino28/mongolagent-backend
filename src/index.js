"use strict";
require("dotenv").config();
const app = require("./app");
const { startDomainHealthLoop } = require("./services/domainHealth.service");

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`[mongolagent] server running on port ${PORT}`);
  // Дэлгүүрийн домэйн/SSL-г фон дээр автоматаар шалгаж засна
  startDomainHealthLoop();
});
