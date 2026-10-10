// The small grey "sum = 6   x = 7" label at the end of the line being executed. It names only variables that really are in
// the current frame and appear in that line's code, so it never shows a value the trace did not record.
const MAX_ITEMS = 3;
const SEPARATOR = "   ";
const HIDDEN_KINDS = new Set(["array", "struct", "seq", "map", "unavailable"]);
const STRING_OR_COMMENT = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/.*$/g;
// a plain name: not the member after `.` or `->` (p->next, s.size), and not the tail of a longer word
const IDENTIFIER = /(?<![\w.])(?<!->)[A-Za-z_]\w*/g;

const shortAddress = (address) => `@…${address.slice(-4)}`;

function describeEntry(entry) {
  if (entry.kind === "ptr") return entry.addr === "0x0" ? "null" : shortAddress(entry.addr);
  return entry.value;
}

/** The names the code on this line uses, in order, ignoring strings, comments and member accesses. */
export function identifiersIn(lineText) {
  return [...lineText.replace(STRING_OR_COMMENT, " ").matchAll(IDENTIFIER)].map((match) => match[0]);
}

/**
 * @param {string} lineText source text of the line about to execute
 * @param {Record<string, object>} vars the current frame's variables (trace entries)
 * @returns {string} "" when nothing on the line is a plain variable
 */
export function inlineValuesFor(lineText, vars) {
  const seen = new Set();
  const parts = [];
  for (const name of identifiersIn(lineText)) {
    if (seen.has(name) || !Object.hasOwn(vars, name)) continue;
    seen.add(name);
    const entry = vars[name];
    if (HIDDEN_KINDS.has(entry.kind)) continue;
    parts.push(`${name} = ${describeEntry(entry)}`);
    if (parts.length === MAX_ITEMS) break;
  }
  return parts.join(SEPARATOR);
}
