// Reads the AI settings from the environment once. Supports Groq (preferred) with Google Gemini as fallback.
// The assistant is OFF unless at least one valid API key is present, and OFF when the server is
// shared with other devices (no login there, so anyone on the network could spend the key) unless AI_ALLOW_SHARE=1.
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash"; // listed with a free tier on the pricing page (2026-10-13); override with GEMINI_MODEL
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"; // standard fast Groq model with generous limits; override with GROQ_MODEL
const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  maxOutputTokens: 2048,
  perMinute: 8, // under the free tier cap
  perDay: 150,
  maxConcurrent: 2,
});

function intFrom(env, name, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function isHttpUrl(text) {
  try {
    return ["http:", "https:"].includes(new URL(text).protocol);
  } catch {
    return false;
  }
}

function disabledReason(env, groqConfig, geminiConfig) {
  if (env.AI_ENABLED === "0") return "turned_off";
  const hasGroq = Boolean(groqConfig.apiKey);
  const hasGemini = Boolean(geminiConfig.apiKey);
  if (!hasGroq && !hasGemini) return "no_key";
  if (hasGroq && !isHttpUrl(groqConfig.baseUrl)) return "bad_config";
  if (hasGemini && !isHttpUrl(geminiConfig.baseUrl)) return "bad_config";
  if (!LOOPBACK_HOSTS.has(env.HOST || "127.0.0.1") && env.AI_ALLOW_SHARE !== "1") return "share_mode";
  return null;
}

/** @param {Record<string, string | undefined>} [env] */
function loadAiConfig(env = process.env) {
  const groqApiKey = (env.GROQ_API_KEY || "").trim();
  const groqBaseUrl = (env.GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL).trim().replace(/\/+$/, "");
  const groqModel = (env.GROQ_MODEL || DEFAULT_GROQ_MODEL).trim();

  const geminiApiKey = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim();
  const geminiBaseUrl = (env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL).trim().replace(/\/+$/, "");
  const geminiModel = (env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();

  const groqConfig = { apiKey: groqApiKey, baseUrl: groqBaseUrl, model: groqModel };
  const geminiConfig = { apiKey: geminiApiKey, baseUrl: geminiBaseUrl, model: geminiModel };

  const reason = disabledReason(env, groqConfig, geminiConfig);

  let provider = "none";
  let primaryModel = geminiModel;
  if (groqApiKey && geminiApiKey) {
    provider = "groq+gemini";
    primaryModel = groqModel;
  } else if (groqApiKey) {
    provider = "groq";
    primaryModel = groqModel;
  } else if (geminiApiKey) {
    provider = "gemini";
    primaryModel = geminiModel;
  }

  return Object.freeze({
    enabled: reason === null,
    reason,
    provider,
    model: primaryModel,
    groq: {
      enabled: Boolean(groqApiKey) && reason === null,
      apiKey: groqApiKey,
      baseUrl: groqBaseUrl,
      model: groqModel,
    },
    gemini: {
      enabled: Boolean(geminiApiKey) && reason === null,
      apiKey: geminiApiKey,
      baseUrl: geminiBaseUrl,
      model: geminiModel,
    },
    // Backwards compatibility properties:
    apiKey: geminiApiKey || groqApiKey,
    baseUrl: geminiBaseUrl,
    timeoutMs: intFrom(env, "AI_TIMEOUT_MS", DEFAULTS.timeoutMs, { min: 1000, max: 120_000 }),
    maxOutputTokens: intFrom(env, "AI_MAX_OUTPUT_TOKENS", DEFAULTS.maxOutputTokens, { min: 256, max: 8192 }),
    perMinute: intFrom(env, "AI_RATE_PER_MINUTE", DEFAULTS.perMinute, { max: 600 }),
    perDay: intFrom(env, "AI_DAILY_LIMIT", DEFAULTS.perDay, { max: 100_000 }),
    maxConcurrent: intFrom(env, "AI_MAX_CONCURRENT", DEFAULTS.maxConcurrent, { max: 16 }),
  });
}

/** What GET /api/ai/status may say: never the key, never the base URL. */
function publicStatus(config) {
  return { enabled: config.enabled, reason: config.reason, provider: config.provider, model: config.model };
}

module.exports = {
  loadAiConfig,
  publicStatus,
  DEFAULT_MODEL: DEFAULT_GEMINI_MODEL,
  DEFAULT_BASE_URL: DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_GROQ_BASE_URL,
};

