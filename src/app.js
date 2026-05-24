"use strict";
require("dotenv").config();
const express = require("express");
const webhookRouter = require("./routes/webhook.routes");

const app = express();

app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, service: "turuuai-backend" }));

app.use("/webhook", webhookRouter);

module.exports = app;
