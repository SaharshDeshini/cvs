// The assistant over real HTTP: the real app, a stubbed runner, and a fake Gemini server on a local port. No key, no Docker.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const KEY = "test-secret-key-xyz";
const requests = [];
let behavior;
let fakeGemini;
let server;
let baseUrl;
let runnerService;

const geminiAnswer = (text) => ({ status: 200, body: { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] } });

test.before(async () => {
  fakeGemini = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(data) });
      const { status, body } = behavior();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => fakeGemini.listen(0, "127.0.0.1", resolve));
  process.env.GEMINI_API_KEY = KEY; // read on the first request, so it must be set before any request
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${fakeGemini.address().port}/v1beta`;
  process.env.GEMINI_MODEL = "fake-model";
  delete process.env.HOST;
  runnerService = require("../../services/runnerService");
  const app = require("../../app");
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fakeGemini.close();
});

const send = async (path, body) => {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
};

async function traceSample(t) {
  const { sampleRawRun, SAMPLE_CODE } = require("../helpers/sampleRun");
  t.mock.method(runnerService, "runTrace", async () => sampleRawRun());
  const { body } = await send("/api/trace", { code: SAMPLE_CODE });
  return body;
}

test("status says the assistant is on and never includes the key", async () => {
  const { status, body } = await send("/api/ai/status");
  assert.equal(status, 200);
  assert.deepEqual([body.enabled, body.provider, body.model], [true, "gemini", "fake-model"]);
  assert.ok(!JSON.stringify(body).includes(KEY));
});

test("a traced run comes back with a traceId, and the schema-1 fields are unchanged", async (t) => {
  const trace = await traceSample(t);
  assert.match(trace.traceId, /^[0-9a-f]{32}$/);
  assert.equal(trace.schema, 1);
  assert.equal(trace.steps.length, 7);
});

test("asking about a step reaches Gemini with the key in a header and the run's facts in the prompt", async (t) => {
  const { traceId } = await traceSample(t);
  behavior = () => geminiAnswer("The call to twice passes `n` = `7` [[step:2]].");
  requests.length = 0;
  const { status, body } = await send("/api/ai/ask", { traceId, kind: "step", step: 2 });
  assert.equal(status, 200);
  assert.deepEqual(body.citations, [1]); // the fake answer cites [[step:2]]: view index 1
  assert.deepEqual(body.verification.unverifiedValues, []);
  const [request] = requests;
  assert.equal(request.url, "/v1beta/models/fake-model:generateContent");
  assert.equal(request.headers["x-goog-api-key"], KEY);
  assert.ok(!request.url.includes(KEY));
  assert.match(request.body.contents[0].parts[0].text, /STEP 3 of 7/);
  assert.match(request.body.contents[0].parts[0].text, /Node\* head = new Node/);
});

test("an unknown run id is 410 and a malformed request is 400, neither reaching Gemini", async () => {
  requests.length = 0;
  const gone = await send("/api/ai/ask", { traceId: "b".repeat(32), kind: "step", step: 0 });
  assert.equal(gone.status, 410);
  assert.equal(gone.body.code, "TRACE_NOT_FOUND");
  for (const bad of [{}, { traceId: "x", kind: "step", step: 1 }, { traceId: "b".repeat(32), kind: "poem" }, { traceId: "b".repeat(32), kind: "chat", message: "  " }]) {
    assert.equal((await send("/api/ai/ask", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(requests.length, 0);
});

test("a rejected key surfaces as a setup hint and the key never appears in the response", async (t) => {
  const { traceId } = await traceSample(t);
  behavior = () => ({ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: `key ${KEY} denied` } } });
  const { status, body } = await send("/api/ai/ask", { traceId, kind: "chat", message: "why?" });
  assert.equal(status, 503);
  assert.equal(body.code, "KEY_REJECTED");
  assert.ok(!JSON.stringify(body).includes(KEY));
});

test("a Gemini 429 becomes a 429 with friendly wording", async (t) => {
  const { traceId } = await traceSample(t);
  behavior = () => ({ status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } } });
  const { status, body } = await send("/api/ai/ask", { traceId, kind: "chat", message: "again" });
  assert.equal(status, 429);
  assert.equal(body.code, "PROVIDER_RATE_LIMITED");
});

test("a disabled assistant answers status with the setup message and refuses questions", async (t) => {
  t.mock.method(console, "error", () => {});
  const { createAiRoutes } = require("../../routes/aiRoutes");
  const { createAiController } = require("../../controllers/aiController");
  const { loadAiConfig } = require("../../services/ai/aiConfig");
  const { createAiService } = require("../../services/ai/aiService");
  const config = loadAiConfig({});
  const service = createAiService({ config, provider: null, traceStore: { get: () => undefined }, limiter: { acquire: () => () => {} } });
  const app = express();
  app.use(express.json());
  app.use("/api/ai", createAiRoutes(createAiController({ getRuntime: () => ({ config, service }) })));
  const local = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const root = `http://127.0.0.1:${local.address().port}/api/ai`;
    const status = await (await fetch(`${root}/status`)).json();
    assert.equal(status.enabled, false);
    assert.equal(status.reason, "no_key");
    assert.match(status.message, /GEMINI_API_KEY/);
    const ask = await fetch(`${root}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ traceId: "c".repeat(32), kind: "chat", message: "hi" }) });
    assert.equal(ask.status, 503);
    assert.equal((await ask.json()).code, "AI_DISABLED");
  } finally {
    local.close();
  }
});

test("a rate-limit refusal carries a Retry-After header", async (t) => {
  t.mock.method(console, "error", () => {});
  const { createAiRoutes } = require("../../routes/aiRoutes");
  const { createAiController } = require("../../controllers/aiController");
  const { AiError } = require("../../services/ai/aiError");
  const service = { ask: async () => { throw new AiError("RATE_LIMITED", "slow down", { retryAfterSec: 12 }); } };
  const app = express();
  app.use(express.json());
  app.use("/api/ai", createAiRoutes(createAiController({ getRuntime: () => ({ config: { enabled: true }, service }) })));
  const local = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${local.address().port}/api/ai/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ traceId: "d".repeat(32), kind: "chat", message: "hi" }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "12");
  } finally {
    local.close();
  }
});
