const { AiError } = require("../services/ai/aiError");
const { publicStatus } = require("../services/ai/aiConfig");
const { disabledMessage } = require("../services/ai/aiService");
const { validateAskRequest } = require("../utils/validateAiRequest");

/**
 * @param {{ getRuntime: () => { config: object, service: { ask: Function } } }} dependencies
 */
function createAiController({ getRuntime }) {
  /** GET /api/ai/status — lets the UI show a setup hint instead of a dead button. Never carries the key. */
  function status(req, res) {
    const { config } = getRuntime();
    res.set("Cache-Control", "no-store");
    return res.status(200).json({ ...publicStatus(config), message: config.enabled ? null : disabledMessage(config.reason) });
  }

  /** POST /api/ai/ask — provider and limit problems are typed errors with safe wording; the detail only reaches the log. */
  async function ask(req, res) {
    const validated = validateAskRequest(req.body);
    if (!validated.ok) return res.status(400).json({ error: validated.error, code: "BAD_REQUEST" });
    const cancelled = new AbortController();
    res.on("close", () => { if (!res.writableEnded) cancelled.abort(); }); // the browser gave up: stop paying for the answer
    try {
      const answer = await getRuntime().service.ask({ ...validated.value, caller: req.ip ?? "local", signal: cancelled.signal });
      res.set("Cache-Control", "no-store");
      return res.status(200).json(answer);
    } catch (error) {
      if (cancelled.signal.aborted) return undefined;
      if (error instanceof AiError) {
        if (error.detail) console.error(`AI error ${error.code}:`, error.detail);
        if (error.retryAfterSec) res.set("Retry-After", String(error.retryAfterSec));
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error("AI unexpected error:", error);
      return res.status(500).json({ error: "The assistant failed unexpectedly", code: "INTERNAL" });
    }
  }

  return { status, ask };
}

module.exports = { createAiController };
