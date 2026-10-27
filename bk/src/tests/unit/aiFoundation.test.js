// The small pieces under the assistant: LRU cache, config, rate limiter, trace store.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLruCache } = require("../../utils/lruCache");
const { loadAiConfig, publicStatus } = require("../../services/ai/aiConfig");
const { createRateLimiter } = require("../../services/ai/rateLimiter");
const { createTraceStore } = require("../../services/ai/traceStore");
const { AiError } = require("../../services/ai/aiError");
const { sampleTrace, SAMPLE_CODE } = require("../helpers/sampleRun");

const fakeClock = (start = 1_000_000) => {
  const clock = { time: start, now: () => clock.time, advance: (ms) => { clock.time += ms; } };
  return clock;
};

test("lru cache evicts the least recently used entry, and a read counts as use", () => {
  const cache = createLruCache({ max: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1); // a is now newer than b
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.size, 2);
});

test("lru cache drops entries older than the ttl", () => {
  const clock = fakeClock();
  const cache = createLruCache({ max: 5, ttlMs: 1000, now: clock.now });
  cache.set("a", 1);
  clock.advance(999);
  assert.equal(cache.get("a"), 1);
  clock.advance(1001);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 0);
});

test("lru cache rejects a nonsense size", () => {
  assert.throws(() => createLruCache({ max: 0 }), RangeError);
});

test("config: no key means the assistant is off, with the reason", () => {
  const config = loadAiConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.reason, "no_key");
});

test("config: a key on a loopback host turns it on with defaults", () => {
  const config = loadAiConfig({ GEMINI_API_KEY: " abc " });
  assert.equal(config.enabled, true);
  assert.equal(config.apiKey, "abc");
  assert.equal(config.model, "gemini-3.5-flash");
  assert.equal(config.perMinute, 8);
});

test("config: Groq key alone turns on Groq provider", () => {
  const config = loadAiConfig({ GROQ_API_KEY: "gsk-123" });
  assert.equal(config.enabled, true);
  assert.equal(config.provider, "groq");
  assert.equal(config.model, "llama-3.3-70b-versatile");
});

test("config: both Groq and Gemini keys configure groq+gemini fallback with Groq preferred", () => {
  const config = loadAiConfig({ GROQ_API_KEY: "gsk-123", GEMINI_API_KEY: "aiza-456" });
  assert.equal(config.enabled, true);
  assert.equal(config.provider, "groq+gemini");
  assert.equal(config.model, "llama-3.3-70b-versatile");
});

test("config: a shared server (HOST=0.0.0.0) keeps the assistant off unless AI_ALLOW_SHARE=1", () => {
  assert.equal(loadAiConfig({ GEMINI_API_KEY: "k", HOST: "0.0.0.0" }).reason, "share_mode");
  assert.equal(loadAiConfig({ GEMINI_API_KEY: "k", HOST: "0.0.0.0", AI_ALLOW_SHARE: "1" }).enabled, true);
});

test("config: AI_ENABLED=0 and a malformed base URL both switch it off", () => {
  assert.equal(loadAiConfig({ GEMINI_API_KEY: "k", AI_ENABLED: "0" }).reason, "turned_off");
  assert.equal(loadAiConfig({ GEMINI_API_KEY: "k", GEMINI_BASE_URL: "not a url" }).reason, "bad_config");
  assert.equal(loadAiConfig({ GEMINI_API_KEY: "k", GEMINI_BASE_URL: "file:///etc/passwd" }).reason, "bad_config");
});

test("config: junk numbers fall back to the defaults instead of becoming NaN", () => {
  const config = loadAiConfig({ GEMINI_API_KEY: "k", AI_RATE_PER_MINUTE: "lots", AI_DAILY_LIMIT: "-4", AI_TIMEOUT_MS: "5" });
  assert.equal(config.perMinute, 8);
  assert.equal(config.perDay, 150);
  assert.equal(config.timeoutMs, 30000);
});

test("config: the public status never carries the key or the base URL", () => {
  const status = JSON.stringify(publicStatus(loadAiConfig({ GEMINI_API_KEY: "super-secret-key", GEMINI_BASE_URL: "http://127.0.0.1:9" })));
  assert.ok(!status.includes("super-secret-key"));
  assert.ok(!status.includes("127.0.0.1"));
});

test("rate limiter: refuses past the per-minute count and reopens as the window slides", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ perMinute: 2, perDay: 100, maxConcurrent: 10, now: clock.now });
  limiter.acquire("ip")();
  limiter.acquire("ip")();
  assert.throws(() => limiter.acquire("ip"), (error) => error instanceof AiError && error.code === "RATE_LIMITED" && error.retryAfterSec >= 1);
  limiter.acquire("other")(); // another caller is not affected
  clock.advance(60_001);
  limiter.acquire("ip")();
});

test("rate limiter: enforces the daily cap and rolls it over after 24 hours", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ perMinute: 100, perDay: 2, maxConcurrent: 10, now: clock.now });
  limiter.acquire("a")();
  limiter.acquire("b")();
  assert.throws(() => limiter.acquire("c"), /daily/);
  clock.advance(24 * 60 * 60_000 + 1);
  limiter.acquire("c")();
});

test("rate limiter: limits requests in flight and release is idempotent", () => {
  const limiter = createRateLimiter({ perMinute: 100, perDay: 100, maxConcurrent: 1 });
  const release = limiter.acquire("a");
  assert.throws(() => limiter.acquire("b"), /busy/);
  release();
  release(); // a second call must not free a slot that is not held
  assert.equal(limiter.inFlight, 0);
  limiter.acquire("b")();
});

test("trace store: returns the stored run with decoded views, and an id the browser cannot guess", () => {
  const store = createTraceStore();
  const trace = sampleTrace();
  const id = store.put({ code: SAMPLE_CODE, stdin: "", trace });
  assert.match(id, /^[0-9a-f]{32}$/);
  const run = store.get(id);
  assert.equal(run.code, SAMPLE_CODE);
  assert.equal(run.views.length, trace.steps.length);
  assert.notEqual(store.put({ code: "x", stdin: "", trace }), id);
});

test("trace store: malformed, unknown and non-string ids are simply not found", () => {
  const store = createTraceStore();
  for (const id of [undefined, null, 5, "", "abc", "../../etc/passwd", "0".repeat(32), "G".repeat(32)]) {
    assert.equal(store.get(id), undefined, String(id));
  }
});

test("trace store: old runs expire and the oldest is evicted past the cap", () => {
  const clock = fakeClock();
  const store = createTraceStore({ max: 2, ttlMs: 1000, now: clock.now });
  const trace = sampleTrace();
  const first = store.put({ code: "1", stdin: "", trace });
  const second = store.put({ code: "2", stdin: "", trace });
  const third = store.put({ code: "3", stdin: "", trace });
  assert.equal(store.get(first), undefined);
  assert.equal(store.get(second).code, "2");
  clock.advance(1001);
  assert.equal(store.get(third), undefined);
});
