const { LIMITS } = require("./limits");

/**
 * Validates the body of POST /api/trace. Never throws.
 * @param {unknown} body
 * @returns {{ ok: true, value: { code: string, stdin: string } } | { ok: false, error: string }}
 */
function validateTraceRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const { code, stdin = "" } = body;
  if (typeof code !== "string" || code.length === 0) {
    return { ok: false, error: "code must be a non-empty string" };
  }
  if (code.includes("\u0000")) {
    return { ok: false, error: "code must not contain NUL characters" };
  }
  if (Buffer.byteLength(code, "utf8") > LIMITS.maxCodeBytes) {
    return { ok: false, error: `code exceeds ${LIMITS.maxCodeBytes} bytes` };
  }
  if (typeof stdin !== "string") {
    return { ok: false, error: "stdin must be a string" };
  }
  if (stdin.includes("\u0000")) {
    return { ok: false, error: "stdin must not contain NUL characters" };
  }
  if (Buffer.byteLength(stdin, "utf8") > LIMITS.maxStdinBytes) {
    return { ok: false, error: `stdin exceeds ${LIMITS.maxStdinBytes} bytes` };
  }
  return { ok: true, value: { code, stdin } };
}

module.exports = { validateTraceRequest };
