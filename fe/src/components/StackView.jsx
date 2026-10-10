import { memo, useContext } from "react";
import { indexMarkers } from "../lib/arrayMarkers";
import { asMatrix, matrixMarks } from "../lib/matrix";
import { detectRange } from "../lib/rangeHints";
import { stackKey } from "../lib/valueKeys";
import ValueView, { DiagramContext, shortAddress } from "./ValueView";

const COMPOSITE_KINDS = new Set(["array", "struct", "seq", "map"]);

function formatReturned(entry) {
  if (entry.kind === "ptr") return entry.addr === "0x0" ? "null" : shortAddress(entry.value);
  return entry.value;
}

const isSequence = (entry) => entry.kind === "array" || entry.kind === "seq";

/** The one array/vector of a frame that the range variables (lo/hi, left/right...) are taken to describe: the first they fit. */
function rangeOwner(vars, searchHint) {
  return Object.keys(vars).find((name) => isSequence(vars[name]) && !asMatrix(vars[name]) && detectRange(vars, vars[name].len, { searchHint }) !== null);
}

function VariableRow({ name, entry, path, vars, ownsRange, searchHint }) {
  const isComposite = COMPOSITE_KINDS.has(entry.kind);
  const grid = isSequence(entry) ? asMatrix(entry) : null;
  const markers = isSequence(entry) && !grid ? indexMarkers(vars, entry.len) : undefined;
  const range = ownsRange ? detectRange(vars, entry.len, { searchHint }) : null;
  const matrix = grid ? { grid, marks: matrixMarks(vars, grid.rows, grid.cols) } : null;
  return (
    <li className={`var-row${isComposite ? " is-composite" : ""}`}>
      <span className="var-name">{name}</span>
      <span className="var-type">{entry.type}</span>
      <div className="var-body"><ValueView entry={entry} path={path} markers={markers} range={range} matrix={matrix} /></div>
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
  const { searchFns } = useContext(DiagramContext);
  const searchHint = searchFns.has(frame.fn);
  const owner = rangeOwner(frame.vars, searchHint);
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
            <VariableRow key={name} name={name} entry={frame.vars[name]} path={stackKey(frameIndex, name)} vars={frame.vars} ownsRange={name === owner} searchHint={searchHint} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The call stack, innermost frame on top, so recursion reads as a tower. */
function StackView({ view }) {
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

export default memo(StackView);
