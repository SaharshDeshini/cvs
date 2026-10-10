import { describe, expect, it } from "vitest";
import { depthRuns, indexAtFraction } from "./timeline";

const at = (...depths) => depths.map((depth) => ({ depth }));

describe("depthRuns", () => {
  it("makes one run per level for each stretch of steps at least that deep", () => {
    expect(depthRuns(at(1, 2, 2, 1))).toEqual([
      { level: 1, from: 0, to: 3 },
      { level: 2, from: 1, to: 2 },
    ]);
  });

  it("splits a level into separate runs when the stack comes back up in between", () => {
    const runs = depthRuns(at(1, 2, 1, 2, 2));
    expect(runs.filter((run) => run.level === 2)).toEqual([{ level: 2, from: 1, to: 1 }, { level: 2, from: 3, to: 4 }]);
  });

  it("stops at the deepest level it was asked to draw", () => {
    const runs = depthRuns(at(1, 5, 9), 3);
    expect(Math.max(...runs.map((run) => run.level))).toBe(3);
  });

  it("returns nothing for no steps", () => {
    expect(depthRuns([])).toEqual([]);
  });
});

describe("indexAtFraction", () => {
  it("maps a position along the strip to the nearest step, clamped to the run", () => {
    expect(indexAtFraction(0, 5)).toBe(0);
    expect(indexAtFraction(1, 5)).toBe(4);
    expect(indexAtFraction(0.5, 5)).toBe(2);
    expect(indexAtFraction(2, 5)).toBe(4);
    expect(indexAtFraction(-1, 5)).toBe(0);
  });

  it("picks the step whose cell the position falls in, matching where the playhead is drawn", () => {
    expect(indexAtFraction(0.19, 5)).toBe(0);
    expect(indexAtFraction(0.2, 5)).toBe(1);
    expect(indexAtFraction(0.99, 5)).toBe(4);
  });

  it("never returns NaN, even for a zero-width strip", () => {
    expect(indexAtFraction(Number.NaN, 5)).toBe(0);
    expect(indexAtFraction(Number.POSITIVE_INFINITY, 5)).toBe(4);
  });

  it("is safe for a single step and for none", () => {
    expect(indexAtFraction(0.7, 1)).toBe(0);
    expect(indexAtFraction(0.7, 0)).toBe(0);
  });
});
