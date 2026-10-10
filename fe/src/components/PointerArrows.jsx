import { useLayoutEffect, useState } from "react";
import { arrowPath } from "../lib/arrowPath";
import { isRelated } from "../lib/focus";

const NO_PATHS = [];

function indexByAttribute(container, attribute) {
  const found = new Map();
  container.querySelectorAll(`[${attribute}]`).forEach((element) => found.set(element.getAttribute(attribute), element));
  return found;
}

function relativeRect(rect, origin) {
  return { left: rect.left - origin.left, top: rect.top - origin.top, right: rect.right - origin.left, bottom: rect.bottom - origin.top };
}

/** Measures every arrow's two ends in the container's own coordinate space; an edge whose end is not on screen is skipped. */
function measureArrows(container, edges, changed) {
  const origin = container.getBoundingClientRect();
  const dots = indexByAttribute(container, "data-src");
  const boxes = indexByAttribute(container, "data-key");
  const paths = [];
  edges.forEach((edge, index) => {
    const dot = dots.get(edge.from);
    const box = boxes.get(edge.to);
    if (!dot || !box) return;
    const dotRect = relativeRect(dot.getBoundingClientRect(), origin);
    const start = { x: (dotRect.left + dotRect.right) / 2, y: (dotRect.top + dotRect.bottom) / 2 };
    const exit = dot.closest(".is-node") ? "down" : "right"; // inside a list/tree node vs a row of the call stack
    const boxRect = relativeRect(box.getBoundingClientRect(), origin);
    const { d } = arrowPath(start, boxRect, exit);
    const tone = edge.dangling ? "dangling" : changed.has(edge.from) ? "changed" : "normal";
    paths.push({ id: `${edge.from}>${edge.to}#${index}`, d, tone, start, from: edge.from, to: edge.to, box: boxRect });
  });
  return paths;
}

/**
 * The arrows between pointers and what they point at, drawn over the stack and heap panels. They are measured from the
 * real layout, so they stay attached when the page resizes or a panel scrolls. `layoutKey` changes when the content does.
 * `focus` (a box key the mouse is over) lights up that pointer's arrows and rings what they point at; the rest fade.
 */
export default function PointerArrows({ containerRef, edges, changed, layoutKey, focus = null }) {
  const [paths, setPaths] = useState(NO_PATHS);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const measure = () => setPaths(measureArrows(container, edges, changed));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    container.addEventListener("scroll", measure, true); // nested scrollers (a wide tree) move the boxes under the arrows
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", measure, true);
    };
  }, [containerRef, edges, changed, layoutKey]);

  const related = focus ? paths.filter((path) => isRelated(path, focus)) : NO_PATHS;
  const active = related.length > 0; // a stale focus (its box is gone after a step) must not fade every arrow for nothing
  return (
    <svg className={`arrows${active ? " has-focus" : ""}`} aria-hidden="true" focusable="false">
      <defs>
        {["normal", "changed", "dangling"].map((tone) => (
          <marker key={tone} id={`arrowhead-${tone}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className={`arrowhead arrowhead-${tone}`} />
          </marker>
        ))}
      </defs>
      {paths.map((path) => (
        <g key={path.id} className={active ? (related.includes(path) ? "is-focus" : "is-dim") : undefined}>
          <circle cx={path.start.x} cy={path.start.y} r="3.5" className={`arrow-origin arrow-${path.tone}`} />
          <path d={path.d} className={`arrow arrow-${path.tone}`} markerEnd={`url(#arrowhead-${path.tone})`} />
        </g>
      ))}
      {related.map((path) => (
        <rect key={`ring-${path.id}`} className="focus-ring" x={path.box.left - 4} y={path.box.top - 4} width={path.box.right - path.box.left + 8} height={path.box.bottom - path.box.top + 8} rx="9" />
      ))}
    </svg>
  );
}
