// Re-derives every value entry that arrives from the tracer (the untrusted side of the container boundary, D-016).
// Entry shapes are documented at the top of bk/runner/values.py. Output objects only ever get fixed keys: names that
// come from user code (struct fields, "__proto__" is legal C++) live in array elements, never as property keys.
const { LIMITS } = require("../utils/limits");

const SCALAR_KINDS = new Set(["int", "float", "bool", "char", "enum"]);
const VALUE_KINDS = new Set([...SCALAR_KINDS, "ptr", "raw", "unavailable", "array", "struct", "string", "seq", "map"]);
const POINTER_STATES = new Set(["null", "heap", "freed"]);
const HEX_ADDRESS = /^0x[0-9a-f]{1,16}$/;
const MAX_DEPTH = 8;
const MAX_SIZE = 2 ** 31;

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);
const text = (value) => clip(value, LIMITS.maxTextLength) ?? "";
const hex = (value) => (typeof value === "string" && HEX_ADDRESS.test(value) ? value : undefined);

/** A budget caps how many entries one step may contain, whatever the (forged) nesting looks like. */
const newBudget = () => ({ left: LIMITS.maxValueNodes });

/**
 * Converts list members until the budget is spent. Stopping here (not just collapsing each member) is what bounds the
 * output: a container entered while budget remained must not still emit a placeholder for each of its members.
 */
function collect(list, limit, budget, convert) {
  const clean = [];
  for (const member of list.slice(0, limit)) {
    if (budget.left <= 0) break;
    const converted = convert(member);
    if (converted !== null) clean.push(converted);
  }
  return clean;
}

function sanitizeItem(item, budget, depth) {
  return typeof item === "string" ? text(item) : sanitizeValue(item, budget, depth);
}

function sanitizeItems(items, budget, depth) {
  if (!Array.isArray(items)) return [];
  return collect(items, LIMITS.maxItems, budget, (item) => {
    if (typeof item === "string") budget.left -= 1; // plain-text cells cost an entry too: they become boxes the frontend lays out
    return sanitizeItem(item, budget, depth);
  });
}

function sanitizePair(pair, budget, depth) {
  if (pair === null || typeof pair !== "object") return null;
  const key = sanitizeItem(pair.k, budget, depth);
  const value = sanitizeItem(pair.v, budget, depth);
  return key === null || value === null ? null : { k: key, v: value };
}

function sanitizeField(field, budget, depth) {
  if (field === null || typeof field !== "object") return null;
  const value = sanitizeValue(field.v, budget, depth);
  // `.`, `[` and `/` separate the parts of a diagram key, so a forged name must not carry them
  return value === null ? null : { name: (clip(field.name, 128) ?? "").replace(/[./[\]]/g, "_"), v: value };
}

function addPointerFields(clean, entry) {
  clean.addr = hex(entry.addr);
  clean.to = clip(entry.to, 200) ?? "";
  clean.state = POINTER_STATES.has(entry.state) ? entry.state : null;
  clean.block = hex(entry.block);
  if (typeof entry.text === "string") clean.text = clip(entry.text, 200);
  if (entry.ref === true) clean.ref = true;
  if (entry.fn === true) clean.fn = true;
}

function addArrayFields(clean, entry, budget, depth) {
  clean.len = isInt(entry.len, 0, MAX_SIZE) ? entry.len : 0;
  clean.elem = clip(entry.elem, 200) ?? "";
  clean.elemSize = isInt(entry.elemSize, 0, MAX_SIZE) ? entry.elemSize : 0;
  if (SCALAR_KINDS.has(entry.elemKind)) clean.elemKind = entry.elemKind;
  clean.items = sanitizeItems(entry.items, budget, depth);
  if (isInt(entry.more, 1, MAX_SIZE)) clean.more = entry.more;
}

function addStructFields(clean, entry, budget, depth) {
  const fields = Array.isArray(entry.fields) ? entry.fields : [];
  clean.fields = collect(fields, LIMITS.maxFields, budget, (field) => sanitizeField(field, budget, depth));
  if (entry.more === true) clean.more = true;
}

function addContainerFields(clean, entry, budget, depth) {
  clean.container = clip(entry.container, 64) ?? "";
  if (isInt(entry.len, 0, MAX_SIZE)) clean.len = entry.len;
  if (SCALAR_KINDS.has(entry.elemKind)) clean.elemKind = entry.elemKind;
  if (clean.kind === "map") {
    const pairs = Array.isArray(entry.items) ? entry.items : [];
    clean.items = collect(pairs, LIMITS.maxItems, budget, (pair) => sanitizePair(pair, budget, depth));
  } else {
    clean.items = sanitizeItems(entry.items, budget, depth);
  }
  if (isInt(entry.more, 1, MAX_SIZE)) clean.more = entry.more;
}

/** @returns {object|null} a clean copy, or null when `entry` is not a value at all. */
function sanitizeValue(entry, budget = newBudget(), depth = 0) {
  if (entry === null || typeof entry !== "object" || !VALUE_KINDS.has(entry.kind)) return null;
  budget.left -= 1;
  if (budget.left < 0 || depth > MAX_DEPTH) return { kind: "raw", type: clip(entry.type, 200) ?? "?", value: "…" };
  const clean = { kind: entry.kind, type: clip(entry.type, 200) ?? "?" };
  if (entry.kind !== "array" && entry.kind !== "struct" && entry.kind !== "seq" && entry.kind !== "map") clean.value = text(entry.value);
  const at = hex(entry.at);
  if (at && isInt(entry.size, 0, MAX_SIZE)) Object.assign(clean, { at, size: entry.size });
  if (entry.kind === "ptr") addPointerFields(clean, entry);
  else if (entry.kind === "array") addArrayFields(clean, entry, budget, depth + 1);
  else if (entry.kind === "struct") addStructFields(clean, entry, budget, depth + 1);
  else if (entry.kind === "seq" || entry.kind === "map") addContainerFields(clean, entry, budget, depth + 1);
  return clean;
}

function sanitizeBlock(block, budget) {
  if (block === null || typeof block !== "object" || block.kind !== "block") return null;
  const clean = {
    kind: "block",
    size: isInt(block.size, 0, MAX_SIZE) ? block.size : 0,
    live: block.live === true,
    ty: clip(block.ty, 200) ?? "",
  };
  if (block.orphan === true) clean.orphan = true;
  const value = block.v === undefined ? null : sanitizeValue(block.v, budget);
  if (value !== null) clean.v = value;
  return clean;
}

/**
 * The heap table change a step carries: { set: Map(address -> block), del: [address] }, or null when the step has none.
 * Addresses are validated hex strings, so they are safe map keys.
 */
function sanitizeHeapDelta(delta, budget = newBudget()) {
  if (delta === null || typeof delta !== "object") return null;
  const set = new Map();
  const entries = delta.set && typeof delta.set === "object" ? Object.entries(delta.set) : [];
  for (const [address, block] of entries.slice(0, LIMITS.maxHeapBlocks)) {
    const clean = hex(address) ? sanitizeBlock(block, budget) : null;
    if (clean) set.set(address, clean);
  }
  const removed = Array.isArray(delta.del) ? delta.del.filter((address) => hex(address)).slice(0, LIMITS.maxHeapBlocks) : [];
  return set.size === 0 && removed.length === 0 ? null : { set, del: removed };
}

module.exports = { sanitizeValue, sanitizeHeapDelta, newBudget, SCALAR_KINDS };
