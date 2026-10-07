import { bannerMessage } from "../lib/status";

const TITLES = Object.freeze({
  compile_error: "Compilation failed",
  runtime_error: "The program crashed",
  timeout: "The program did not finish",
  truncated: "Trace cut short",
  internal_error: "The tracer could not follow this run",
});

/** Result banner for non-ok traces. Compile diagnostics are listed with their lines. */
export default function StatusBanner({ trace }) {
  if (trace.status === "ok") return null;
  const isProblem = trace.status !== "truncated";
  const message = bannerMessage(trace);
  return (
    <div className={`banner ${isProblem ? "is-problem" : "is-notice"}`} role="alert">
      <strong>{TITLES[trace.status] ?? "Unexpected result"}</strong>
      {message && <span className="banner-message"> — {message}</span>}
      {trace.status === "compile_error" && trace.compileErrors.length > 0 && (
        <ul className="diagnostics">
          {trace.compileErrors.map((d, i) => (
            <li key={`${d.line}:${d.column}:${i}`}>
              <span className="diag-pos">{d.line}:{d.column}</span> <span className="diag-msg">{d.message}</span>
            </li>
          ))}
        </ul>
      )}
      {trace.status === "compile_error" && trace.compileErrors.length === 0 && trace.compileOutput && (
        <pre className="diag-raw">{trace.compileOutput}</pre>
      )}
      {trace.status === "runtime_error" && trace.steps.length > 0 && (
        <p className="banner-hint">Step through the trace to see the state just before it happened.</p>
      )}
    </div>
  );
}
