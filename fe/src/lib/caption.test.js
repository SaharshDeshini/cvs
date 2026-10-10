import { describe, expect, it } from "vitest";
import { captionFor } from "./caption";

const int = (value) => ({ kind: "int", type: "int", value: String(value) });
const ptr = (addr, extra = {}) => ({ kind: "ptr", type: "Node *", value: addr, addr, to: "Node", state: addr === "0x0" ? "null" : "heap", ...extra });
const frame = (vars, fn = "main") => ({ fn, line: 1, vars });
const view = (vars, extra = {}) => ({ frames: [frame(vars)], heap: {}, line: 5, event: "step", returned: null, changes: [], ...extra });

describe("captionFor", () => {
  it("says what a changed number became, old to new", () => {
    expect(captionFor(view({ sum: int(10) }), view({ sum: int(6) }))).toBe("sum changed 6 → 10");
  });

  it("says a variable now exists when it was just declared", () => {
    expect(captionFor(view({ total: int(0) }), view({}))).toBe("total declared = 0");
  });

  it("describes a pointer by where it points, or that it is null", () => {
    expect(captionFor(view({ head: ptr("0x5550") }), view({ head: ptr("0x0") }))).toBe("head now points to @…5550");
    expect(captionFor(view({ head: ptr("0x0") }), view({ head: ptr("0x5550") }))).toBe("head is now null");
  });

  it("says a pointer targets freed memory", () => {
    expect(captionFor(view({ p: ptr("0x10", { state: "freed" }) }), view({ p: ptr("0x10") }))).toBe("p now points to freed memory @…0x10");
  });

  it("mentions a call by the function entered", () => {
    const current = view({ n: int(3) }, { event: "call", frames: [frame({}), frame({ n: int(3) }, "factorial")] });
    expect(captionFor(current, view({}))).toBe("Entered factorial()");
  });

  it("reports what a function returned", () => {
    const current = view({ total: int(1) }, { event: "return", returned: { fn: "factorial", kind: "int", value: "6" } });
    expect(captionFor(current, view({ total: int(1) }))).toBe("factorial() returned 6");
  });

  it("reports an allocation and a free by size", () => {
    const born = view({}, { heap: { "0x10": { kind: "block", size: 16, live: true } } });
    expect(captionFor(born, view({}))).toBe("Allocated 16 bytes at @…0x10");
    const released = view({}, { heap: { "0x10": { kind: "block", size: 16, live: false } } });
    expect(captionFor(released, born)).toBe("Freed 16 bytes at @…0x10");
  });

  it("lists up to two changes and counts the rest", () => {
    const before = view({ a: int(1), b: int(1), c: int(1) });
    const after = view({ a: int(2), b: int(2), c: int(2) });
    expect(captionFor(after, before)).toBe("a changed 1 → 2; b changed 1 → 2 (+1 more)");
  });

  it("treats a new variable named like an Object.prototype member as new, not changed", () => {
    expect(captionFor(view({ constructor: int(5) }), view({}))).toBe("constructor declared = 5");
  });

  it("says a variable is unreadable instead of printing the debugger's error text", () => {
    const broken = { kind: "unavailable", type: "int", value: "value has been optimized out" };
    expect(captionFor(view({ x: broken }), view({}))).toBe("x unreadable");
  });

  it("falls back to the line number when nothing observable changed", () => {
    expect(captionFor(view({ a: int(1) }), view({ a: int(1) }))).toBe("Line 5");
  });

  it("works with no previous step", () => {
    expect(captionFor(view({}), null)).toBe("Line 5");
  });
});
