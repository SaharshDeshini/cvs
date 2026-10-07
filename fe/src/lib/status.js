// What the top-bar chip says. A finished request is not the same as a successful run.
const TRACE_LABELS = Object.freeze({
  ok: { label: "traced", tone: "ready" },
  compile_error: { label: "compile error", tone: "failed" },
  runtime_error: { label: "crashed", tone: "failed" },
  timeout: { label: "timed out", tone: "failed" },
  truncated: { label: "truncated", tone: "loading" },
  internal_error: { label: "tracer error", tone: "failed" },
});

const PHASE_LABELS = Object.freeze({
  idle: { label: "ready", tone: "idle" },
  loading: { label: "running", tone: "loading" },
  failed: { label: "error", tone: "failed" },
});

/** @returns {{ label: string, tone: "idle"|"loading"|"ready"|"failed" }} */
export function chipFor(phase, trace) {
  if (phase === "ready") return TRACE_LABELS[trace?.status] ?? { label: "unknown result", tone: "failed" };
  return PHASE_LABELS[phase] ?? PHASE_LABELS.idle;
}

/** The banner already says "Compilation failed"; repeating the server message would read as a stutter. */
export function bannerMessage(trace) {
  return trace.status === "compile_error" && trace.message === "Compilation failed" ? null : trace.message;
}
