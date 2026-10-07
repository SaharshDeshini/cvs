const runnerService = require("../services/runnerService"); // module object: tests stub runTrace
const { buildTrace } = require("../services/traceProcessor");
const { validateTraceRequest } = require("../utils/validateRequest");

const RUNNER_ERROR_STATUS = Object.freeze({
  BUSY: 429,
  RUNNER_UNAVAILABLE: 503,
  RUNNER_FAILED: 502,
});

/** POST /api/trace — compile errors and crashes are results (HTTP 200), not server errors. */
async function createTrace(req, res) {
  const validated = validateTraceRequest(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }
  try {
    const raw = await runnerService.runTrace(validated.value);
    return res.status(200).json(buildTrace(raw));
  } catch (error) {
    if (error instanceof runnerService.RunnerError) {
      if (error.detail) console.error(`Runner error ${error.code}:`, error.detail); // detail never reaches the client
      return res.status(RUNNER_ERROR_STATUS[error.code] || 500).json({ error: error.message, code: error.code });
    }
    console.error("Trace error:", error);
    return res.status(500).json({ error: "Failed to trace the program" });
  }
}

module.exports = { createTrace };
