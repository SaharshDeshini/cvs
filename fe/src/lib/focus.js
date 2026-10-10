// Hover tracing: which arrows belong to the pointer or box the mouse is over. Box keys nest (`h0x10`, `h0x10.next`,
// `s0/a[2]`), so "inside the focused box" is a prefix test that must stop at a `.` or `[`, never mid-name.
const inside = (key, box) => key === box || key.startsWith(`${box}.`) || key.startsWith(`${box}[`);

/** @returns {boolean} true when the edge leaves, enters, or sits inside the focused box. */
export function isRelated(edge, focus) {
  if (!focus) return false;
  return inside(edge.from, focus) || inside(edge.to, focus);
}
