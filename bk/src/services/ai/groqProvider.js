// Talks to Groq's OpenAI-compatible chat completions API (https://api.groq.com/openai/v1/chat/completions).
// Provider failures become AiError with wording that is safe to show; the provider's own text goes to `detail` for the server log.
const { AiError } = require("./aiError");

const RETRY_STATUSES = new Set([500, 502, 503, 504]);
const KEY_PROBLEM = /api key|invalid_api_key|unauthorized|permission_denied|unauthenticated/i;
const RETRY_BASE_MS = 800;
const DETAIL_LIMIT = 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (text, max) => (typeof text === "string" ? text.slice(0, max) : "");

function requestBody({ system, messages, maxOutputTokens, temperature, model }) {
  const formattedMessages = [
    { role: "system", content: system },
    ...messages.map((m) => ({
      role: m.role === "model" || m.role === "assistant" ? "assistant" : "user",
      content: m.text,
    })),
  ];
  return {
    model,
    messages: formattedMessages,
    max_tokens: maxOutputTokens,
    temperature,
  };
}

async function readErrorBody(response) {
  const body = await response.json().catch(() => null);
  const error = body && typeof body === "object" ? body.error : null;
  return {
    status: clip(error?.code ?? error?.type, 80),
    message: clip(error?.message, DETAIL_LIMIT),
  };
}

/** Maps a non-2xx answer to an AiError (or returns null when the status is worth retrying). */
function errorForResponse(response, { status, message }) {
  const detail = `HTTP ${response.status} ${status} ${message}`.trim();
  if (response.status === 429) {
    return new AiError("PROVIDER_RATE_LIMITED", "The AI service is rate limiting this key. Wait a minute and ask again.", { detail });
  }
  if (response.status === 401 || response.status === 403 || (response.status === 400 && KEY_PROBLEM.test(`${status} ${message}`))) {
    return new AiError("KEY_REJECTED", "The AI service rejected the API key. Check GROQ_API_KEY in bk/.env and restart the server.", { detail });
  }
  if (response.status === 404) {
    return new AiError("MODEL_NOT_FOUND", "The AI model was not found. Check GROQ_MODEL in bk/.env.", { detail });
  }
  if (RETRY_STATUSES.has(response.status)) return null;
  return new AiError("PROVIDER_ERROR", "The AI service could not handle this request.", { detail });
}

function usageFrom(body) {
  const usage = body?.usage ?? {};
  return {
    promptTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
  };
}

function parseAnswer(body) {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  if (!choice) {
    throw new AiError("EMPTY_ANSWER", "The AI service sent no answer. Try again.", { detail: "no choices" });
  }
  const text = typeof choice.message?.content === "string" ? choice.message.content.trim() : "";
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
  if (text === "") {
    if (finishReason === "content_filter") {
      throw new AiError("BLOCKED", "The AI service declined to answer this request.", { detail: "finish_reason content_filter" });
    }
    throw new AiError("EMPTY_ANSWER", "The AI service sent an empty answer. Try again.", { detail: `finish_reason ${finishReason}` });
  }
  return { text, finishReason, truncated: finishReason === "length", usage: usageFrom(body) };
}

/**
 * @param {{ apiKey: string, model: string, baseUrl: string, timeoutMs: number, maxOutputTokens: number,
 *   maxRetries?: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} options
 */
function createGroqProvider({ apiKey, model, baseUrl, timeoutMs, maxOutputTokens, maxRetries = 2, fetchImpl = globalThis.fetch, sleep = defaultSleep }) {
  const url = `${baseUrl}/chat/completions`;

  async function attempt(body, signal) {
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new AiError("TIMEOUT", "The AI service took too long to answer. Try again.", { detail: "request timed out" });
      }
      return { networkError: clip(String(error?.message ?? error), DETAIL_LIMIT) };
    }
  }

  async function generateUnredacted({ system, messages, temperature = 0.3, signal }) {
    const body = requestBody({ system, messages, maxOutputTokens, temperature, model });
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

  async function generate(request) {
    try {
      return await generateUnredacted(request);
    } catch (error) {
      if (error instanceof AiError && typeof error.detail === "string") {
        error.detail = error.detail.split(apiKey).join("[redacted]");
      }
      throw error;
    }
  }

  return Object.freeze({ name: "groq", model, generate });
}

module.exports = { createGroqProvider };
