import { describe, expect, it } from "vitest";
import { indexMarkers } from "./arrayMarkers";

const int = (value) => ({ kind: "int", type: "int", value: String(value) });

describe("indexMarkers", () => {
  it("puts a marker on the cell an index-named int points at", () => {
    const markers = indexMarkers({ i: int(1), j: int(3) }, 6);
    expect(markers.get(1)).toEqual(["i"]);
    expect(markers.get(3)).toEqual(["j"]);
  });

  it("stacks several names on the same cell", () => {
    expect(indexMarkers({ lo: int(2), mid: int(2) }, 5).get(2)).toEqual(["lo", "mid"]);
  });

  it("ignores values outside the array, negative values and non-integers", () => {
    const markers = indexMarkers({ i: int(6), j: int(-1), k: { kind: "float", type: "float", value: "2" } }, 6);
    expect(markers.size).toBe(0);
  });

  it("does not mark `k` when it is the size of a window (k with left/right or lo/hi next to it)", () => {
    expect(indexMarkers({ k: int(3), left: int(1), right: int(4) }, 8).has(3)).toBe(false);
    expect(indexMarkers({ k: int(3), left: int(1), right: int(4) }, 8).get(1)).toEqual(["left"]);
  });

  it("still marks `k` as an index in nested loops (i, j, k)", () => {
    expect(indexMarkers({ i: int(0), j: int(1), k: int(2) }, 8).get(2)).toEqual(["k"]);
  });

  it("ignores ints whose name does not look like an index", () => {
    expect(indexMarkers({ total: int(2), n: int(3), count: int(1) }, 6).size).toBe(0);
  });

  it("reads a pointer variable as no marker (pointers get real arrows instead)", () => {
    const pointer = { kind: "ptr", type: "int *", value: "0x1", addr: "0x1" };
    expect(indexMarkers({ i: pointer }, 4).size).toBe(0);
  });

  it("is safe for a variable literally named __proto__", () => {
    const vars = JSON.parse('{"__proto__": {"kind":"int","type":"int","value":"1"}, "i": {"kind":"int","type":"int","value":"0"}}');
    expect([...indexMarkers(vars, 3).keys()]).toEqual([0]);
  });
});
