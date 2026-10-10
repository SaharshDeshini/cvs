import { describe, expect, it } from "vitest";
import { detectBugs, findingStep } from "./bugs";

const ptr = (addr, state, extra = {}) => ({ kind: "ptr", type: "Node *", value: addr, addr, to: "Node", state, ...extra });
const frame = (vars, fn = "main", line = 1) => ({ fn, line, vars });
const step = (vars, heap = {}, extra = {}) => ({ frames: [frame(vars)], heap, line: 1, ...extra });
const live = (extra = {}) => ({ kind: "block", size: 16, live: true, ...extra });
const freed = () => ({ kind: "block", size: 16, live: false });
const ok = { status: "ok", signal: null, crashLine: null };

describe("detectBugs: leaks", () => {
  it("reports one leak event at the first step a block is unreachable for good, with its byte count", () => {
    const views = [
      step({ p: ptr("0x10", "heap", { block: "0x10" }) }, { "0x10": live() }),
      step({}, { "0x10": live({ orphan: true }) }),
      step({}, { "0x10": live({ orphan: true }) }),
    ];
    const bugs = detectBugs(views, ok);
    expect(bugs).toHaveLength(1);
    expect(bugs[0]).toMatchObject({ kind: "leak", step: 1 });
    expect(bugs[0].detail).toMatch(/16 bytes/);
  });

  it("does not report a block that is only in transit (reachable again later)", () => {
    const views = [step({}, { "0x10": live({ orphan: true }) }), step({ p: ptr("0x10", "heap", { block: "0x10" }) }, { "0x10": live() })];
    expect(detectBugs(views, ok)).toEqual([]);
  });

  it("does not claim a leak when the run was cut short", () => {
    const views = [step({}, { "0x10": live({ orphan: true }) })];
    expect(detectBugs(views, { status: "runtime_error", signal: "SIGSEGV", crashLine: 4 }).some((bug) => bug.kind === "leak")).toBe(false);
  });
});

describe("detectBugs: dangling pointers", () => {
  it("reports the first step a variable points at freed memory, once per variable", () => {
    const dangling = { p: ptr("0x10", "freed", { block: "0x10" }) };
    const views = [step({ p: ptr("0x10", "heap", { block: "0x10" }) }, { "0x10": live() }), step(dangling, { "0x10": freed() }), step(dangling, { "0x10": freed() })];
    const bugs = detectBugs(views, ok);
    expect(bugs.filter((bug) => bug.kind === "dangling")).toHaveLength(1);
    expect(bugs[0]).toMatchObject({ kind: "dangling", step: 1 });
    expect(bugs[0].title).toMatch(/: p$/);
  });
});

describe("detectBugs: the delete-then-reassign idiom", () => {
  it("does not flag a pointer that is dangling for a single step (delete p; p = next;)", () => {
    const views = [
      step({ p: ptr("0x10", "heap", { block: "0x10" }) }, { "0x10": live() }),
      step({ p: ptr("0x10", "freed", { block: "0x10" }) }, { "0x10": freed() }),
      step({ p: ptr("0x0", "null") }, { "0x10": freed() }),
    ];
    expect(detectBugs(views, ok).filter((bug) => bug.kind === "dangling")).toEqual([]);
  });

  it("reports it again if the same variable dangles in a later, separate stretch", () => {
    const dangling = { p: ptr("0x10", "freed", { block: "0x10" }) };
    const clean = { p: ptr("0x0", "null") };
    const views = [step(dangling), step(dangling), step(clean), step(dangling), step(dangling)];
    expect(detectBugs(views, ok).filter((bug) => bug.kind === "dangling").map((bug) => bug.step)).toEqual([0, 3]);
  });
});

describe("detectBugs: dangling pointers across frames and at a crash", () => {
  it("keeps same-named variables of different frames of one function apart (recursion)", () => {
    const dangling = ptr("0x10", "freed", { block: "0x10" });
    const clean = ptr("0x0", "null");
    const both = (outer, inner) => ({ frames: [frame({ p: outer }, "f"), frame({ p: inner }, "f")], heap: {}, line: 1 });
    // the outer frame's p dangles for two steps, then the INNER frame's p does: two separate findings
    const views = [both(dangling, clean), both(dangling, clean), both(clean, dangling), both(clean, dangling)];
    const events = detectBugs(views, ok).filter((bug) => bug.kind === "dangling");
    expect(events.map((bug) => bug.step)).toEqual([0, 2]);
  });

  it("reports a pointer that has dangled for only one step when the run then crashed", () => {
    const views = [step({ p: ptr("0x10", "heap", { block: "0x10" }) }, { "0x10": live() }), step({ p: ptr("0x10", "freed", { block: "0x10" }) }, { "0x10": freed() })];
    const bugs = detectBugs(views, { status: "runtime_error", signal: "SIGSEGV", crashLine: 3 });
    expect(bugs.map((bug) => bug.kind)).toEqual(["dangling", "crash"]);
  });
});

