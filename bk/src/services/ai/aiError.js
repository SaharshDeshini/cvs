// One error type for everything the AI layer can refuse or fail at. `code` picks the HTTP status and the client wording;
// `message` is always safe to show; `detail` (provider body, never the API key) is for the server log only.
const HTTP_STATUS = Object.freeze({
  BAD_REQUEST: 400,
  AI_DISABLED: 503,
  KEY_REJECTED: 503,
  TRACE_NOT_FOUND: 410,
  RATE_LIMITED: 429,
  PROVIDER_RATE_LIMITED: 429,
  MODEL_NOT_FOUND: 503,
  PROVIDER_UNAVAILABLE: 502,
  PROVIDER_ERROR: 502,
  TIMEOUT: 504,
  BLOCKED: 422,
  EMPTY_ANSWER: 502,
});

class AiError extends Error {
  /**
   * @param {keyof typeof HTTP_STATUS} code
   * @param {string} message safe to show to the user
   * @param {{ detail?: string, retryAfterSec?: number }} [options]
   */
  constructor(code, message, { detail, retryAfterSec } = {}) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.status = HTTP_STATUS[code] ?? 500;
    this.detail = detail;
    this.retryAfterSec = retryAfterSec;
  }
}

module.exports = { AiError, HTTP_STATUS };
