const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { serveFrontend } = require("../../utils/serveFrontend");

function makeBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cvis-fe-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>CVis</title>");
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

async function withServer(app, run) {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function appWithFrontend(dir) {
  const app = express();
  app.get("/api/ping", (req, res) => res.json({ pong: true }));
  const served = serveFrontend(app, dir);
  return { app, served };
}

test("serves index.html at / and built assets by path", async () => {
  const dir = makeBuild();
  const { app, served } = appWithFrontend(dir);
  assert.equal(served, true);
  await withServer(app, async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>CVis<\/title>/);
    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "console.log(1)");
  });
});

test("unknown non-API paths fall back to index.html", async () => {
  const dir = makeBuild();
  const { app } = appWithFrontend(dir);
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/some/client/route`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>CVis<\/title>/);
  });
});

test("API routes still win, and an unknown API path is a 404, not the page", async () => {
  const dir = makeBuild();
  const { app } = appWithFrontend(dir);
  await withServer(app, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/ping`)).json(), { pong: true });
    const missing = await fetch(`${base}/api/nope`);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /<title>CVis<\/title>/);
  });
});

test("only GET and HEAD get the page: a POST to an unknown path is 404", async () => {
  const dir = makeBuild();
  const { app } = appWithFrontend(dir);
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/anything`, { method: "POST" });
    assert.equal(response.status, 404);
  });
});

test("path traversal cannot read outside the build directory", async () => {
  const dir = makeBuild();
  fs.writeFileSync(path.join(path.dirname(dir), "cvis-secret.txt"), "secret");
  const { app } = appWithFrontend(dir);
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/..%2fcvis-secret.txt`);
    assert.doesNotMatch(await response.text(), /secret/);
  });
});

test("does nothing when there is no build", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cvis-empty-"));
  const app = express();
  assert.equal(serveFrontend(app, empty), false);
  assert.equal(serveFrontend(app, path.join(empty, "missing")), false);
});
