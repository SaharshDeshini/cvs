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

/**
 * @param {{ steps: object[] }} trace
 * @returns {object[]} one entry per step: { n, line, fn, event, depth, stdoutLen, skipped, returned, changes, frames }
 *   where `frames` is the complete stack (outermost first). Input is not mutated.
 */
export function reconstruct(trace) {
  const views = [];
  let frames = [];
  for (const step of trace.steps) {
    frames = step.keyframe ? step.frames.slice() : applyFrames(frames, step);
    views.push({
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