describe("detectBugs: crash causes are not guessed from unrelated variables", () => {
  const crash = { status: "runtime_error", signal: "SIGSEGV", crashLine: 2 };

  it("names a null pointer only when the crashing line mentions it", () => {
    const views = [step({ prev: ptr("0x0", "null"), q: ptr("0x0", "null") })];
    const source = "int main() {\n  int v = q->value;\n}";
    const [bug] = detectBugs(views, crash, { source });
    expect(bug.detail).toMatch(/\bq\b/);
    expect(bug.detail).not.toMatch(/\bprev\b/);
  });

  it("does not name any variable when the crashing line mentions none of the null pointers", () => {
    const views = [step({ prev: ptr("0x0", "null") })];
    const [bug] = detectBugs(views, crash, { source: "int main() {\n  a[100000] = 1;\n}" });
    expect(bug.detail).not.toMatch(/prev/);
    expect(bug.detail).toMatch(/likely/i);
  });

  it("says infinite recursion first when the stack is very deep", () => {
    const deep = { frames: Array.from({ length: 60 }, () => frame({}, "f")), heap: {}, line: 1, depth: 60 };
    const [bug] = detectBugs([deep], crash);
    expect(bug.detail).toMatch(/recursion/i);
    expect(bug.detail).toMatch(/60/);
  });
});

describe("detectBugs: how the run ended", () => {
  it("marks the last step with the crash signal and line", () => {
    const views = [step({}), step({})];
    const bugs = detectBugs(views, { status: "runtime_error", signal: "SIGSEGV", crashLine: 7 });
    expect(bugs.at(-1)).toMatchObject({ kind: "crash", step: 1, line: 7 });
    expect(bugs.at(-1).title).toMatch(/SIGSEGV/);
  });

  it("names a null pointer as the likely cause of a SIGSEGV and labels it as a guess", () => {
    const views = [step({ q: ptr("0x0", "null") })];
    const [crash] = detectBugs(views, { status: "runtime_error", signal: "SIGSEGV", crashLine: 3 });
    expect(crash.detail).toMatch(/likely/i);
    expect(crash.detail).toMatch(/\bq\b/);
  });

  it("explains SIGABRT as a guess, not a fact", () => {
    const [crash] = detectBugs([step({})], { status: "runtime_error", signal: "SIGABRT", crashLine: 3 });
    expect(crash.detail).toMatch(/often|possibly|may/i);
  });

  it("reports a timeout and a step-limit stop", () => {
    expect(detectBugs([step({})], { status: "timeout", signal: null, crashLine: null }).at(-1)).toMatchObject({ kind: "timeout" });
    expect(detectBugs([step({})], { status: "truncated", signal: null, crashLine: null }).at(-1)).toMatchObject({ kind: "timeout" });
  });

  it("reports nothing for a clean run and for no steps at all", () => {
    expect(detectBugs([step({})], ok)).toEqual([]);
    expect(detectBugs([], ok)).toEqual([]);
  });
});

describe("findingStep (the [ and ] shortcuts)", () => {
  const found = [{ step: 3 }, { step: 3 }, { step: 9 }, { step: 20 }];

  it("goes to the next problem strictly after the current step", () => {
    expect(findingStep(found, 0, 1)).toBe(3);
    expect(findingStep(found, 3, 1)).toBe(9);
    expect(findingStep(found, 9, 1)).toBe(20);
  });

  it("goes to the previous problem strictly before the current step", () => {
    expect(findingStep(found, 20, -1)).toBe(9);
    expect(findingStep(found, 9, -1)).toBe(3);
    expect(findingStep(found, 5, -1)).toBe(3);
  });

  it("returns null when there is no problem in that direction, or none at all", () => {
    expect(findingStep(found, 20, 1)).toBeNull();
    expect(findingStep(found, 3, -1)).toBeNull();
    expect(findingStep([], 0, 1)).toBeNull();
  });
});
