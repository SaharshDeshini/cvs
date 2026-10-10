import { createContext, useContext } from "react";
import { asMatrix } from "../lib/matrix";
import { tagsFor } from "../lib/pointerTags";
import { describeRange } from "../lib/rangeHints";
import { cellKey, fieldKey, mapPartKey } from "../lib/valueKeys";

/** What the diagram knows about this step: which values just changed, which pointers have an arrow to draw, and `tags`:
 *  box key -> names of the stack variables pointing at it (shown ON the data, see lib/pointerTags). */
export const DiagramContext = createContext({ changed: new Set(), born: new Set(), sources: new Set(), tags: new Map(), searchFns: new Set() });
const NO_MARKERS = new Map();
const NO_MATRIX_MARKS = { rows: new Map(), cols: new Map(), active: new Set() };

export const shortAddress = (address) => (address.length > 8 ? `0x…${address.slice(-4)}` : address);
const isChanged = (changed, key) => (changed.has(key) ? " is-changed" : "");

function PointerValue({ entry, path }) {
  const { changed, sources } = useContext(DiagramContext);
  const isNull = entry.state === "null" || entry.addr === "0x0";
  let text = `${entry.ref ? "&" : ""}${shortAddress(entry.addr ?? entry.value)}`;
  if (isNull) text = "null";
  else if (entry.fn) text = "function";
  else if (entry.state === "freed") text = `freed ${shortAddress(entry.addr)}`;
  else if (typeof entry.text === "string") text = `"${entry.text}"`;
  const tone = isNull ? " is-null" : entry.state === "freed" ? " is-freed" : "";
  const hasArrow = sources.has(path);
  return (
    <span className={`ptr${tone}${hasArrow ? " has-arrow" : ""}${isChanged(changed, path)}`} data-key={path} title={entry.value}>
      <span className="ptr-text">{text}</span>
      {hasArrow && <span className="ptr-dot" data-src={path} aria-hidden="true" />}
    </span>
  );
}

function ScalarValue({ entry, path }) {
  const { changed } = useContext(DiagramContext);
  // keyed on the text so the flash animation restarts whenever the value changes
  return <span key={entry.value} data-key={path} className={`var-value kind-${entry.kind}${isChanged(changed, path)}`}>{entry.value}</span>;
}

/** An array or container member is either plain text (a scalar) or a whole entry (struct, pointer, nested array...). */
function Member({ item, kind, path }) {
  const { changed } = useContext(DiagramContext);
  if (typeof item !== "string") return <ValueView entry={item} path={path} />;
  return <span key={item} className={`cell-text kind-${kind ?? "int"}${isChanged(changed, path)}`}>{item}</span>;
}

/** How a cell sits in the live range: inside it, outside it (dimmed in a search), or the middle being probed. */
function rangeClass(range, index) {
  if (!range) return "";
  if (range.empty || index < range.lo || index > range.hi) return " out-range"; // a stale mid outside the range is not lit
  return range.mode === "search" && index === range.mid ? " in-range is-mid" : " in-range";
}

function ArrayView({ entry, path, markers, range }) {
  const { changed, tags } = useContext(DiagramContext);
  const isContainer = entry.kind === "seq";
  const pointerNames = entry.items.map((_, index) => tagsFor(tags, cellKey(path, index)));
  const hasMarks = markers.size > 0 || pointerNames.some((names) => names.length > 0);
  return (
    <div className="array" data-key={path} role="group" aria-label={`${isContainer ? entry.container : "array"} of ${entry.len}`}>
      {isContainer && <div className="array-meta">{entry.container} · {entry.len} {entry.len === 1 ? "item" : "items"}</div>}
      {range && <div className={`range-chip is-${range.mode}`} title="Guessed from the variable names: not something the program states">{describeRange(range)}</div>}
      <div className={`array-cells${range ? ` range-${range.mode}` : ""}${hasMarks ? " has-marks" : ""}`}>
        {entry.items.map((item, index) => (
          <div key={index} className={`cell${isChanged(changed, cellKey(path, index))}${markers.has(index) ? " has-marker" : ""}${rangeClass(range, index)}`} data-key={cellKey(path, index)}>
            <span className="cell-index">{index}</span>
            <Member item={item} kind={entry.elemKind} path={cellKey(path, index)} />
            {(markers.has(index) || pointerNames[index].length > 0) && (
              <span className="cell-marks">
                {markers.has(index) && <span className="cell-marker">{markers.get(index).join(", ")}</span>}
                {pointerNames[index].length > 0 && <span className="cell-tag">{pointerNames[index].join(", ")}</span>}
              </span>
            )}
          </div>
        ))}
        {entry.more > 0 && <div className="cell cell-more" title={`${entry.len} items in total`}>+{entry.more} more</div>}
        {entry.len === 0 && <div className="cell cell-more">empty</div>}
      </div>
    </div>
  );
}

