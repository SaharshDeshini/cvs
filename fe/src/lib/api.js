// Client for POST /api/trace. Program outcomes (compile error, crash, timeout) are HTTP 200 *results*;
// only transport/validation/runner problems throw, with a message that is safe to show.
import { normalizeTrace } from "./normalize";

const API_BASE = import.meta.env?.VITE_API_URL ?? "http://localhost:5000";
const REQUEST_TIMEOUT_MS = 75_000; // server wall clock is 60 s

export class ApiError extends Error {}

const STATUS_MESSAGES = Object.freeze({
  400: "The request was rejected as invalid.",
  413: "The program is too large.",
  429: "The runner is busy. Try again in a moment.",
  502: "The code runner failed. Try again.",
  503: "The code runner is unavailable. Is Docker running?",
});

/**
 * @param {{ code: string, stdin?: string }} request
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} trace schema 1
 */
export async function requestTrace(request, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API_BASE}/api/trace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error?.name === "TimeoutError") throw new ApiError("The server took too long to answer.");
    throw new ApiError(`Cannot reach the backend at ${API_BASE}. Is it running?`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = response.status === 400 && typeof body?.error === "string" ? ` ${body.error}.` : "";
    throw new ApiError((STATUS_MESSAGES[response.status] ?? `The server answered ${response.status}.`) + detail);
  }
  if (body?.schema !== 1 || !Array.isArray(body.steps)) {
    throw new ApiError("The server sent a trace this app does not understand.");
  }
  return normalizeTrace(body);
}
