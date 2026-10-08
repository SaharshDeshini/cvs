// Turns one reconstructed view ({ frames, heap }) into the facts a diagram needs: which box every pointer points at,
// decided from real addresses and never guessed, and which values changed since the step before.
//
// Boxes are named by keys: stack variable `s<frame>/<name>`, heap block `h<address>`, then `.field` / `[index]`
// suffixes (`s1/node.next`, `h0x55d0[2]`). C++ identifiers cannot contain `.` or `[`, so keys are unambiguous.

import { planStructures } from "./heapShapes";
import { cellKey, heapKey, mapPartKey, normalizeType, stackKey, walkValue } from "./valueKeys";

export { planStructures, TREE_DEPTH_LIMIT } from "./heapShapes";
export { cellKey, fieldKey, heapKey, mapPartKey, normalizeType, stackKey, walkValue } from "./valueKeys";

const toNumber = (hex) => Number.parseInt(hex, 16);

/** Calls `visit(entry, key)` for every stack variable and every heap block's contents (not for their insides). */
export function forEachRoot(view, visit) {
  view.frames.forEach((frame, frameIndex) => {
    for (const [name, entry] of Object.entries(frame.vars)) visit(entry, stackKey(frameIndex, name));
  });
  for (const [address, block] of Object.entries(view.heap)) {
    if (block.v) visit(block.v, heapKey(address));
  }
}

function makeRange(start, size, key, type) {
  const span = Math.max(size, 1);
  return { start, end: start + span, span, key, type: normalizeType(type) };
}

function addEntryRanges(ranges, entry, key, rootStart) {
  walkValue(entry, key, (inner, innerKey) => {
    const isRoot = innerKey === key && rootStart !== undefined;
    const start = isRoot ? rootStart : inner.at === undefined ? undefined : toNumber(inner.at);
    if (start === undefined) return;
    if (!isRoot) ranges.push(makeRange(start, inner.size ?? 1, innerKey, inner.type));
    if (inner.kind === "array" && inner.elemSize > 0) {
      inner.items.forEach((_, index) => ranges.push(makeRange(start + index * inner.elemSize, inner.elemSize, cellKey(innerKey, index), inner.elem)));
    }
  });
}

function collectRanges(view) {
  const ranges = [];
  view.frames.forEach((frame, frameIndex) => {
    for (const [name, entry] of Object.entries(frame.vars)) addEntryRanges(ranges, entry, stackKey(frameIndex, name));
  });
  for (const [address, block] of Object.entries(view.heap)) {
    const start = toNumber(address);
    ranges.push(makeRange(start, block.size, heapKey(address), block.v?.type ?? block.ty)); // the block itself comes first: outermost wins ties
    if (block.v) addEntryRanges(ranges, block.v, heapKey(address), start);
  }
  return ranges;
}

/** Of two boxes containing the address: the one whose type is the pointer's target type, then the smaller one. */
function isBetter(candidate, best, wanted) {
  const candidateMatches = candidate.type === wanted;
  const bestMatches = best.type === wanted;
  if (candidateMatches !== bestMatches) return candidateMatches;
  return candidate.span < best.span;
}

/** @returns {(address: string, targetType?: string) => string|null} the key of the box containing `address`. */
export function buildResolver(view) {
  const ranges = collectRanges(view);
  return (address, targetType) => {
    const target = toNumber(address);
    const wanted = normalizeType(targetType);
    let best = null;
    for (const range of ranges) {
      if (target >= range.start && target < range.end && (best === null || isBetter(range, best, wanted))) best = range;
    }
    return best ? best.key : null;
  };
}

/** One edge per non-null data pointer (or reference) whose target is a box we know about. */
export function collectEdges(view, resolve) {
  const edges = [];
  forEachRoot(view, (root, rootKey) => walkValue(root, rootKey, (entry, key) => {
    if (entry.kind !== "ptr" || entry.fn || !entry.addr || entry.addr === "0x0") return;
    const to = resolve(entry.addr, entry.to);
    if (to !== null) edges.push({ from: key, to, dangling: entry.state === "freed", ref: Boolean(entry.ref) });
  }));
  return edges;
}

function leafTexts(view) {
  const texts = new Map();
  forEachRoot(view, (root, rootKey) => walkValue(root, rootKey, (entry, key) => {
    if (entry.kind === "ptr") texts.set(key, entry.addr ?? entry.value);
    else if (entry.kind === "array" || entry.kind === "seq") {
      entry.items.forEach((item, index) => { if (typeof item === "string") texts.set(cellKey(key, index), item); });
    } else if (entry.kind === "map") {
      entry.items.forEach((pair, index) => {
        if (typeof pair.k === "string") texts.set(mapPartKey(key, index, "k"), pair.k);
        if (typeof pair.v === "string") texts.set(mapPartKey(key, index, "v"), pair.v);
      });
    } else if (entry.kind !== "struct") texts.set(key, entry.value);
  }));
  return texts;
}

/** Everything the diagram components need for one step, computed once: arrows, heap shapes, and what just changed. */
export function buildDiagram(view, previous) {
  const changed = changedKeys(previous, view);
  for (const path of view.changes ?? []) { // a whole new frame (a call) is flagged as "f<index>": all its variables are new
    const frameIndex = /^f(\d+)$/.exec(path)?.[1];
    if (frameIndex !== undefined) Object.keys(view.frames[Number(frameIndex)]?.vars ?? {}).forEach((name) => changed.add(stackKey(Number(frameIndex), name)));
  }
  return { edges: collectEdges(view, buildResolver(view)), plan: planStructures(view), changed };
}

/** Keys of every value that is new or different compared with `previous` (null = nothing before: all of it is new). */
export function changedKeys(previous, current) {
  const before = previous ? leafTexts(previous) : new Map();
  const changed = new Set();
  for (const [key, text] of leafTexts(current)) {
    if (before.get(key) !== text) changed.add(key);
  }
  return changed;
}
