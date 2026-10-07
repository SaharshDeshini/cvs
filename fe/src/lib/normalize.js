// The server validates traces, but the UI must not crash on a surprising one (version skew, a proxy in between).
// Missing optional fields get safe defaults; a trace without a usable `steps` array is rejected by api.js first.
const asArray = (value) => (Array.isArray(value) ? value : []);
const asString = (value) => (typeof value === "string" ? value : "");

function normalizeStep(step) {
  return { ...step, frames: asArray(step?.frames), changes: asArray(step?.changes), depth: Number.isInteger(step?.depth) ? step.depth : 0 };
}

/**
 * @param {object} raw  a schema-1 trace
 * @returns {object} the same trace with every field the UI dereferences guaranteed to exist. Input is not mutated.
 */
export function normalizeTrace(raw) {
  return {
    ...raw,
    status: asString(raw.status),
    message: typeof raw.message === "string" ? raw.message : null,
    stdout: asString(raw.stdout),
    stderr: asString(raw.stderr),
    compileErrors: asArray(raw.compileErrors),
    compileOutput: typeof raw.compileOutput === "string" ? raw.compileOutput : null,
    limits: { stdoutTruncated: false, truncated: false, ...(raw.limits && typeof raw.limits === "object" ? raw.limits : {}) },
    steps: asArray(raw.steps).filter((step) => step && typeof step === "object").map(normalizeStep),
  };
}
