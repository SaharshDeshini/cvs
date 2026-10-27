// Wires the assistant from the environment, once, on first use (so `dotenv` in server.js has already run, and tests can set the
// environment before the first request). The trace store is created eagerly: /api/trace remembers runs in it.
const { loadAiConfig } = require("./aiConfig");
const { createGeminiProvider } = require("./geminiProvider");
const { createGroqProvider } = require("./groqProvider");
const { createFallbackProvider } = require("./fallbackProvider");
const { createRateLimiter } = require("./rateLimiter");
const { createTraceStore } = require("./traceStore");
const { createAiService } = require("./aiService");

const traceStore = createTraceStore();
let runtime = null;

function buildProvider(config) {
  if (!config.enabled) return null;
  const groq = config.groq.enabled
    ? createGroqProvider({
        apiKey: config.groq.apiKey,
        model: config.groq.model,
        baseUrl: config.groq.baseUrl,
        timeoutMs: config.timeoutMs,
        maxOutputTokens: config.maxOutputTokens,
      })
    : null;
  const gemini = config.gemini.enabled
    ? createGeminiProvider({
        apiKey: config.gemini.apiKey,
        model: config.gemini.model,
        baseUrl: config.gemini.baseUrl,
        timeoutMs: config.timeoutMs,
        maxOutputTokens: config.maxOutputTokens,
      })
    : null;

  if (groq && gemini) {
    return createFallbackProvider({
      primary: groq,
      fallback: gemini,
      onFallback: ({ from, to, reason }) => {
        console.warn(`[AI] Primary provider '${from}' failed (${reason.code}: ${reason.message}). Falling back to '${to}'.`);
      },
    });
  }
  return groq || gemini;
}

/** @returns {{ config: object, service: object }} */
function getAiRuntime() {
  if (runtime) return runtime;
  const config = loadAiConfig();
  const provider = buildProvider(config);
  const limiter = createRateLimiter({ perMinute: config.perMinute, perDay: config.perDay, maxConcurrent: config.maxConcurrent });
  runtime = Object.freeze({ config, service: createAiService({ config, provider, traceStore, limiter }) });
  return runtime;
}

module.exports = { traceStore, getAiRuntime, buildProvider };

