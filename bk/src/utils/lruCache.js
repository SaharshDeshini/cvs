// A small least-recently-used cache with an optional time-to-live. Used for the traces the assistant may talk about and for
// finished explanations. Entries are never mutated here; callers store values they will not change.
/**
 * @template V
 * @param {{ max: number, ttlMs?: number, now?: () => number }} options
 */
function createLruCache({ max, ttlMs = Infinity, now = Date.now }) {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be a positive integer");
  const entries = new Map(); // insertion order = recency order

  const isExpired = (entry) => now() - entry.storedAt > ttlMs;

  return {
    /** @returns {V | undefined} */
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      if (isExpired(entry)) return undefined;
      entries.set(key, entry); // re-insert: now the most recent
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, storedAt: now() });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    delete(key) {
      return entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}

module.exports = { createLruCache };
