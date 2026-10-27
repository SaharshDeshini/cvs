// Remembers the runs this server traced, so the assistant only ever talks about data the SERVER produced: the browser sends a
// `traceId`, never trace content (it cannot feed the model a forged run). Bounded by count and age; an evicted or restarted
// run is simply asked about no more ("Run again"). The trace and code are never changed; the only write is the decoded `views`,
// filled in once on the first question about a run.
const crypto = require("node:crypto");
const { createLruCache } = require("../../utils/lruCache");
const { decodeTrace } = require("./traceDecoder");

const DEFAULT_MAX_RUNS = 8; // a trace is at most 5 MB (LIMITS.maxTraceBytes), usually well under 1 MB
const DEFAULT_TTL_MS = 60 * 60_000;
const ID_PATTERN = /^[0-9a-f]{32}$/;

/** @param {{ max?: number, ttlMs?: number, now?: () => number }} [options] */
function createTraceStore({ max = DEFAULT_MAX_RUNS, ttlMs = DEFAULT_TTL_MS, now } = {}) {
  const runs = createLruCache({ max, ttlMs, now });
  return {
    /** @returns {string} the id the browser uses to ask about this run */
    put({ code, stdin, trace }) {
      const id = crypto.randomBytes(16).toString("hex");
      runs.set(id, { code, stdin, trace, views: null });
      return id;
    },
    /** @returns {{ code: string, stdin: string, trace: object, views: object[] } | undefined} */
    get(id) {
      if (typeof id !== "string" || !ID_PATTERN.test(id)) return undefined;
      const run = runs.get(id);
      if (run === undefined) return undefined;
      if (run.views === null) run.views = decodeTrace(run.trace); // decoded on first question, not on every run
      return run;
    },
    get size() {
      return runs.size;
    },
  };
}

module.exports = { createTraceStore, ID_PATTERN };
