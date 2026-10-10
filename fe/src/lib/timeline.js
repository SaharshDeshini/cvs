// Geometry for the execution timeline: a flame-style strip where the height at each step is the call depth. The strip is
// drawn from runs (one rectangle per stretch), so a 5,000-step trace is a few dozen shapes, not 5,000.
export const MAX_LEVELS = 6;

/**
 * @param {{ depth: number }[]} views one reconstructed step each
 * @param {number} [maxLevel] deepest level drawn; deeper calls are drawn at this level
 * @returns {{ level: number, from: number, to: number }[]} for each level, the inclusive step ranges at least that deep
 */
export function depthRuns(views, maxLevel = MAX_LEVELS) {
  const deepest = Math.min(maxLevel, views.reduce((max, view) => Math.max(max, view.depth), 0));
  const runs = [];
  for (let level = 1; level <= deepest; level += 1) {
    let start = null;
    views.forEach((view, index) => {
      const deepEnough = view.depth >= level;
      if (deepEnough && start === null) start = index;
      if (!deepEnough && start !== null) {
        runs.push({ level, from: start, to: index - 1 });
        start = null;
      }
    });
    if (start !== null) runs.push({ level, from: start, to: views.length - 1 });
  }
  return runs;
}

/**
 * The step whose cell a position along the strip falls in (0 = left edge, 1 = right edge): the same cell the playhead is
 * drawn in, so it sits under the cursor while dragging. Clamped to a real step; a NaN position (zero-width strip) is step 0.
 */
export function indexAtFraction(fraction, total) {
  if (total <= 1 || Number.isNaN(fraction)) return 0;
  return Math.max(0, Math.min(total - 1, Math.floor(fraction * total)));
}
