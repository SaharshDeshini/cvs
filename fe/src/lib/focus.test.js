import { describe, expect, it } from "vitest";
import { isRelated } from "./focus";

const edge = (from, to) => ({ from, to });

describe("isRelated", () => {
  it("matches an edge that leaves or enters the focused box exactly", () => {
    expect(isRelated(edge("s0/head", "h0x10"), "s0/head")).toBe(true);
    expect(isRelated(edge("s0/head", "h0x10"), "h0x10")).toBe(true);
  });

  it("matches pointers that live inside the focused box (a node's next field)", () => {
    expect(isRelated(edge("h0x10.next", "h0x20"), "h0x10")).toBe(true);
    expect(isRelated(edge("s0/a[2]", "h0x20"), "s0/a")).toBe(true);
  });

  it("matches an edge that lands inside the focused box", () => {
    expect(isRelated(edge("s0/p", "s0/a[2]"), "s0/a")).toBe(true);
  });

  it("does not match a box whose name merely starts with the same letters", () => {
    expect(isRelated(edge("s0/ab", "h0x10"), "s0/a")).toBe(false);
    expect(isRelated(edge("h0x100.next", "h0x20"), "h0x10")).toBe(false);
  });

  it("matches nothing when nothing is focused", () => {
    expect(isRelated(edge("s0/p", "h0x10"), null)).toBe(false);
  });
});
