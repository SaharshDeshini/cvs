import { createContext, useContext } from "react";
import { cellKey, fieldKey, mapPartKey } from "../lib/valueKeys";

/** What the diagram knows about this step: which values just changed, and which pointers have an arrow to draw. */
export const DiagramContext = createContext({ changed: new Set(), born: new Set(), sources: new Set() });
const NO_MARKERS = new Map();

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

function ArrayView({ entry, path, markers }) {
  const { changed } = useContext(DiagramContext);
  const isContainer = entry.kind === "seq";
  return (
    <div className="array" data-key={path} role="group" aria-label={`${isContainer ? entry.container : "array"} of ${entry.len}`}>
      {isContainer && <div className="array-meta">{entry.container} · {entry.len} {entry.len === 1 ? "item" : "items"}</div>}
      <div className="array-cells">
        {entry.items.map((item, index) => (
          <div key={index} className={`cell${isChanged(changed, cellKey(path, index))}${markers.has(index) ? " has-marker" : ""}`} data-key={cellKey(path, index)}>
            <span className="cell-index">{index}</span>
            <Member item={item} kind={entry.elemKind} path={cellKey(path, index)} />
            {markers.has(index) && <span className="cell-marker">{markers.get(index).join(", ")}</span>}
          </div>
        ))}
        {entry.more > 0 && <div className="cell cell-more" title={`${entry.len} items in total`}>+{entry.more} more</div>}
        {entry.len === 0 && <div className="cell cell-more">empty</div>}
      </div>
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
export default function ValueView({ entry, path, markers = NO_MARKERS, variant }) {
  switch (entry.kind) {
    case "array":
    case "seq":
      return <ArrayView entry={entry} path={path} markers={markers} />;
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
