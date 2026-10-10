// Pointer variables shown ON the data they point at (a tag under an array cell or above a list node), not only as an arrow
// from the variable table. Built from the arrows the diagram already resolved from real addresses, so a tag is a fact.
// Only the names that really bound a window. first/last (a queue's ends) and low/high (a search) are not windows on a list.
const WINDOW_PAIRS = Object.freeze([["left", "right"], ["l", "r"], ["start", "end"], ["begin", "end"]]);

const TOP_LEVEL_VARIABLE = /^s\d+\/([^.[\]]+)$/; // `s0/slow`, not `s0/arr[1]` or `h0x10.next`
const inside = (key, box) => key === box || key.startsWith(`${box}.`) || key.startsWith(`${box}[`);

/** @returns {Map<string, string[]>} key of the box pointed at -> names of the stack variables pointing at it, in order. */
export function pointerTags(edges) {
  const tags = new Map();
  for (const edge of edges) {
    const name = TOP_LEVEL_VARIABLE.exec(edge.from)?.[1];
    if (name === undefined || edge.dangling) continue;
    const names = tags.get(edge.to) ?? [];
    if (!names.includes(name)) tags.set(edge.to, [...names, name]);
  }
  return tags;
}

/** The names of the variables pointing at exactly this box (not at something inside it). */
export const tagsAt = (tags, key) => tags.get(key) ?? [];

/** The names on `key` itself and on anything inside it (a pointer to a node's field tags the node). */
export function tagsFor(tags, key) {
  const names = [];
  for (const [target, found] of tags) {
    if (inside(target, key)) found.forEach((name) => { if (!names.includes(name)) names.push(name); });
  }
  return names;
}

/**
 * The nodes of a list between its `left` and `right` pointers (any range pair of names), inclusive: a sliding window over a
 * linked list. Empty when no complete pair sits on the chain.
 * @param {string[]} chain node addresses, head first
 * @param {Map<string, string[]>} tags from pointerTags
 * @param {(address: string) => string} keyOf the box key of a node address
 * @returns {Set<string>} addresses inside the window
 */
export function chainWindow(chain, tags, keyOf) {
  const namesAt = chain.map((address) => tagsFor(tags, keyOf(address)));
  for (const [first, second] of WINDOW_PAIRS) {
    const a = namesAt.findIndex((names) => names.includes(first));
    const b = namesAt.findIndex((names) => names.includes(second));
    if (a === -1 || b === -1) continue;
    return new Set(chain.slice(Math.min(a, b), Math.max(a, b) + 1));
  }
  return new Set();
}
