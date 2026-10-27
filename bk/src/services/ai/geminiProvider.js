// Talks to Google's Gemini API (models/{model}:generateContent, classic REST shape). One call in, one answer out: no tool loop,
// because free-tier request quotas make a 3-call question three times as expensive (D-038).
//
// The API key travels in the `x-goog-api-key` header, never in the URL, so it cannot end up in a log line or an error message.
// Provider failures become AiError with wording that is safe to show; the provider's own text goes to `detail` for the server log.
const { AiError } = require("./aiError");

const RETRY_STATUSES = new Set([500, 502, 503, 504]);
const KEY_PROBLEM = /api key|permission_denied|unauthenticated|permission denied/i;
const BLOCKING_FINISH = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"]);
const RETRY_BASE_MS = 800;
const DETAIL_LIMIT = 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (text, max) => (typeof text === "string" ? text.slice(0, max) : "");

function requestBody({ system, messages, maxOutputTokens, temperature }) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.text }] })),
    generationConfig: { maxOutputTokens, temperature },
  };
}

async function readErrorBody(response) {
  const body = await response.json().catch(() => null);
  const error = body && typeof body === "object" ? body.error : null;
  return { status: clip(error?.status ?? error?.code, 80), message: clip(error?.message, DETAIL_LIMIT) };
}

/** Maps a non-2xx answer to an AiError (or returns null when the status is worth retrying). */
function errorForResponse(response, { status, message }) {
  const detail = `HTTP ${response.status} ${status} ${message}`.trim();
  if (response.status === 429) {
    return new AiError("PROVIDER_RATE_LIMITED", "The AI service is rate limiting this key. Wait a minute and ask again.", { detail });
  }
  if (response.status === 401 || response.status === 403 || (response.status === 400 && KEY_PROBLEM.test(`${status} ${message}`))) {
    return new AiError("KEY_REJECTED", "The AI service rejected the API key. Check GEMINI_API_KEY in bk/.env and restart the server.", { detail });
  }
  if (response.status === 404) {
    return new AiError("MODEL_NOT_FOUND", "The AI model was not found. Check GEMINI_MODEL in bk/.env.", { detail });
  }
  if (RETRY_STATUSES.has(response.status)) return null;
  return new AiError("PROVIDER_ERROR", "The AI service could not handle this request.", { detail });
}

function usageFrom(body) {
  const usage = body.usageMetadata ?? {};
  return { promptTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null, totalTokens: usage.totalTokenCount ?? null };
}

/** Joins the visible text parts. Parts marked `thought` are the model's reasoning summary and are never shown. */
function parseAnswer(body) {
  const candidate = Array.isArray(body?.candidates) ? body.candidates[0] : undefined;
  if (!candidate) {
    const reason = body?.promptFeedback?.blockReason;
    if (reason) throw new AiError("BLOCKED", "The AI service declined to answer this request.", { detail: `blockReason ${reason}` });
    throw new AiError("EMPTY_ANSWER", "The AI service sent no answer. Try again.", { detail: "no candidates" });
  }
  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  const text = parts.filter((part) => typeof part?.text === "string" && part.thought !== true).map((part) => part.text).join("").trim();
  const finishReason = typeof candidate.finishReason === "string" ? candidate.finishReason : null;
  if (text === "") {
    if (finishReason && BLOCKING_FINISH.has(finishReason)) throw new AiError("BLOCKED", "The AI service declined to answer this request.", { detail: `finishReason ${finishReason}` });
    throw new AiError("EMPTY_ANSWER", "The AI service sent an empty answer. Try again.", { detail: `finishReason ${finishReason}` });
  }
  return { text, finishReason, truncated: finishReason === "MAX_TOKENS", usage: usageFrom(body) };
}

/**
 * @param {{ apiKey: string, model: string, baseUrl: string, timeoutMs: number, maxOutputTokens: number,
 *   maxRetries?: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} options
 */
function createGeminiProvider({ apiKey, model, baseUrl, timeoutMs, maxOutputTokens, maxRetries = 2, fetchImpl = globalThis.fetch, sleep = defaultSleep }) {
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

  async function attempt(body, signal) {
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (error) {
      if (signal?.aborted) throw error; // the caller cancelled: not a provider failure
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new AiError("TIMEOUT", "The AI service took too long to answer. Try again.", { detail: "request timed out" });
      }
      return { networkError: clip(String(error?.message ?? error), DETAIL_LIMIT) };
    }
  }

  /**
   * @param {{ system: string, messages: { role: "user" | "assistant", text: string }[], temperature?: number, signal?: AbortSignal }} request
   * @returns {Promise<{ text: string, finishReason: string | null, truncated: boolean, usage: object }>}
   */
  async function generateUnredacted({ system, messages, temperature = 0.3, signal }) {
    const body = requestBody({ system, messages, maxOutputTokens, temperature });
    let lastDetail = "";
    for (let tries = 0; tries <= maxRetries; tries += 1) {
      if (tries > 0) await sleep(RETRY_BASE_MS * 2 ** (tries - 1));
      const response = await attempt(body, signal);
      if (response.networkError !== undefined) {
        lastDetail = `network: ${response.networkError}`;
        continue;
      }
      if (response.ok) {
        const parsed = parseAnswer(await response.json().catch(() => null));
        return { ...parsed, model };
      }
      const failure = await readErrorBody(response);
      const error = errorForResponse(response, failure);
      if (error) throw error;
      lastDetail = `HTTP ${response.status} ${failure.status} ${failure.message}`.trim();
    }
    throw new AiError("PROVIDER_UNAVAILABLE", "The AI service is unavailable right now. Try again in a moment.", { detail: lastDetail });
  }

  /** Whatever the provider (or the network layer) wrote into an error, the key never leaves this module: `detail` goes to the server log. */
  async function generate(request) {
    try {
      return await generateUnredacted(request);
    } catch (error) {
      if (error instanceof AiError && typeof error.detail === "string") error.detail = error.detail.split(apiKey).join("[redacted]");
      throw error;
    }
  }

  return Object.freeze({ name: "gemini", model, generate });
}

module.exports = { createGeminiProvider };
