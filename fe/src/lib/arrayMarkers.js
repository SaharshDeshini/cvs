// Which array cell does a loop variable sit on? INFERENCE, not a fact from the trace: an `int` local whose NAME looks
// like an index (i, j, lo, mid, ...) and whose value lies inside the array is shown as a marker under that cell.
// Pointers are never inferred this way: they get real arrows from their addresses.
const INDEX_NAME = /^(i|j|k|l|r|p|q|lo|hi|low|high|left|right|mid|idx|index|pos|start|end|first|last|cur|curr)$/;

/** @returns {Map<number, string[]>} cell index -> names of the variables standing on it, in declaration order. */
export function indexMarkers(vars, length) {
  const markers = new Map();
  for (const [name, entry] of Object.entries(vars)) {
    if (entry.kind !== "int" || !INDEX_NAME.test(name)) continue;
    const index = Number(entry.value);
    if (!Number.isInteger(index) || index < 0 || index >= length) continue;
    markers.set(index, [...(markers.get(index) ?? []), name]);
  }
  return markers;
}
