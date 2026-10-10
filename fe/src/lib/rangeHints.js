// Which part of an array is "live"? INFERENCE, not a fact from the trace: two int locals whose NAMES look like the ends of a
// range (lo/hi, left/right, l/r, start/end...) and whose values are positions in the array. A `mid` next to them means a
// binary-search-style narrowing, so the cells outside the range are dimmed; without one it is a sliding window, so the range is
// highlighted and nothing is dimmed. The UI says "guessed from names" wherever it shows this.

// [first end, second end, second end is one past the last cell, always a search (these names only ever bound a search)]
export const RANGE_PAIRS = Object.freeze([
  ["lo", "hi", false, true],
  ["low", "high", false, true],
  ["left", "right", false, false],
  ["l", "r", false, false],
  ["start", "end", true, false],
  ["begin", "end", true, false],
  ["first", "last", false, true],
]);
// `m` is deliberately not here: it is far too common (a matrix size, a count) to mean a midpoint.
export const MID_NAMES = Object.freeze(["mid", "middle"]);

/** Does this frame declare a midpoint at all? Callers scan the whole trace with this, because `mid` lives inside the loop
 *  and is out of scope between iterations: deciding from a single step makes the array flip between search and window. */
export function declaresMid(vars) {
  return MID_NAMES.some((name) => Object.hasOwn(vars, name));
}

function intValue(vars, name) {
  if (!Object.hasOwn(vars, name)) return null;
  const entry = vars[name];
  if (entry.kind !== "int") return null;
  const value = Number(entry.value);
  return Number.isInteger(value) ? value : null;
}

/** The live range as inclusive cell indexes, or null when the names and numbers do not describe one in this array. */
function pairRange(vars, length) {
  for (const [first, second, exclusive, alwaysSearch] of RANGE_PAIRS) {
    const lo = intValue(vars, first);
    const end = intValue(vars, second);
    if (lo === null || end === null) continue;
    const hi = exclusive || end === length ? end - 1 : end; // an inclusive end cannot equal the length: that is exclusive
    if (lo < 0 || lo > length || hi < -1 || hi > length - 1) return null;
    return { lo, hi, alwaysSearch, names: { lo: first, hi: second, mid: null } };
  }
  return null;
}

/**
 * @param {Record<string, object>} vars the frame's variables (trace entries)
 * @param {number} length the array's length
 * @param {{ searchHint?: boolean }} [options] `searchHint`: this function has a midpoint somewhere in the run (see declaresMid),
 *   so the ambiguous names (left/right, l/r, start/end) are a search on every step, including those where `mid` is out of scope
 * @returns {{ mode: "search"|"window", lo: number, hi: number, mid: number|null, empty: boolean, names: object } | null}
 */
export function detectRange(vars, length, { searchHint = false } = {}) {
  const range = pairRange(vars, length);
  if (range === null) return null;
  const midName = MID_NAMES.find((name) => intValue(vars, name) !== null);
  const midValue = midName === undefined ? null : intValue(vars, midName);
  const mid = midValue !== null && midValue >= 0 && midValue < length ? midValue : null;
  // mid is declared inside the loop, so it is out of scope between iterations: lo/hi stay a search regardless
  const mode = range.alwaysSearch || searchHint || midName !== undefined ? "search" : "window";
  const empty = range.lo > range.hi;
  if (mode === "window" && empty) return null;
  return { mode, lo: range.lo, hi: range.hi, mid, empty, names: { ...range.names, mid: midName ?? null } };
}

/** One line for the array's caption: the range, in words. */
export function describeRange(range) {
  if (range.mode === "search") {
    return range.empty ? "search range empty" : `search range [${range.lo}..${range.hi}]${range.mid === null ? "" : ` · mid ${range.mid}`}`;
  }
  const width = range.hi - range.lo + 1;
  return `window [${range.lo}..${range.hi}] · ${width} ${width === 1 ? "cell" : "cells"}`;
}
