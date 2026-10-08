// Names for the boxes of a diagram, shared by the graph logic and the components that draw them.
// Stack variable `s<frame>/<name>`, heap block `h<address>`, then `.field` / `[index]` suffixes (`s1/node.next`,
// `h0x55d0[2]`). C++ identifiers cannot contain `.` or `[`, so keys are unambiguous.

export const stackKey = (frameIndex, name) => `s${frameIndex}/${name}`;
export const heapKey = (address) => `h${address}`;
export const fieldKey = (base, name) => `${base}.${name}`;
export const cellKey = (base, index) => `${base}[${index}]`;
export const mapPartKey = (base, index, part) => `${cellKey(base, index)}.${part}`;

export const normalizeType = (type) => (type ?? "").replace(/\bconst\b/g, "").replace(/\s+/g, " ").trim();

/** Visits `entry` and everything inside it that is itself an entry (plain-string array items are cells, not entries). */
export function walkValue(entry, key, visit) {
  visit(entry, key);
  if (entry.kind === "struct") {
    entry.fields.forEach((field) => walkValue(field.v, fieldKey(key, field.name), visit));
  } else if (entry.kind === "array" || entry.kind === "seq") {
    entry.items.forEach((item, index) => {
      if (typeof item !== "string") walkValue(item, cellKey(key, index), visit);
    });
  } else if (entry.kind === "map") {
    entry.items.forEach((pair, index) => {
      if (typeof pair.k !== "string") walkValue(pair.k, mapPartKey(key, index, "k"), visit);
      if (typeof pair.v !== "string") walkValue(pair.v, mapPartKey(key, index, "v"), visit);
    });
  }
}
