// The orchestration: refusals, caching, rate limiting, context hand-off, and answer verification, with a fake provider.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAiService } = require("../../services/ai/aiService");
const { createTraceStore } = require("../../services/ai/traceStore");
const { createRateLimiter } = require("../../services/ai/rateLimiter");
const { loadAiConfig } = require("../../services/ai/aiConfig");
const { AiError } = require("../../services/ai/aiError");
const { sampleTrace, compileErrorTrace, SAMPLE_CODE } = require("../helpers/sampleRun");

const ENABLED = loadAiConfig({ GEMINI_API_KEY: "k" });

function setup({ config = ENABLED, text = "Step two calls twice [[step:2]] with `n` = `7`.", perMinute = 100, providerResult, providerError } = {}) {
  const calls = [];
  const provider = {
    model: "fake-model",
    async generate(request) {
      calls.push(request);
      if (providerError) throw providerError;
      return providerResult ?? { text, finishReason: "STOP", truncated: false, usage: { totalTokens: 9 } };
    },
  };
  const traceStore = createTraceStore();
  const limiter = createRateLimiter({ perMinute, perDay: 100, maxConcurrent: 4 });
  const service = createAiService({ config, provider: config.enabled ? provider : null, traceStore, limiter });
  const traceId = traceStore.put({ code: SAMPLE_CODE, stdin: "", trace: sampleTrace() });
  const compileId = traceStore.put({ code: "int main() { totl = 1; }", stdin: "", trace: compileErrorTrace() });
  const ask = (overrides = {}) => service.ask({ traceId, kind: "step", step: 2, message: "", level: "standard", history: [], findings: [], caller: "ip", ...overrides });
  return { ask, calls, limiter, traceId, compileId };
}

const failureOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("expected a rejection");
};

test("when the assistant is off it says why and never calls the provider", async () => {
  const { ask, calls } = setup({ config: loadAiConfig({}) });
  const error = await failureOf(ask());
  assert.equal(error.code, "AI_DISABLED");
  assert.match(error.message, /GEMINI_API_KEY/);
  assert.equal(calls.length, 0);
});

test("an unknown run id, or a step outside the run, is refused before any model call", async () => {
  const { ask, calls, compileId } = setup();
  assert.equal((await failureOf(ask({ traceId: "a".repeat(32) }))).code, "TRACE_NOT_FOUND");
  assert.equal((await failureOf(ask({ step: 7 }))).code, "BAD_REQUEST");
  assert.equal((await failureOf(ask({ traceId: compileId, step: 0 }))).code, "BAD_REQUEST");
  assert.equal((await failureOf(ask({ traceId: compileId, kind: "step", step: 0 }))).code, "BAD_REQUEST");
  assert.equal(calls.length, 0);
});

test("the model gets the system rules, the server's own copy of the run, and the question last", async () => {
  const { ask, calls } = setup();
  await ask();
  const [{ system, messages }] = calls;
  assert.match(system, /Never invent a value/);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].text, /int total = twice\(head->val\);/);
  assert.match(messages[0].text, /STEP 3 of 7/);
  assert.ok(messages[0].text.endsWith(`QUESTION:\nExplain what is happening at the CURRENT STEP: what the line does, which values changed and why, and what to watch for next. 3 to 6 sentences.`));
});

test("the answer is verified: bad citations are removed and unmatched numbers reported", async () => {
  const { ask } = setup({ text: "See [[step:2]] and [[step:88]]: `n` is `7`, not `4242`." });
  const result = await ask();
  assert.deepEqual(result.citations, [1]); // [[step:2]] in the text is view index 1
  assert.equal(result.verification.invalidCitations, 1);
  assert.deepEqual(result.verification.unverifiedValues, ["4242"]);
  assert.ok(!result.answer.includes("88"));
  assert.equal(result.model, "fake-model");
  assert.equal(result.step, 2);
});

test("an explanation is cached: the second ask costs no model call and no rate-limit slot", async () => {
  const { ask, calls } = setup({ perMinute: 1 });
  const first = await ask();
  const second = await ask();
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.answer, first.answer);
  assert.equal(calls.length, 1);
});

test("the cache is per step and per level; chat questions are never cached", async () => {
  const { ask, calls } = setup();
  await ask();
  await ask({ step: 3 });
  await ask({ level: "beginner" });
  assert.equal(calls.length, 3);
  await ask({ kind: "chat", message: "why?" });
  await ask({ kind: "chat", message: "why?" });
  assert.equal(calls.length, 5);
});

test("a truncated answer is returned but not cached", async () => {
  const { ask, calls } = setup({ providerResult: { text: "cut off", finishReason: "MAX_TOKENS", truncated: true, usage: {} } });
  assert.equal((await ask()).truncated, true);
  await ask();
  assert.equal(calls.length, 2);
});

test("chat history comes before the final turn, in order", async () => {
  const { ask, calls } = setup();
  await ask({ kind: "chat", message: "and then?", history: [{ role: "user", text: "what is n?" }, { role: "assistant", text: "7" }] });
  const { messages } = calls[0];
  assert.deepEqual(messages.slice(0, 2), [{ role: "user", text: "what is n?" }, { role: "assistant", text: "7" }]);
  assert.match(messages[2].text, /QUESTION:\nand then\?$/);
});

test("an error question on a program that did not compile asks about the compiler errors", async () => {
  const { ask, calls, compileId } = setup({ text: "Rename `totl` to `total`." });
  const result = await ask({ traceId: compileId, kind: "error", step: null });
  assert.match(calls[0].messages[0].text, /did not compile/);
  assert.match(calls[0].messages[0].text, /'totl' was not declared/);
  assert.equal(result.step, null);
});

test("an error question defaults to the last step of a run that has steps", async () => {
  const { ask } = setup();
  assert.equal((await ask({ kind: "error", step: null })).step, 6);
});

test("the rate limiter is consulted for model calls and its refusal stops the call", async () => {
  const { ask, calls } = setup({ perMinute: 1 });
  await ask({ kind: "chat", message: "one" });
  const error = await failureOf(ask({ kind: "chat", message: "two" }));
  assert.equal(error.code, "RATE_LIMITED");
  assert.equal(calls.length, 1);
});

test("a provider failure propagates and still frees the rate-limit slot", async () => {
  const { ask, limiter } = setup({ providerError: new AiError("PROVIDER_UNAVAILABLE", "down") });
  assert.equal((await failureOf(ask())).code, "PROVIDER_UNAVAILABLE");
  assert.equal(limiter.inFlight, 0);
});
