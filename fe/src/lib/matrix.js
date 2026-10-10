// A matrix is an array (or vector) whose items are themselves arrays (or vectors) of plain values: `int m[3][4]` and
// `vector<vector<int>>` both arrive that way. Drawing it as a grid with row and column headers is purely presentation.
const ROW_NAMES = /^(i|r|row|y)$/;
const COL_NAMES = /^(j|c|col|x)$/;

const isRow = (item) => typeof item !== "string" && (item.kind === "array" || item.kind === "seq") && item.items.every((cell) => typeof cell === "string");

/** @returns {{ rows: number, cols: number, jagged: boolean } | null} null when the value is not a grid of scalars. */
export function asMatrix(entry) {
  if ((entry.kind !== "array" && entry.kind !== "seq") || entry.items.length === 0 || !entry.items.every(isRow)) return null;
  const widths = entry.items.map((row) => row.items.length);
  const cols = Math.max(...widths);
  return { rows: entry.items.length, cols, jagged: widths.some((width) => width !== cols) };
}

function indexesOf(vars, pattern, limit) {
  const found = new Map();
  for (const [name, entry] of Object.entries(vars)) {
    if (entry.kind !== "int" || !pattern.test(name)) continue;
    const index = Number(entry.value);
    if (Number.isInteger(index) && index >= 0 && index < limit) found.set(index, [...(found.get(index) ?? []), name]);
  }
  return found;
}

/**
 * Row and column markers from index-named ints (a name-based INFERENCE, like the 1-D array markers), and the cells where a
 * marked row crosses a marked column.
 * @returns {{ rows: Map<number, string[]>, cols: Map<number, string[]>, active: Set<string> }} active holds "row,col" strings
 */
export function matrixMarks(vars, rows, cols) {
  const rowMarks = indexesOf(vars, ROW_NAMES, rows);
  const colMarks = indexesOf(vars, COL_NAMES, cols);
  const active = new Set();
  for (const row of rowMarks.keys()) for (const col of colMarks.keys()) active.add(`${row},${col}`);
  return { rows: rowMarks, cols: colMarks, active };
}
