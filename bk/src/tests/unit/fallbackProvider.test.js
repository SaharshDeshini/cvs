// Unit tests for the fallback provider (Groq primary, Gemini fallback)
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFallbackProvider } = require("../../services/ai/fallbackProvider");
const { AiError } = require("../../services/ai/aiError");

test("fallback: uses primary provider when it succeeds", async () => {
  const primary = {
    name: "groq",
    model: "llama-3.3-70b",
    calls: 0,
    async generate(req) {
      this.calls += 1;
      return { text: "from groq", model: this.model, truncated: false, usage: {} };
    },
  };
  const fallback = {
    name: "gemini",
    model: "gemini-3.5-flash",
    calls: 0,
    async generate(req) {
      this.calls += 1;
      return { text: "from gemini", model: this.model, truncated: false, usage: {} };
    },
  };

  const provider = createFallbackProvider({ primary, fallback });
  const result = await provider.generate({ system: "SYS", messages: [{ role: "user", text: "hi" }] });

  assert.equal(result.text, "from groq");
  assert.equal(result.model, "llama-3.3-70b");
  assert.equal(provider.model, "llama-3.3-70b");
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 0);
});

test("fallback: falls back to secondary when primary fails with PROVIDER_UNAVAILABLE or RATE_LIMITED", async () => {
  const primary = {
    name: "groq",
    model: "llama-3.3-70b",
    calls: 0,
    async generate() {
      this.calls += 1;
      throw new AiError("PROVIDER_UNAVAILABLE", "Groq is down");
    },
  };
  const fallback = {
    name: "gemini",
    model: "gemini-3.5-flash",
    calls: 0,
    async generate() {
      this.calls += 1;
      return { text: "from gemini fallback", model: this.model, truncated: false, usage: {} };
    },
  };

  let fallbackLogged = null;
  const provider = createFallbackProvider({
    primary,
    fallback,
    onFallback: (info) => {
      fallbackLogged = info;
    },
  });

  const result = await provider.generate({ system: "SYS", messages: [{ role: "user", text: "hi" }] });
  assert.equal(result.text, "from gemini fallback");
  assert.equal(result.model, "gemini-3.5-flash");
  assert.equal(provider.model, "gemini-3.5-flash");
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 1);
  assert.equal(fallbackLogged?.from, "groq");
  assert.equal(fallbackLogged?.to, "gemini");
});

test("fallback: does not fall back if request was aborted by caller", async () => {
  const controller = new AbortController();
  controller.abort();
  const primary = {
    name: "groq",
    model: "llama-3.3-70b",
    async generate() {
      const err = new DOMException("aborted", "AbortError");
      throw err;
    },
  };
  const fallback = {
    name: "gemini",
    model: "gemini-3.5-flash",
    calls: 0,
    async generate() {
      this.calls += 1;
      return { text: "never reached", model: this.model };
    },
  };

  const provider = createFallbackProvider({ primary, fallback });
  try {
    await provider.generate({ signal: controller.signal });
    assert.fail("should have thrown");
  } catch (error) {
    assert.equal(error.name, "AbortError");
    assert.equal(fallback.calls, 0);
  }
});
