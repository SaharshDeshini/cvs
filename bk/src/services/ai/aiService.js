// One question in, one verified answer out. Order matters: refuse early (off / unknown run / bad step), serve a cached
// explanation for free, otherwise spend a rate-limit slot, build the context from the SERVER's copy of the run, ask the model once,
// then check the answer against the same facts before it reaches the browser.
const crypto = require("node:crypto");
const { AiError } = require("./aiError");
const { buildContext, snapshotText, globalFactText } = require("./contextBuilder");
const { SYSTEM_PROMPT, PROMPT_VERSION, STEP_ASK, errorAsk, userTurn } = require("./prompts");
const { verifyAnswer } = require("./answerVerifier");
const { createLruCache } = require("../../utils/lruCache");

const CACHE_MAX = 200;
const CACHE_TTL_MS = 60 * 60_000;

const DISABLED_MESSAGES = Object.freeze({
  no_key: "The AI assistant is not set up yet. Add GROQ_API_KEY or GEMINI_API_KEY to bk/.env and restart the server.",
  share_mode: "The AI assistant is off while the server is shared with other devices. Set AI_ALLOW_SHARE=1 in bk/.env to allow it.",
  turned_off: "The AI assistant is turned off (AI_ENABLED=0).",
  bad_config: "The AI settings are invalid. Check GROQ_BASE_URL or GEMINI_BASE_URL in bk/.env.",
});
const disabledMessage = (reason) => DISABLED_MESSAGES[reason] ?? "The AI assistant is not available.";

/** Which step the question is about: null when the run has no steps (a program that did not compile). */
function resolveFocus(run, kind, step) {
  const total = run.views.length;
  if (step !== null && step >= total) throw new AiError("BAD_REQUEST", `step ${step} is outside this run (0 to ${Math.max(total - 1, 0)}).`);
  if (kind === "step" && total === 0) throw new AiError("BAD_REQUEST", "This run has no steps to explain.");
  if (step !== null) return step;
  return kind === "error" && total > 0 ? total - 1 : null; // an error question defaults to where the run ended
}

const cacheKey = ({ traceId, kind, focus, level, findings }) => {
  const seen = crypto.createHash("sha1").update(JSON.stringify(findings)).digest("hex").slice(0, 12);
  return [traceId, kind, focus, level, seen, PROMPT_VERSION].join(":");
};

function questionFor(kind, message, run) {
  if (kind === "step") return STEP_ASK;
  if (kind === "error") return errorAsk(run.trace.status);
  return message;
}

/**
 * @param {{ config: object, provider: object | null, traceStore: object, limiter: object, cache?: object }} dependencies
 */
function createAiService({ config, provider, traceStore, limiter, cache = createLruCache({ max: CACHE_MAX, ttlMs: CACHE_TTL_MS }) }) {
  async function ask({ traceId, kind, step, message, level, history, findings, caller, signal }) {
    if (!config.enabled || !provider) throw new AiError("AI_DISABLED", disabledMessage(config.reason));
    const run = traceStore.get(traceId);
    if (!run) throw new AiError("TRACE_NOT_FOUND", "The assistant no longer has this run (the server restarted or the run is old). Press Run again.");
    const focus = resolveFocus(run, kind, step);

    const cacheable = kind !== "chat";
    const key = cacheKey({ traceId, kind, focus, level, findings });
    const hit = cacheable ? cache.get(key) : undefined;
    if (hit) return { ...hit, cached: true };

    const release = limiter.acquire(caller);
    try {
      const context = buildContext(run, { step: focus, findings });
      const turn = userTurn({ context, question: questionFor(kind, message, run), level });
      const result = await provider.generate({ system: SYSTEM_PROMPT, messages: [...history, { role: "user", text: turn }], signal });
      const checked = verifyAnswer(result.text, {
        totalSteps: run.views.length,
        focusStep: focus,
        factsForStep: (index) => snapshotText(run, index),
        globalFacts: globalFactText(run, findings),
      });
      const answer = {
        kind, step: focus, answer: checked.text, citations: checked.citations, truncated: result.truncated, model: result.model || provider.model, usage: result.usage,
        verification: { invalidCitations: checked.invalidCitations, unverifiedValues: checked.unverifiedValues },
      };
      if (cacheable && !result.truncated) cache.set(key, answer);
      return { ...answer, cached: false };
    } finally {
      release();
    }
  }

  return Object.freeze({ ask });
}

module.exports = { createAiService, disabledMessage };
