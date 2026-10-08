import { describe, expect, it } from "vitest";
import { arrowPath } from "./arrowPath";

const rect = (left, top, width = 80, height = 40) => ({ left, top, right: left + width, bottom: top + height });
const numbers = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);

describe("arrowPath", () => {
  it("enters a target on the right through its left edge, at mid height", () => {
    const { d, end } = arrowPath({ x: 10, y: 20 }, rect(200, 0));
    expect(end).toEqual({ x: 200, y: 20 });
    expect(d.startsWith("M 10 20 C")).toBe(true);
    expect(numbers(d).slice(-2)).toEqual([200, 20]);
  });

  it("enters a target below through its top edge, kept inside the box", () => {
    const { end } = arrowPath({ x: 500, y: 20 }, rect(100, 120));
    expect(end.y).toBe(120);
    expect(end.x).toBeGreaterThanOrEqual(108);
    expect(end.x).toBeLessThanOrEqual(172);
  });

  it("enters a target above through its bottom edge", () => {
    const { end } = arrowPath({ x: 140, y: 300 }, rect(100, 0));
    expect(end.y).toBe(40);
  });

  it("a stack arrow leaves sideways, a node arrow leaves downward, toward the same box", () => {
    const below = rect(100, 200);
    const side = numbers(arrowPath({ x: 300, y: 20 }, below, "right").d); // [sx, sy, c1x, c1y, c2x, c2y, ex, ey]
    const down = numbers(arrowPath({ x: 300, y: 20 }, below, "down").d);
    expect(side[2]).toBeGreaterThan(300); // first control point is to the right of the dot
    expect(side[3]).toBe(20);
    expect(down[2]).toBe(300); // first control point is straight below it
    expect(down[3]).toBeGreaterThan(20);
    expect(arrowPath({ x: 300, y: 20 }, below, "right").end).toEqual(arrowPath({ x: 300, y: 20 }, below, "down").end);
  });

  it("loops around when the target overlaps the start, instead of drawing a zero-length line", () => {
    const { d, end } = arrowPath({ x: 120, y: 20 }, rect(100, 0));
    expect(end).toEqual({ x: 180, y: 20 });
    expect(d).toContain("C");
    expect(d).not.toBe(`M 120 20 L 180 20`);
  });

  it("never produces NaN for degenerate rectangles", () => {
    const { d } = arrowPath({ x: 0, y: 0 }, { left: 0, top: 0, right: 0, bottom: 0 });
    expect(d).not.toContain("NaN");
  });
});
