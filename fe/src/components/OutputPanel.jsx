// Program-derived text is always rendered as a text node (never as HTML).
export default function OutputPanel({ stdout, stderr, stdoutTruncated, showFull }) {
  const hasStderr = stderr.length > 0;
  return (
    <div className="output" role="region" aria-label="Program output">
      <h2 className="panel-title">Output</h2>
      <pre className="output-text" tabIndex={0} aria-label="Program stdout">{stdout.length > 0 ? stdout : <span className="muted">(nothing printed yet)</span>}</pre>
      {stdoutTruncated && showFull && <p className="note">Output was cut at 1 MB.</p>}
      {hasStderr && showFull && (
        <>
          <h3 className="panel-subtitle">stderr</h3>
          <pre className="output-text is-error" tabIndex={0} aria-label="Program stderr">{stderr}</pre>
        </>
      )}
    </div>
  );
}
