import { describe, expect, it } from "vitest";
import { asMatrix, matrixMarks } from "./matrix";

const row = (cells, kind = "array") => ({ kind, type: "int [4]", len: cells.length, items: cells.map(String), elemKind: "int" });
const grid = (rows, kind = "array") => ({ kind, type: "int [3][4]", len: rows.length, items: rows.map((cells) => row(cells, kind)) });
const int = (value) => ({ kind: "int", type: "int", value: String(value) });

describe("asMatrix", () => {
  it("recognises an array of arrays of scalars", () => {
    expect(asMatrix(grid([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]))).toEqual({ rows: 3, cols: 4, jagged: false });
  });

  it("recognises a vector of vectors, including rows of different lengths", () => {
    expect(asMatrix(grid([[1, 2], [3]], "seq"))).toEqual({ rows: 2, cols: 2, jagged: true });
  });

  it("is not a matrix when it is a plain array, empty, or its rows hold structs", () => {
    expect(asMatrix({ kind: "array", len: 2, items: ["1", "2"] })).toBeNull();
    expect(asMatrix({ kind: "array", len: 0, items: [] })).toBeNull();
    const structRows = { kind: "array", len: 1, items: [{ kind: "array", len: 1, items: [{ kind: "struct", fields: [] }] }] };
    expect(asMatrix(structRows)).toBeNull();
  });

  it("is not a matrix when a row is cut off by the 64-item window", () => {
    const clipped = grid([[1, 2]]);
    clipped.items[0].more = 100;
    expect(asMatrix(clipped)).toMatchObject({ rows: 1, cols: 2 });
  });
});

describe("matrixMarks", () => {
  it("puts i and r on rows, j and c on columns, and finds the active cell where they cross", () => {
    const marks = matrixMarks({ i: int(1), j: int(2) }, 3, 4);
    expect(marks.rows.get(1)).toEqual(["i"]);
    expect(marks.cols.get(2)).toEqual(["j"]);
    expect([...marks.active]).toEqual(["1,2"]);
    expect([...matrixMarks({ r: int(0), c: int(1) }, 3, 4).active]).toEqual(["0,1"]);
  });

  it("marks a row or a column on its own when only one index exists", () => {
    const marks = matrixMarks({ i: int(2) }, 3, 4);
    expect(marks.rows.get(2)).toEqual(["i"]);
    expect(marks.cols.size).toBe(0);
    expect(marks.active.size).toBe(0);
  });

  it("ignores values outside the grid and names that are not indexes", () => {
    const marks = matrixMarks({ i: int(3), j: int(-1), total: int(1) }, 3, 4);
    expect(marks.rows.size + marks.cols.size).toBe(0);
  });
});
