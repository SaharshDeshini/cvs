import { isChanged } from "../lib/reconstruct";

function formatValue(entry) {
  if (entry.kind === "ptr") return entry.addr === "0x0" ? "null" : entry.value;
  return entry.value;
}

function VariableRow({ name, entry, changed }) {
  // key on the value so the flash animation restarts whenever the value changes
  return (
    <li className="var-row">
      <span className="var-name">{name}</span>
      <span className="var-type">{entry.type}</span>
      <span key={entry.value} className={`var-value kind-${entry.kind}${changed ? " is-changed" : ""}`}>
        {formatValue(entry)}
      </span>
    </li>
  );
}

/** What the call that just finished handed back; shown on the frame that received it (the new innermost one). */
function ReturnedNote({ returned }) {
  const text = formatValue(returned);
  return (
    <p className="frame-returned" aria-label={`${returned.fn} returned ${text}`}>
      <span className="returned-arrow" aria-hidden="true">↩</span>
      <span className="returned-fn">{returned.fn}()</span>
      <span>returned</span>
      <span key={text} className={`var-value kind-${returned.kind} is-changed`}>{text}</span>
    </p>
  );
}

function FrameCard({ frame, frameIndex, isCurrent, changes, returned }) {
  const names = Object.keys(frame.vars);
  return (
    <section className={`frame-card${isCurrent ? " is-current" : ""}`} aria-label={`${frame.fn} frame`}>
      <header className="frame-head">
        <span className="frame-fn">{frame.fn}()</span>
        <span className="frame-line">line {frame.line}</span>
      </header>
      {isCurrent && returned && <ReturnedNote returned={returned} />}
      {names.length === 0 ? (
        <p className="frame-empty">no variables yet</p>
      ) : (
        <ul className="var-list">
          {names.map((name) => (
            <VariableRow key={name} name={name} entry={frame.vars[name]} changed={isChanged(changes, frameIndex, name)} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The call stack, innermost frame on top, so recursion reads as a tower. */
export default function StackView({ view }) {
  const frames = view.frames;
  return (
    <div className="stack" role="region" aria-label="Call stack">
      <h2 className="panel-title">Call stack <span className="panel-meta">{frames.length} deep</span></h2>
      <div className="stack-cards">
        {frames
          .map((frame, frameIndex) => ({ frame, frameIndex }))
          .reverse()
          .map(({ frame, frameIndex }) => (
            <FrameCard
              key={`${frameIndex}:${frame.fn}`}
              frame={frame}
              frameIndex={frameIndex}
              isCurrent={frameIndex === frames.length - 1}
              changes={view.changes}
              returned={view.returned}
            />
          ))}
      </div>
    </div>
  );
}
