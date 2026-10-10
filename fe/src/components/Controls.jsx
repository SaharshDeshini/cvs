import { SPEEDS } from "../lib/playerReducer";
import Timeline from "./Timeline";

const ICONS = Object.freeze({
  run: "M8 5v14l11-7z",
  prev: "M15 6l-9 6 9 6zM18 6h-2v12h2z",
  next: "M9 6l9 6-9 6zM6 6h2v12H6z",
  play: "M8 5v14l11-7z",
  pause: "M7 5h4v14H7zM13 5h4v14h-4z",
  reset: "M12 5a7 7 0 1 1-6.7 9h2.1A5 5 0 1 0 12 7v3L7 6l5-4z",
});

function Icon({ name }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d={ICONS[name]} fill="currentColor" /></svg>;
}

/** Bottom control bar: Run | Previous | Play | Next | Reset | scrubber | step counter | speed. */
export default function Controls({ phase, index, total, views, bugs, playing, speedIndex, line, isStale, dispatch, onRun }) {
  const canStep = phase === "ready" && total > 0;
  return (
    <footer className="controls" aria-label="Playback controls">
      <button type="button" className="btn btn-run" onClick={onRun} disabled={phase === "loading"} title="Run (Ctrl+Enter)">
        <Icon name="run" /> {phase === "loading" ? "Running…" : "Run"}
      </button>
      <div className="control-group" role="group" aria-label="Step through execution">
        <button type="button" className="btn btn-icon" onClick={() => dispatch({ type: "step/prev" })} disabled={!canStep || index === 0} aria-label="Previous step" title="Previous (Alt+←)">
          <Icon name="prev" />
        </button>
        <button type="button" className="btn btn-icon btn-play" onClick={() => dispatch({ type: "play/toggle" })} disabled={!canStep} aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)">
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <button type="button" className="btn btn-icon" onClick={() => dispatch({ type: "step/next" })} disabled={!canStep || index >= total - 1} aria-label="Next step" title="Next (Alt+→)">
          <Icon name="next" />
        </button>
        <button type="button" className="btn btn-icon" onClick={() => dispatch({ type: "step/reset" })} disabled={!canStep || index === 0} aria-label="Reset to first step" title="Reset (Home)">
          <Icon name="reset" />
        </button>
      </div>
      <div className="scrub">
        {canStep && <Timeline views={views} bugs={bugs} index={index} onSeek={(step) => dispatch({ type: "step/seek", index: step })} />}
        <input
          className="scrubber"
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          value={index}
          disabled={!canStep}
          onChange={(event) => dispatch({ type: "step/seek", index: Number(event.target.value) })}
          aria-label="Execution step"
          aria-valuetext={canStep ? `Step ${index + 1} of ${total}` : "No trace"}
        />
      </div>
      <div className="step-readout">{/* not a live region: at 8x it would announce every step; the scrubber carries aria-valuetext */}
        {canStep ? (
          <>
            <span className="step-count">{index + 1}<span className="muted"> / {total}</span></span>
            <span className={`step-line${isStale ? " is-stale" : ""}`}>{isStale ? "code edited" : `line ${line}`}</span>
          </>
        ) : (
          <span className="muted">no trace</span>
        )}
      </div>
      <label className="speed">
        <span className="muted">Speed</span>
        <select value={speedIndex} onChange={(event) => dispatch({ type: "speed/set", index: Number(event.target.value) })} aria-label="Playback speed">
          {SPEEDS.map((speed, i) => <option key={speed} value={i}>{speed}×</option>)}
        </select>
      </label>
    </footer>
  );
}
