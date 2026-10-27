// Decodes the delta-encoded trace (schema 1, docs/ARCHITECTURE.md) into one complete view per step. This is the backend twin of
// fe/src/lib/reconstruct.js (the backend is CommonJS, the frontend ESM, so it cannot be shared); a parity test in
// src/tests/unit/traceDecoder.test.js runs both on the same fixture so the two cannot drift apart.
const FRAME_ID = /^f(\d+)$/;
const NO_HEAP = Object.freeze({});

function applyFrames(previous, step) {
  const next = previous.slice(0, step.depth);
  for (const frame of step.frames) {
    const match = FRAME_ID.exec(frame.id);
    if (match) next[Number(match[1])] = frame;
  }
  return next;
}

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
 * @returns {object[]} per step: { n, line, fn, event, depth, stdoutLen, skipped, returned, changes, frames, heap }. Input is not mutated.
 */
function decodeTrace(trace) {
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

/** Stdout visible at a step. `stdoutLen` counts BYTES, so cut on bytes and drop a character cut in half; the last step shows all. */
function stdoutAt(trace, views, index) {
  if (views.length === 0 || index >= views.length - 1) return trace.stdout;
  const bytes = Buffer.from(trace.stdout, "utf8");
  const limit = views[index].stdoutLen;
  if (limit >= bytes.length) return trace.stdout;
  return bytes.subarray(0, limit).toString("utf8").replace(/�+$/, "");
}

module.exports = { decodeTrace, stdoutAt };
