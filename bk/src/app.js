const path = require("node:path");
const express = require("express");
const cors = require("cors");
const codeRoutes = require("./routes/codeRoutes");
const traceRoutes = require("./routes/traceRoutes");
const aiRoutes = require("./routes/aiRoutes");
const { serveFrontend } = require("./utils/serveFrontend");

const JSON_BODY_LIMIT = "512kb"; // code (100 KB) + stdin (10 KB), with JSON escaping headroom
// Vite's default dev origin, under both loopback spellings. FRONTEND_ORIGIN overrides (comma-separated).
const DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173";
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || DEFAULT_ORIGINS).split(",").map((origin) => origin.trim());

const app = express();
// Not open to every origin: any web page the developer visits could otherwise POST code to localhost.
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.use("/api/code", codeRoutes);
app.use("/api/trace", traceRoutes);
app.use("/api/ai", aiRoutes);

// A built frontend (`cd fe && npm run build`) is served from here too: one process, one port, no CORS. Absent in dev.
serveFrontend(app, process.env.FRONTEND_DIR || path.join(__dirname, "..", "..", "fe", "dist"));

// Body-parser failures (malformed JSON, oversized body, unsupported charset) are client errors, not 500s.
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON body" });
  }
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: "Invalid request" });
  }
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