const joined = (names) => (names ? names.join(", ") : "");

/**
 * A matrix as a real grid: column numbers across the top, row numbers down the side, the cell where a marked row and a marked
 * column cross highlighted, and the marked row and column tinted. `marks` is lib/matrix.matrixMarks (a name-based inference).
 */
function MatrixView({ entry, path, grid, marks }) {
  const { changed, tags } = useContext(DiagramContext);
  const columns = Array.from({ length: grid.cols }, (_, col) => col);
  const label = `${grid.rows} by ${grid.cols} ${entry.kind === "seq" ? entry.container ?? "vector" : "array"}`;
  return (
    <div className="matrix" data-key={path} role="group" aria-label={label}>
      <div className="array-meta">{label}{grid.jagged ? " (rows differ in length)" : ""}</div>
      <table className="matrix-grid">
        <thead>
          <tr>
            <td className="mx-corner" />
            {columns.map((col) => (
              <th key={col} scope="col" className={`mx-head${marks.cols.has(col) ? " is-marked" : ""}`}>
                <span className="mx-index">{col}</span>
                {marks.cols.has(col) && <span className="mx-name">{joined(marks.cols.get(col))}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entry.items.map((row, r) => (
            <tr key={r} data-key={cellKey(path, r)} className={marks.rows.has(r) ? "row-on" : undefined}>
              <th scope="row" className={`mx-head${marks.rows.has(r) ? " is-marked" : ""}`}>
                <span className="mx-index">{r}</span>
                {marks.rows.has(r) && <span className="mx-name">{joined(marks.rows.get(r))}</span>}
              </th>
              {columns.map((col) => {
                const key = cellKey(cellKey(path, r), col);
                const value = row.items[col];
                if (value === undefined) return <td key={col} className="mx-cell mx-empty" />;
                const names = tagsFor(tags, key);
                const state = `${marks.active.has(`${r},${col}`) ? " is-active" : ""}${marks.cols.has(col) ? " col-on" : ""}${isChanged(changed, key)}`;
                return (
                  <td key={col} className={`mx-cell${state}`} data-key={key}>
                    <span key={value} className="mx-value">{value}</span>
                    {names.length > 0 && <span className="cell-tag">{names.join(", ")}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
          {entry.more > 0 && <tr><th scope="row" className="mx-head" /><td className="mx-more" colSpan={grid.cols}>+{entry.more} more rows</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function StructView({ entry, path, variant }) {
  return (
    <ul className={`struct-fields${variant === "node" ? " is-node" : ""}`} data-key={path}>
      {entry.fields.map((field, index) => (
        <li key={index} className="struct-field">
          <span className="field-name">{field.name || "·"}</span>
          <ValueView entry={field.v} path={fieldKey(path, field.name)} />
        </li>
      ))}
      {entry.more && <li className="struct-field struct-more">…</li>}
    </ul>
  );
}

function MapView({ entry, path }) {
  return (
    <div className="map" data-key={path} role="group" aria-label={`${entry.container} of ${entry.len}`}>
      <div className="array-meta">{entry.container} · {entry.len} {entry.len === 1 ? "entry" : "entries"}</div>
      <ul className="map-rows">
        {entry.items.map((pair, index) => (
          <li key={index} className="map-row">
            <Member item={pair.k} kind={entry.elemKind} path={mapPartKey(path, index, "k")} />
            <span className="map-arrow" aria-hidden="true">→</span>
            <Member item={pair.v} kind={entry.elemKind} path={mapPartKey(path, index, "v")} />
          </li>
        ))}
        {entry.more > 0 && <li className="map-row struct-more">+{entry.more} more</li>}
      </ul>
    </div>
  );
}

/**
 * One value of any kind. `path` is the box's key (lib/valueKeys); `markers` (arrays only) maps cell index -> loop
 * variable names to show under that cell; `variant="node"` lays a struct out as the compartments of a list/tree node.
 */
export default function ValueView({ entry, path, markers = NO_MARKERS, variant, range = null, matrix = null }) {
  switch (entry.kind) {
    case "array":
    case "seq": {
      const grid = matrix?.grid ?? asMatrix(entry);
      if (grid) return <MatrixView entry={entry} path={path} grid={grid} marks={matrix?.marks ?? NO_MATRIX_MARKS} />;
      return <ArrayView entry={entry} path={path} markers={markers} range={range} />;
    }
    case "struct":
      return <StructView entry={entry} path={path} variant={variant} />;
    case "map":
      return <MapView entry={entry} path={path} />;
    case "ptr":
      return <PointerValue entry={entry} path={path} />;
    case "string":
      return <span className="var-value kind-string" data-key={path}>&quot;{entry.value}&quot;</span>;
    default:
      return <ScalarValue entry={entry} path={path} />;
  }
}
