const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

/**
 * Serves a built frontend (`fe/dist`) from the same server as the API, so one process and one port run the whole app.
 * Does nothing and returns false when `dir` has no index.html (the dev setup runs Vite separately).
 * Register AFTER the API routes: the fallback hands any other GET/HEAD to the single-page app, but never an /api path.
 */
function serveFrontend(app, dir) {
  const indexFile = path.join(dir, "index.html");
  if (!fs.existsSync(indexFile)) return false;

  app.use(express.static(dir, { index: "index.html" })); // serve-static rejects ../ escapes
  app.use((req, res, next) => {
    const isPageRequest = req.method === "GET" || req.method === "HEAD";
    if (!isPageRequest || req.path.startsWith("/api/")) return next();
    return res.sendFile(indexFile);
  });
  return true;
}

module.exports = { serveFrontend };
