import { memo, useMemo, useRef } from "react";
import { depthRuns, indexAtFraction } from "../lib/timeline";

const MIN_LEVELS = 2; // a flat program (everything in main) still draws a bar worth looking at

// Memoised: its props only change with a new trace, so stepping never re-reconciles the (possibly thousands of) rects.
const Flame = memo(function Flame({ runs, total, levels, className }) {
  return (
    <svg className={`tl-flame ${className}`} viewBox={`0 0 ${total} ${levels}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {runs.map((run) => (
        <rect key={`${run.level}:${run.from}`} x={run.from} y={levels - run.level} width={run.to - run.from + 1} height={1} />
      ))}
    </svg>
  );
});

const percentAt = (step, total) => `${((step + 0.5) / total) * 100}%`;

/**
 * The whole run as one strip: height is call depth (a recursion is a mountain), the lit part is what has run, the marks
 * are bugs the trace shows. Click or drag to jump; the range input next to it stays for keyboard and screen readers.
 */
export default function Timeline({ views, bugs, index, onSeek }) {
  const stripRef = useRef(null);
  const total = views.length;
  const { runs, levels } = useMemo(() => {
    const found = depthRuns(views);
    return { runs: found, levels: found.reduce((deepest, run) => Math.max(deepest, run.level), MIN_LEVELS) };
  }, [views]);
  if (total === 0) return null;
  const lit = ((index + 1) / total) * 100;

  const seekTo = (event) => {
    const { left, width } = stripRef.current.getBoundingClientRect();
    if (width > 0) onSeek(indexAtFraction((event.clientX - left) / width, total));
  };
  const handlePointerDown = (event) => {
    if (event.button !== 0) return; // a right-click opens the menu; it must not move the playhead
    event.currentTarget.setPointerCapture(event.pointerId);
    seekTo(event);
  };
  const handlePointerMove = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) seekTo(event); // only a drag that began on the strip
  };

  return (
    <div className="timeline" ref={stripRef} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}>
      <div className="tl-clip">
        <Flame runs={runs} total={total} levels={levels} className="tl-base" />
        <div className="tl-lit" style={{ clipPath: `inset(0 ${100 - lit}% 0 0)` }}>
          <Flame runs={runs} total={total} levels={levels} className="tl-done" />
        </div>
        <span className="tl-playhead" style={{ left: percentAt(index, total) }} aria-hidden="true" />
      </div>
      {bugs.map((bug) => (
        <button
          key={bug.id}
          type="button"
          className={`tl-bug is-${bug.severity}`}
          style={{ left: percentAt(bug.step, total) }}
          title={`${bug.title} (step ${bug.step + 1})`}
          aria-label={`${bug.title}, step ${bug.step + 1}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onSeek(bug.step)}
        />
      ))}
    </div>
  );
}
