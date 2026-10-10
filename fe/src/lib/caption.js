// One plain-English line per step, built only from what the trace recorded (a call, a return value, an allocation, a free,
// a variable that changed). No guessing and no AI: every word either comes from a template or from a traced value.
const MAX_PARTS = 2;
const COMPOSITE = new Set(["array", "struct", "seq", "map"]);

const shortAddress = (address) => `@…${address.slice(-4)}`;
const isNull = (entry) => entry.addr === "0x0";

function pointerText(entry) {
  return entry.state === "freed" ? `freed memory ${shortAddress(entry.addr)}` : shortAddress(entry.addr);
}

/** The caption part for one variable, or null when it did not change. `before` is undefined for a new variable. */
function variablePart(name, entry, before) {
  if (entry.kind === "unavailable") return before?.kind === "unavailable" ? null : `${name} unreadable`; // never print GDB's error text
  if (entry.kind === "ptr") {
    if (before && before.kind === "ptr" && before.addr === entry.addr && before.state === entry.state) return null;
    if (!before) return isNull(entry) ? `${name} declared = null` : `${name} declared, points to ${pointerText(entry)}`;
    return isNull(entry) ? `${name} is now null` : `${name} now points to ${pointerText(entry)}`;
  }
  if (COMPOSITE.has(entry.kind)) {
    if (before && JSON.stringify(before) === JSON.stringify(entry)) return null;
    return before ? `${name} changed` : `${name} declared`;
  }
  if (!before) return `${name} declared = ${entry.value}`;
  return before.value === entry.value ? null : `${name} changed ${before.value} → ${entry.value}`;
}

function variableParts(view, previous) {
  const current = view.frames.at(-1);
  const earlier = previous?.frames.at(-1);
  if (!current || !earlier || earlier.fn !== current.fn) return [];
  // own-property lookup: a C++ variable may be called `constructor` or `toString`, which a plain `vars[name]` would find on Object
  const before = (name) => (Object.hasOwn(earlier.vars, name) ? earlier.vars[name] : undefined);
  return Object.entries(current.vars).map(([name, entry]) => variablePart(name, entry, before(name))).filter(Boolean);
}

function heapParts(view, previous) {
  const parts = [];
  for (const [address, block] of Object.entries(view.heap)) {
    const wasLive = previous?.heap[address]?.live === true;
    if (block.live && !wasLive && previous) parts.push(`Allocated ${block.size} bytes at ${shortAddress(address)}`);
    else if (!block.live && wasLive) parts.push(`Freed ${block.size} bytes at ${shortAddress(address)}`);
  }
  return parts;
}

function returnedText(returned) {
  if (returned.kind === "ptr") return returned.addr === "0x0" ? "null" : shortAddress(returned.value);
  return returned.value;
}

/**
 * @param {object} view one reconstructed step
 * @param {object|null} previous the step before it
 * @returns {string} always a line: falls back to the line number when nothing observable happened
 */
export function captionFor(view, previous) {
  if (view.event === "call") return `Entered ${view.frames.at(-1)?.fn}()`;
  if (view.event === "return" && view.returned) return `${view.returned.fn}() returned ${returnedText(view.returned)}`;
  const parts = [...heapParts(view, previous), ...variableParts(view, previous)];
  if (parts.length === 0) return `Line ${view.line}`;
  const shown = parts.slice(0, MAX_PARTS).join("; ");
  return parts.length > MAX_PARTS ? `${shown} (+${parts.length - MAX_PARTS} more)` : shown;
}
