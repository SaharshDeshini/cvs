import { describe, expect, it } from "vitest";
import { describeRange, detectRange } from "./rangeHints";

const int = (value) => ({ kind: "int", type: "int", value: String(value) });
const ints = (object) => Object.fromEntries(Object.entries(object).map(([name, value]) => [name, int(value)]));

describe("detectRange", () => {
  it("reads lo/hi with a mid as a search: the live range is lo..hi and mid is marked", () => {
    expect(detectRange(ints({ lo: 0, hi: 7, mid: 3 }), 8)).toMatchObject({ mode: "search", lo: 0, hi: 7, mid: 3, empty: false });
  });

  it("keeps lo/hi (and low/high, first/last) a search even when mid is out of scope between iterations", () => {
    expect(detectRange(ints({ lo: 4, hi: 7 }), 8)).toMatchObject({ mode: "search", lo: 4, hi: 7, mid: null });
    expect(detectRange(ints({ low: 0, high: 3 }), 8)).toMatchObject({ mode: "search" });
    expect(detectRange(ints({ first: 0, last: 3 }), 8)).toMatchObject({ mode: "search" });
  });

  it("keeps left/right and l/r a search on steps where mid is out of scope, once the caller knows this function has a mid", () => {
    expect(detectRange(ints({ left: 0, right: 7 }), 8, { searchHint: true })).toMatchObject({ mode: "search" });
    expect(detectRange(ints({ l: 2, r: 5 }), 8, { searchHint: true })).toMatchObject({ mode: "search" });
    expect(detectRange(ints({ left: 0, right: 7 }), 8)).toMatchObject({ mode: "window" });
  });

  it("does not take a plain `m` for a midpoint: it is too common a name (a matrix size, a count)", () => {
    expect(detectRange(ints({ l: 0, r: 2, m: 3 }), 8)).toMatchObject({ mode: "window", mid: null });
  });

  it("reads left/right as a search when a mid is present (a binary search written with those names)", () => {
    expect(detectRange(ints({ left: 0, right: 7, mid: 3 }), 8)).toMatchObject({ mode: "search", mid: 3 });
  });

  it("reads left/right without a mid as a sliding window", () => {
    expect(detectRange(ints({ left: 2, right: 4 }), 8)).toMatchObject({ mode: "window", lo: 2, hi: 4, mid: null });
  });

  it("knows the usual pairs: low/high, l/r, start/end, first/last", () => {
    for (const [a, b] of [["low", "high"], ["l", "r"], ["start", "end"], ["first", "last"]]) {
      expect(detectRange(ints({ [a]: 1, [b]: 3 }), 8)).toMatchObject({ lo: 1 });
    }
  });

  it("treats `end` as one past the last cell (exclusive)", () => {
    expect(detectRange(ints({ start: 1, end: 4 }), 6)).toMatchObject({ lo: 1, hi: 3 });
  });

  it("treats a hi equal to the array length as exclusive too: an inclusive hi cannot be out of the array", () => {
    expect(detectRange(ints({ lo: 0, hi: 8 }), 8)).toMatchObject({ lo: 0, hi: 7 });
  });

  it("reports an exhausted search (lo past hi) as empty so everything can dim", () => {
    expect(detectRange(ints({ lo: 5, hi: 4, mid: 4 }), 8)).toMatchObject({ mode: "search", empty: true });
    expect(detectRange(ints({ lo: 0, hi: -1, mid: 0 }), 8)).toMatchObject({ mode: "search", empty: true });
  });

  it("returns nothing for a window whose left is past its right", () => {
    expect(detectRange(ints({ left: 5, right: 2 }), 8)).toBeNull();
  });

  it("returns nothing when the numbers cannot be positions in this array", () => {
    expect(detectRange(ints({ lo: -1, hi: 3 }), 8)).toBeNull();
    expect(detectRange(ints({ lo: 9, hi: 9 }), 8)).toBeNull();
    expect(detectRange(ints({ lo: 0, hi: 20 }), 8)).toBeNull();
  });

  it("returns nothing without a complete pair, or when a member is not an int", () => {
    expect(detectRange(ints({ lo: 1, mid: 2 }), 8)).toBeNull();
    expect(detectRange({ left: { kind: "ptr", type: "int *", value: "0x1", addr: "0x1" }, right: int(3) }, 8)).toBeNull();
  });

  it("ignores a mid that is outside the array", () => {
    expect(detectRange(ints({ lo: 0, hi: 7, mid: 99 }), 8)).toMatchObject({ mode: "search", mid: null });
  });

  it("is safe for a variable named __proto__", () => {
    const vars = JSON.parse('{"__proto__": {"kind":"int","type":"int","value":"1"}, "lo": {"kind":"int","type":"int","value":"0"}, "hi": {"kind":"int","type":"int","value":"3"}}');
    expect(detectRange(vars, 8)).toMatchObject({ lo: 0, hi: 3 });
  });
});

describe("describeRange", () => {
  it("names the live range and the middle", () => {
    expect(describeRange({ mode: "search", lo: 3, hi: 7, mid: 5, empty: false })).toBe("search range [3..7] · mid 5");
  });

  it("says when the search range is empty", () => {
    expect(describeRange({ mode: "search", lo: 5, hi: 4, mid: null, empty: true })).toBe("search range empty");
  });

  it("describes a window with its width", () => {
    expect(describeRange({ mode: "window", lo: 2, hi: 4, mid: null, empty: false })).toBe("window [2..4] · 3 cells");
    expect(describeRange({ mode: "window", lo: 2, hi: 2, mid: null, empty: false })).toBe("window [2..2] · 1 cell");
  });
});
