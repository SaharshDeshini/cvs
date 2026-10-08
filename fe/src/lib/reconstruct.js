// Decodes the delta-encoded trace (schema 1, docs/ARCHITECTURE.md) into one complete, immutable view per step.
// Keyframe steps list every live frame; other steps list only changed frames, addressed by stack index ("f0" = main).
// `depth` is how many frames are live, so frames above it have returned.

const FRAME_ID = /^f(\d+)$/;

function applyFrames(previous, step) {
  const next = previous.slice(0, step.depth);
  for (const frame of step.frames) {
    const match = FRAME_ID.exec(frame.id);
    if (match) next[Number(match[1])] = frame;
  }
  return next;
}

const NO_HEAP = Object.freeze({});

/** A keyframe's heap is the whole table (none = empty heap); other steps only list blocks that changed or went away. */
function applyHeap(previous, step) {
  const delta = step.heap;
  if (step.keyframe) return delta ? { ...delta.set } : NO_HEAP;
  if (!delta) return previous;
  const next = { ...previous };
  for (const address of delta.del) delete next[address];
  return Object.assign(next, delta.set);
}

/**
 * @param {{ steps: object[] }} trace
 * @returns {object[]} one entry per step: { n, line, fn, event, depth, stdoutLen, skipped, returned, changes, frames, heap }
 *   where `frames` is the complete stack (outermost first) and `heap` the complete heap table (block address -> block).
 *   Input is not mutated.
 */
export function reconstruct(trace) {
  const views = [];
  let frames = [];
  let heap = NO_HEAP;
  for (const step of trace.steps) {
    frames = step.keyframe ? step.frames.slice() : applyFrames(frames, step);
    heap = applyHeap(heap, step);
    views.push({
      heap,
      n: step.n,
      line: step.line,
      fn: step.fn,
      event: step.event,
      depth: step.depth,
      stdoutLen: step.stdoutLen,
      skipped: step.skipped,
      returned: step.returned ?? null,
      changes: step.changes,
      frames,
    });
  }
  return views;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PARTIAL_CHARACTER = /�+$/;

/**
 * Stdout visible at a step. `stdoutLen` is a BYTE count (the tracer reads the output file's size), so the text is cut
 * on bytes, never on UTF-16 units, and a character cut in half is dropped. The program's output is only complete at
 * the end, so the last step shows everything.
 */
export function stdoutAt(trace, views, index) {
  if (views.length === 0 || index >= views.length - 1) return trace.stdout;
  const bytes = encoder.encode(trace.stdout);
  const limit = views[index].stdoutLen;
  if (limit >= bytes.length) return trace.stdout;
  return decoder.decode(bytes.slice(0, limit)).replace(PARTIAL_CHARACTER, "");
}

/** Is `path` (e.g. "f1.vars.n") among this step's changes? A whole-frame change ("f1") marks all its variables. */
export function isChanged(changes, frameIndex, varName) {
  return changes.includes(`f${frameIndex}`) || changes.includes(`f${frameIndex}.vars.${varName}`);
}
