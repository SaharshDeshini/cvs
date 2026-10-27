// Client for GET /api/ai/status and POST /api/ai/ask. The browser sends a question and a run id, never the run itself: the
// backend holds the verified trace. Failures are typed (`code`) so the panel can say something useful for each.
import { API_BASE } from "./api";

const REQUEST_TIMEOUT_MS = 45_000; // the server waits up to 30 s for the model, plus retries
const STATUS_TIMEOUT_MS = 8_000;
const MAX_FINDINGS = 20;
const TITLE_CHARS = 200;
const DETAIL_CHARS = 600;

export class AiApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AiApiError";
    this.code = code;
  }
}

const FALLBACK_MESSAGES = Object.freeze({
  400: "The assistant could not understand that request.",
  410: "The assistant no longer has this run. Press Run again.",
  429: "Too many questions. Wait a moment and ask again.",
  503: "The assistant is not available right now.",
});

const clip = (text, max) => String(text ?? "").slice(0, max);

/** What the panel needs to know before it shows anything: is the assistant on, and if not, how to switch it on. */
export async function fetchAiStatus(signal) {
  try {
    const response = await fetch(`${API_BASE}/api/ai/status`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)]) : AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.enabled !== "boolean") return { phase: "unreachable", enabled: false, reason: "unreachable", message: "The backend did not answer. Is it running?", model: null };
    return { phase: "ready", enabled: body.enabled, reason: body.reason ?? null, message: typeof body.message === "string" ? body.message : null, model: typeof body.model === "string" ? body.model : null };
  } catch (error) {
    if (error?.name === "AbortError" && signal?.aborted) throw error;
    return { phase: "unreachable", enabled: false, reason: "unreachable", message: "Cannot reach the backend. Is it running?", model: null };
  }
}

/** The bug spotlight's findings, trimmed to what the server accepts: they are hints to the model, not facts it relies on. */
export function findingsPayload(bugs) {
  return bugs.slice(0, MAX_FINDINGS).map((bug) => ({
    step: bug.step, kind: clip(bug.kind, 24), severity: bug.severity === "bad" ? "bad" : "warn", line: bug.line, title: clip(bug.title, TITLE_CHARS), detail: clip(bug.detail, DETAIL_CHARS),
  }));
}

function parseAnswer(body) {
  if (typeof body?.answer !== "string" || body.answer.trim() === "") throw new AiApiError("The assistant sent an answer this app does not understand.", "BAD_RESPONSE");
  const verification = body.verification ?? {};
  return {
    answer: body.answer,
    step: Number.isInteger(body.step) ? body.step : null,
    citations: Array.isArray(body.citations) ? body.citations.filter(Number.isInteger) : [],
    verification: {
      invalidCitations: Number.isInteger(verification.invalidCitations) ? verification.invalidCitations : 0,
      unverifiedValues: Array.isArray(verification.unverifiedValues) ? verification.unverifiedValues.filter((value) => typeof value === "string").slice(0, 8) : [],
    },
    cached: body.cached === true,
    truncated: body.truncated === true,
    model: typeof body.model === "string" ? body.model : null,
  };
}

/**
 * @param {{ traceId: string, kind: "step" | "error" | "chat", step: number | null, message: string, level: string,
 *   history: { role: string, text: string }[], findings: object[] }} request
 * @param {AbortSignal} [signal]
 */
export async function askAssistant(request, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API_BASE}/api/ai/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error?.name === "TimeoutError") throw new AiApiError("The assistant took too long to answer. Try again.", "TIMEOUT");
    throw new AiApiError("Cannot reach the backend. Is it running?", "UNREACHABLE");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : (FALLBACK_MESSAGES[response.status] ?? `The server answered ${response.status}.`);
    throw new AiApiError(message, typeof body?.code === "string" ? body.code : `HTTP_${response.status}`);
  }
  return parseAnswer(body);
}
