import { indexMarkers } from "../lib/arrayMarkers";
import { stackKey } from "../lib/valueKeys";
import ValueView from "./ValueView";

const COMPOSITE_KINDS = new Set(["array", "struct", "seq", "map"]);

function formatReturned(entry) {
  if (entry.kind === "ptr") return entry.addr === "0x0" ? "null" : entry.value;
  return entry.value;
}

function VariableRow({ name, entry, path, vars }) {
  const isComposite = COMPOSITE_KINDS.has(entry.kind);
  const markers = entry.kind === "array" ? indexMarkers(vars, entry.len) : undefined;
  return (
    <li className={`var-row${isComposite ? " is-composite" : ""}`}>
      <span className="var-name">{name}</span>
      <span className="var-type">{entry.type}</span>
      <div className="var-body"><ValueView entry={entry} path={path} markers={markers} /></div>
    </li>
  );
}

/** What the call that just finished handed back; shown on the frame that received it (the new innermost one). */
function ReturnedNote({ returned }) {
  const text = formatReturned(returned);
  return (
    <p className="frame-returned" aria-label={`${returned.fn} returned ${text}`}>
      <span className="returned-arrow" aria-hidden="true">↩</span>
      <span className="returned-fn">{returned.fn}()</span>
      <span>returned</span>
      <span key={text} className={`var-value kind-${returned.kind} is-changed`}>{text}</span>
    </p>
  );
}

function FrameCard({ frame, frameIndex, isCurrent, returned }) {
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
            <VariableRow key={name} name={name} entry={frame.vars[name]} path={stackKey(frameIndex, name)} vars={frame.vars} />
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
              returned={view.returned}
            />
          ))}
      </div>
    </div>
  );
}
