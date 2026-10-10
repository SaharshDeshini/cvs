import { describe, expect, it } from "vitest";
import { chainWindow, pointerTags, tagsFor } from "./pointerTags";

const edge = (from, to, extra = {}) => ({ from, to, dangling: false, ref: false, ...extra });

describe("pointerTags", () => {
  it("tags the box a stack variable points at with the variable's name", () => {
    const tags = pointerTags([edge("s0/p", "s0/a[2]")]);
    expect(tags.get("s0/a[2]")).toEqual(["p"]);
  });

  it("collects several names on one target, in order, without repeats", () => {
    const tags = pointerTags([edge("s0/slow", "h0x10"), edge("s0/fast", "h0x10"), edge("s1/slow", "h0x10")]);
    expect(tags.get("h0x10")).toEqual(["slow", "fast"]);
  });

  it("ignores pointers that live inside a node or an array (a next field, a cell): those are links, not named variables", () => {
    expect(pointerTags([edge("h0x10.next", "h0x20"), edge("s0/ptrs[1]", "h0x20")]).size).toBe(0);
  });

  it("ignores a dangling pointer: it points at nothing live", () => {
    expect(pointerTags([edge("s0/p", "h0x10", { dangling: true })]).size).toBe(0);
  });
});

describe("tagsFor", () => {
  const tags = new Map([["h0x10", ["head"]], ["h0x10.value", ["pv"]], ["h0x100", ["other"]], ["s0/a[2]", ["p"]]]);

  it("returns the names on the box itself and on anything inside it", () => {
    expect(tagsFor(tags, "h0x10")).toEqual(["head", "pv"]);
  });

  it("does not match a box whose key merely starts with the same characters", () => {
    expect(tagsFor(tags, "h0x10")).not.toContain("other");
    expect(tagsFor(tags, "h0x1")).toEqual([]);
  });

  it("is empty for a box nobody points at", () => {
    expect(tagsFor(tags, "h0x99")).toEqual([]);
  });
});

describe("chainWindow", () => {
  const chain = ["0x1", "0x2", "0x3", "0x4", "0x5"];
  const key = (address) => `h${address}`;

  it("covers the nodes from the left pointer to the right pointer, inclusive", () => {
    const tags = new Map([["h0x2", ["left"]], ["h0x4", ["right"]]]);
    expect([...chainWindow(chain, tags, key)]).toEqual(["0x2", "0x3", "0x4"]);
  });

  it("does not care which pointer is nearer the head", () => {
    const tags = new Map([["h0x4", ["left"]], ["h0x2", ["right"]]]);
    expect([...chainWindow(chain, tags, key)]).toEqual(["0x2", "0x3", "0x4"]);
  });

  it("is a single node when both pointers are on it", () => {
    const tags = new Map([["h0x3", ["l", "r"]]]);
    expect([...chainWindow(chain, tags, key)]).toEqual(["0x3"]);
  });

  it("does not call a queue's first/last (or low/high) a window: only left/right-style pairs are", () => {
    const tags = new Map([["h0x1", ["first"]], ["h0x5", ["last"]]]);
    expect(chainWindow(chain, tags, key).size).toBe(0);
    expect(chainWindow(chain, new Map([["h0x1", ["low"]], ["h0x5", ["high"]]]), key).size).toBe(0);
    expect([...chainWindow(chain, new Map([["h0x2", ["start"]], ["h0x3", ["end"]]]), key)]).toEqual(["0x2", "0x3"]);
  });

  it("is empty without a complete pair on the chain (slow/fast is not a window)", () => {
    expect(chainWindow(chain, new Map([["h0x2", ["slow"]], ["h0x4", ["fast"]]]), key).size).toBe(0);
    expect(chainWindow(chain, new Map([["h0x2", ["left"]]]), key).size).toBe(0);
    expect(chainWindow(chain, new Map(), key).size).toBe(0);
  });
});
