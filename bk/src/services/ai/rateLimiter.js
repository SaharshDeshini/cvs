// Protects the API key (and the free-tier quota) from a runaway client or a shared server: a sliding window per caller, a daily
// cap for the whole process, and a limit on requests in flight. `acquire` either returns a `release` function or throws RATE_LIMITED.
const { AiError } = require("./aiError");

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MAX_TRACKED_CALLERS = 500;

/**
 * @param {{ perMinute: number, perDay: number, maxConcurrent: number, now?: () => number }} options
 */
function createRateLimiter({ perMinute, perDay, maxConcurrent, now = Date.now }) {
  const recentByCaller = new Map(); // caller -> timestamps within the last minute
  let dayStart = now();
  let usedToday = 0;
  let inFlight = 0;

  const refuse = (message, retryAfterMs) => {
    throw new AiError("RATE_LIMITED", message, { retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) });
  };

  function rollDay(at) {
    if (at - dayStart >= DAY_MS) {
      dayStart = at;
      usedToday = 0;
    }
  }

  function recentFor(caller, at) {
    const fresh = (recentByCaller.get(caller) ?? []).filter((stamp) => at - stamp < MINUTE_MS);
    if (fresh.length === 0) recentByCaller.delete(caller);
    else recentByCaller.set(caller, fresh);
    while (recentByCaller.size > MAX_TRACKED_CALLERS) recentByCaller.delete(recentByCaller.keys().next().value);
    return fresh;
  }

  return {
    /** @returns {() => void} release: call exactly once when the request is finished (extra calls are ignored) */
    acquire(caller) {
      const at = now();
      rollDay(at);
      if (usedToday >= perDay) refuse("The daily AI question limit is used up. It resets in 24 hours.", dayStart + DAY_MS - at);
      if (inFlight >= maxConcurrent) refuse("The assistant is busy with another question. Try again in a few seconds.", 3000);
      const recent = recentFor(caller, at);
      if (recent.length >= perMinute) refuse("Too many questions in a minute. Wait a little and ask again.", recent[0] + MINUTE_MS - at);
      recentByCaller.set(caller, [...recent, at]);
      usedToday += 1;
      inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
      };
    },
    get inFlight() {
      return inFlight;
    },
  };
}

module.exports = { createRateLimiter };
