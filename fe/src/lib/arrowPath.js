// Geometry for one pointer arrow: from the pointer's dot to the nearest sensible edge of the box it points at.
// Pure on purpose (no DOM): the component measures rectangles, this decides the curve.
const GAP = 8; // how far to the side of the dot a box must lie before we call it "to the right" / "below" / "above"
const BELOW = 16; // a box this far under the dot is entered from the top, even when it is also off to the side
const INSET = 8; // keep top/bottom entry points away from a box's corners
const LOOP_LIFT = 60;

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

const SIDE_EXIT = 64; // how far a stack arrow runs sideways before it bends toward its target

function curve(start, end, axis, exit) {
  const horizontal = axis === "horizontal";
  const reach = Math.max(Math.abs(horizontal ? end.x - start.x : end.y - start.y) / 2, 20);
  const direction = horizontal ? 1 : Math.sign(end.y - start.y) || 1;
  const leavesSideways = horizontal || exit === "right";
  const first = leavesSideways ? { x: start.x + (horizontal ? reach : SIDE_EXIT), y: start.y } : { x: start.x, y: start.y + direction * reach };
  const second = horizontal ? { x: end.x - reach, y: end.y } : { x: end.x, y: end.y - direction * reach };
  return { d: `M ${start.x} ${start.y} C ${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}`, end };
}

/**
 * @param {{x: number, y: number}} start  centre of the pointer's dot
 * @param {{left: number, top: number, right: number, bottom: number}} target  the pointed-at box
 * @param {"right"|"down"} [exit]  which way a vertical arrow leaves the dot: "right" for stack rows (the space beside the
 *   row is empty, so the arrow does not run over the rows below), "down" for dots inside a node box
 * @returns {{d: string, end: {x: number, y: number}}} an SVG path and where it lands (for the arrowhead)
 */
export function arrowPath(start, target, exit = "down") {
  const middle = (target.top + target.bottom) / 2;
  const isAbove = start.x >= target.left + INSET && start.x <= target.right - INSET;
  const entryX = isAbove ? start.x : (target.left + target.right) / 2; // straight down when the dot is over the box, else its centre
  if (target.top >= start.y + BELOW) return curve(start, { x: entryX, y: target.top }, "vertical", exit); // tree children, stack -> heap
  if (target.left >= start.x + GAP) return curve(start, { x: target.left, y: middle }, "horizontal", exit); // list neighbours
  if (target.bottom <= start.y - GAP) return curve(start, { x: entryX, y: target.bottom }, "vertical", exit);
  const end = { x: target.right, y: middle }; // the target surrounds or sits behind the dot: loop over the top and in from the right
  const d = `M ${start.x} ${start.y} C ${start.x + 50} ${start.y - LOOP_LIFT} ${end.x + 50} ${end.y - LOOP_LIFT} ${end.x} ${end.y}`;
  return { d, end };
}
