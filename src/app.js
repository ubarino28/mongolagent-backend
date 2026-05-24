"use strict";
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const webhookRouter = require("./routes/webhook.routes");
const adminRouter = require("./routes/admin.routes");
const authRouter = require("./routes/auth.routes");
const clientRouter = require("./routes/client.routes");

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "https://turuuai.mn",
  "https://www.turuuai.mn",
  "https://admin.turuuai.mn",
  "https://app.turuuai.mn",
  "https://turuuai-admin.vercel.app",
  "https://turuuai-app.vercel.app",
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, service: "turuuai-backend" }));

app.use("/webhook", webhookRouter);
app.use("/admin", adminRouter);
app.use("/auth", authRouter);
app.use("/client", clientRouter);

module.exports = app;
