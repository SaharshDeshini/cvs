// The Gemini client against a fake fetch: request shape, answer parsing, and every failure mapping. No network, no key.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGeminiProvider } = require("../../services/ai/geminiProvider");
const { AiError } = require("../../services/ai/aiError");

const KEY = "AIza-test-key-123";
const answer = (text, extra = {}) => ({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", ...extra }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const errorBody = (status, message, code = status) => json({ error: { code, status: message.status, message: message.text } }, status);

function setup(responses, overrides = {}) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next.clone();
  };
  const provider = createGeminiProvider({ apiKey: KEY, model: "gemini-test", baseUrl: "http://fake.local/v1beta", timeoutMs: 5000, maxOutputTokens: 777, fetchImpl, sleep: async () => {}, ...overrides });
  return { provider, calls };
}

const ask = (provider, extra = {}) => provider.generate({ system: "SYS", messages: [{ role: "user", text: "hi" }], ...extra });
const failureOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("expected a rejection");
};

test("sends the classic generateContent request with the key in a header only", async () => {
  const { provider, calls } = setup([json(answer("ok"))]);
  await provider.generate({ system: "SYS", messages: [{ role: "user", text: "q1" }, { role: "assistant", text: "a1" }, { role: "user", text: "q2" }] });
  const [{ url, init, body }] = calls;
  assert.equal(url, "http://fake.local/v1beta/models/gemini-test:generateContent");
  assert.equal(init.headers["x-goog-api-key"], KEY);
  assert.ok(!url.includes(KEY), "the key must not be in the URL");
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "SYS" }] });
  assert.deepEqual(body.contents.map((c) => [c.role, c.parts[0].text]), [["user", "q1"], ["model", "a1"], ["user", "q2"]]);
  assert.equal(body.generationConfig.maxOutputTokens, 777);
});

test("returns the joined visible text and token usage, and never shows thought parts", async () => {
  const body = answer("");
  body.candidates[0].content.parts = [{ text: "secret reasoning", thought: true }, { text: "Hello " }, { text: "world" }];
  const result = await ask(setup([json(body)]).provider);
  assert.equal(result.text, "Hello world");
  assert.deepEqual(result.usage, { promptTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal(result.truncated, false);
});

test("a MAX_TOKENS finish keeps the text and marks it truncated", async () => {
  const result = await ask(setup([json(answer("partial", { finishReason: "MAX_TOKENS" }))]).provider);
  assert.equal(result.text, "partial");
  assert.equal(result.truncated, true);
});

test("a temporary 503 is retried and the next answer is used", async () => {
  const { provider, calls } = setup([errorBody(503, { status: "UNAVAILABLE", text: "overloaded" }), json(answer("recovered"))]);
  assert.equal((await ask(provider)).text, "recovered");
  assert.equal(calls.length, 2);
});

test("a network failure is retried, then reported as unavailable with the retries spent", async () => {
  const { provider, calls } = setup([new TypeError("fetch failed")]);
  const error = await failureOf(ask(provider));
  assert.equal(error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(calls.length, 3); // first try + 2 retries
});

test("rate limiting (429) is reported immediately and not retried", async () => {
  const { provider, calls } = setup([errorBody(429, { status: "RESOURCE_EXHAUSTED", text: "quota" })]);
  const error = await failureOf(ask(provider));
  assert.equal(error.code, "PROVIDER_RATE_LIMITED");
  assert.equal(error.status, 429);
  assert.equal(calls.length, 1);
});

test("a bad key is KEY_REJECTED whether it arrives as 403 or as Gemini's 400 'API key not valid'", async () => {
  const forbidden = await failureOf(ask(setup([errorBody(403, { status: "PERMISSION_DENIED", text: "no" })]).provider));
  const invalid = await failureOf(ask(setup([errorBody(400, { status: "INVALID_ARGUMENT", text: "API key not valid. Please pass a valid API key." })]).provider));
  assert.equal(forbidden.code, "KEY_REJECTED");
  assert.equal(invalid.code, "KEY_REJECTED");
});

test("other 400s and a missing model are told apart", async () => {
  assert.equal((await failureOf(ask(setup([errorBody(400, { status: "INVALID_ARGUMENT", text: "bad field" })]).provider))).code, "PROVIDER_ERROR");
  assert.equal((await failureOf(ask(setup([errorBody(404, { status: "NOT_FOUND", text: "model" })]).provider))).code, "MODEL_NOT_FOUND");
});

test("a blocked prompt or a safety-blocked answer is BLOCKED, an empty one is EMPTY_ANSWER", async () => {
  assert.equal((await failureOf(ask(setup([json({ promptFeedback: { blockReason: "SAFETY" } })]).provider))).code, "BLOCKED");
  const safety = { candidates: [{ finishReason: "SAFETY" }] };
  assert.equal((await failureOf(ask(setup([json(safety)]).provider))).code, "BLOCKED");
  assert.equal((await failureOf(ask(setup([json(answer("   "))]).provider))).code, "EMPTY_ANSWER");
  assert.equal((await failureOf(ask(setup([json({})]).provider))).code, "EMPTY_ANSWER");
});

test("a request that exceeds the time limit is TIMEOUT; a caller's own abort is passed through untouched", async () => {
  const timeout = new DOMException("timed out", "TimeoutError");
  assert.equal((await failureOf(ask(setup([timeout]).provider))).code, "TIMEOUT");
  const controller = new AbortController();
  controller.abort();
  const cancelled = new DOMException("aborted", "AbortError");
  const error = await failureOf(ask(setup([cancelled]).provider, { signal: controller.signal }));
  assert.ok(!(error instanceof AiError));
});

test("a provider that echoes the key in its error text cannot get it into the log detail", async () => {
  const echo = errorBody(403, { status: "PERMISSION_DENIED", text: `The key ${KEY} is not allowed` });
  const error = await failureOf(ask(setup([echo]).provider));
  assert.equal(error.code, "KEY_REJECTED");
  assert.ok(!error.detail.includes(KEY), error.detail);
  assert.match(error.detail, /\[redacted\]/);
  const network = await failureOf(ask(setup([new TypeError(`connect failed for ${KEY}`)]).provider));
  assert.ok(!network.detail.includes(KEY), network.detail);
});

test("no error message or detail ever contains the API key", async () => {
  const bodies = [errorBody(403, { status: "PERMISSION_DENIED", text: "denied" }), errorBody(500, { status: "INTERNAL", text: "boom" }), json({})];
  for (const response of bodies) {
    const error = await failureOf(ask(setup([response]).provider));
    assert.ok(!`${error.message} ${error.detail}`.includes(KEY));
  }
});
