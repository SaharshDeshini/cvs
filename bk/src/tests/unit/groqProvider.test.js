// The Groq client against a fake fetch: request shape, OpenAI-compatible answer parsing, and failure mappings.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGroqProvider } = require("../../services/ai/groqProvider");
const { AiError } = require("../../services/ai/aiError");

const KEY = "gsk-test-key-123";
const answer = (text, extra = {}) => ({
  choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop", ...extra }],
  usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const errorBody = (status, message, code = status) => json({ error: { code, message: message.text } }, status);

function setup(responses, overrides = {}) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next.clone();
  };
  const provider = createGroqProvider({
    apiKey: KEY,
    model: "llama-3.3-70b-versatile",
    baseUrl: "http://fake.groq.local/openai/v1",
    timeoutMs: 5000,
    maxOutputTokens: 777,
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  });
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

test("groq: sends Authorization Bearer header and OpenAI-compatible chat messages", async () => {
  const { provider, calls } = setup([json(answer("ok"))]);
  await provider.generate({ system: "SYS", messages: [{ role: "user", text: "q1" }, { role: "assistant", text: "a1" }, { role: "user", text: "q2" }] });
  const [{ url, init, body }] = calls;
  assert.equal(url, "http://fake.groq.local/openai/v1/chat/completions");
  assert.equal(init.headers["Authorization"], `Bearer ${KEY}`);
  assert.deepEqual(body.messages, [
    { role: "system", content: "SYS" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
  ]);
  assert.equal(body.max_tokens, 777);
  assert.equal(body.model, "llama-3.3-70b-versatile");
});

test("groq: returns text, token usage and model name", async () => {
  const result = await ask(setup([json(answer("Hello from Groq"))]).provider);
  assert.equal(result.text, "Hello from Groq");
  assert.equal(result.model, "llama-3.3-70b-versatile");
  assert.deepEqual(result.usage, { promptTokens: 12, outputTokens: 6, totalTokens: 18 });
  assert.equal(result.truncated, false);
});

test("groq: length finish_reason marks truncated", async () => {
  const result = await ask(setup([json(answer("cut...", { finish_reason: "length" }))]).provider);
  assert.equal(result.text, "cut...");
  assert.equal(result.truncated, true);
});

test("groq: retries 503 and uses next answer", async () => {
  const { provider, calls } = setup([errorBody(503, { text: "Service Unavailable" }), json(answer("recovered"))]);
  assert.equal((await ask(provider)).text, "recovered");
  assert.equal(calls.length, 2);
});

test("groq: rate limiting 429 becomes PROVIDER_RATE_LIMITED", async () => {
  const error = await failureOf(ask(setup([errorBody(429, { text: "Rate limit reached" })]).provider));
  assert.equal(error.code, "PROVIDER_RATE_LIMITED");
});

test("groq: bad key (401/403) becomes KEY_REJECTED", async () => {
  const error401 = await failureOf(ask(setup([errorBody(401, { text: "Invalid API key" })]).provider));
  assert.equal(error401.code, "KEY_REJECTED");
  assert.ok(!error401.detail.includes(KEY));
});

test("groq: missing model 404 becomes MODEL_NOT_FOUND", async () => {
  const error404 = await failureOf(ask(setup([errorBody(404, { text: "Model not found" })]).provider));
  assert.equal(error404.code, "MODEL_NOT_FOUND");
});
