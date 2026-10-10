import { describe, expect, it } from "vitest";
import { classifyOrphans } from "./heapLifetime";

// A step only needs its heap table here: block address -> { live, orphan? }.
const alive = (extra = {}) => ({ kind: "block", size: 16, live: true, ...extra });
const step = (heap) => ({ heap });

describe("classifyOrphans", () => {
  it("calls an orphan 'pending' when a later step reaches it again (the pointer was only in a register)", () => {
    const views = [
      step({ "0x10": alive({ orphan: true }) }),
      step({ "0x10": alive() }),
    ];
    const [first, second] = classifyOrphans(views);
    expect(first.get("0x10")).toBe("pending");
    expect(second.has("0x10")).toBe(false);
  });

  it("calls an orphan 'leaked' when nothing reaches it again before the run ends", () => {
    const views = [step({ "0x10": alive() }), step({ "0x10": alive({ orphan: true }) }), step({ "0x10": alive({ orphan: true }) })];
    const result = classifyOrphans(views);
    expect(result[1].get("0x10")).toBe("leaked");
    expect(result[2].get("0x10")).toBe("leaked");
  });

  it("calls an orphan 'leaked' when it is freed before anything reaches it again", () => {
    const views = [step({ "0x10": alive({ orphan: true }) }), step({ "0x10": { kind: "block", size: 16, live: false } })];
    expect(classifyOrphans(views)[0].get("0x10")).toBe("leaked");
  });

  it("does not let a later allocation at a reused address rescue an earlier leak", () => {
    const views = [
      step({ "0x10": alive({ orphan: true }) }),
      step({}), // the block is gone (freed and forgotten)
      step({ "0x10": alive() }), // a different allocation at the same address, reachable
    ];
    expect(classifyOrphans(views)[0].get("0x10")).toBe("leaked");
  });

  it("keeps blocks that are reachable out of the result entirely", () => {
    const views = [step({ "0x10": alive(), "0x20": alive({ orphan: true }) }), step({ "0x10": alive() })];
    const [first] = classifyOrphans(views);
    expect([...first.keys()]).toEqual(["0x20"]);
  });

  it("does not call an orphan leaked when the run was cut short: the program never got to store the pointer", () => {
    const views = [step({ "0x10": alive({ orphan: true }) }), step({ "0x10": alive({ orphan: true }) })];
    expect(classifyOrphans(views, { complete: false }).map((m) => m.get("0x10"))).toEqual(["pending", "pending"]);
    expect(classifyOrphans(views, { complete: true }).map((m) => m.get("0x10"))).toEqual(["leaked", "leaked"]);
  });

  it("returns one map per step, in order, and does not change its input", () => {
    const views = Object.freeze([step({ "0x10": alive({ orphan: true }) })]);
    expect(classifyOrphans(views)).toHaveLength(1);
    expect(classifyOrphans([])).toEqual([]);
  });
});
