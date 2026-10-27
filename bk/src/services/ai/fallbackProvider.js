// Wraps a primary provider (e.g. Groq) and a fallback provider (e.g. Gemini).
// Tries primary first. If primary fails with an error indicating unavailability or transient breakdown
// (or if primary is unavailable/failing), falls back to secondary provider.
// If the caller cancelled (AbortSignal), that is never treated as a provider failure.
const { AiError } = require("./aiError");

// Error codes that indicate the provider is down, busy, rate-limited, unreachable, or has an invalid model/key
const FALLBACK_ERROR_CODES = new Set([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_ERROR",
  "TIMEOUT",
  "EMPTY_ANSWER",
  "MODEL_NOT_FOUND",
  "KEY_REJECTED",
]);

function createFallbackProvider({ primary, fallback, onFallback }) {
  if (!fallback) return primary;
  if (!primary) return fallback;

  let currentModel = primary.model;

  async function generate(request) {
    try {
      const result = await primary.generate(request);
      currentModel = primary.model;
      return result;
    } catch (error) {
      if (request.signal?.aborted) throw error;
      const isFallbackable = error instanceof AiError && FALLBACK_ERROR_CODES.has(error.code);
      if (!isFallbackable) {
        throw error;
      }

      if (typeof onFallback === "function") {
        onFallback({ from: primary.name, to: fallback.name, reason: error });
      }

      try {
        const fallbackResult = await fallback.generate(request);
        currentModel = fallback.model;
        return fallbackResult;
      } catch (fallbackError) {
        // If fallback also fails, throw the fallback error (or primary if more descriptive)
        throw fallbackError;
      }
    }
  }

  return Object.freeze({
    name: "fallback",
    get model() {
      return currentModel;
    },
    generate,
    primary,
    fallback,
  });
}

module.exports = { createFallbackProvider, FALLBACK_ERROR_CODES };
