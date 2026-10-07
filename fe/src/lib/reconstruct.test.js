import { describe, expect, it } from "vitest";
import { isChanged, reconstruct, stdoutAt } from "./reconstruct";

const v = (value) => ({ kind: "int", type: "int", value: String(value) });
const frame = (index, fn, line, vars) => ({ id: `f${index}`, fn, line, vars });
const step = (n, depth, frames, extra = {}) => ({
  n, line: n + 1, fn: "main", event: "step", depth, stdoutLen: 0, keyframe: false, frames, changes: [], skipped: null, ...extra,
});

describe("reconstruct", () => {
  it("returns an empty list for a trace with no steps", () => {
    expect(reconstruct({ steps: [] })).toEqual([]);
  });

  it("carries a step's return value into its view, and null when there is none", () => {
    const returned = { fn: "fact", kind: "int", type: "int", value: "6" };
    const views = reconstruct({ steps: [
      step(0, 1, [frame(0, "main", 1, {})], { keyframe: true }),
      step(1, 1, [], { event: "return", returned }),
      step(2, 1, []),
    ] });
    expect(views[0].returned).toBeNull();
    expect(views[1].returned).toEqual(returned);
    expect(views[2].returned).toBeNull();
  });

  it("a keyframe is taken as the full stack", () => {
    const views = reconstruct({ steps: [step(0, 1, [frame(0, "main", 1, { a: v(1) })], { keyframe: true })] });
    expect(views[0].frames).toHaveLength(1);
    expect(views[0].frames[0].vars.a.value).toBe("1");
  });

  it("an unchanged step keeps the previous frames", () => {
    const views = reconstruct({ steps: [
      step(0, 1, [frame(0, "main", 1, { a: v(1) })], { keyframe: true }),
      step(1, 1, []),
    ] });
    expect(views[1].frames[0].vars.a.value).toBe("1");
  });

  it("a changed frame replaces only its own slot", () => {
    const views = reconstruct({ steps: [
      step(0, 2, [frame(0, "main", 5, {}), frame(1, "f", 1, { n: v(3) })], { keyframe: true }),
      step(1, 2, [frame(1, "f", 2, { n: v(2) })]),
    ] });
    expect(views[1].frames[0].fn).toBe("main");
    expect(views[1].frames[1].vars.n.value).toBe("2");
  });

  it("frames above `depth` are dropped when a function returns", () => {
    const views = reconstruct({ steps: [
      step(0, 2, [frame(0, "main", 5, {}), frame(1, "f", 1, {})], { keyframe: true }),
      step(1, 1, [frame(0, "main", 6, {})]),
    ] });
    expect(views[1].frames).toHaveLength(1);
  });

  it("a new deeper frame is appended at its stack index", () => {
    const views = reconstruct({ steps: [
      step(0, 1, [frame(0, "main", 1, {})], { keyframe: true }),
      step(1, 2, [frame(1, "g", 1, {})]),
    ] });
    expect(views[1].frames.map((f) => f.fn)).toEqual(["main", "g"]);
  });

  it("does not mutate its input or share arrays between views", () => {
    const trace = { steps: [
      step(0, 1, [frame(0, "main", 1, { a: v(1) })], { keyframe: true }),
      step(1, 1, [frame(0, "main", 2, { a: v(2) })]),
    ] };
    const snapshot = JSON.stringify(trace);
    const views = reconstruct(trace);
    expect(JSON.stringify(trace)).toBe(snapshot);
    expect(views[0].frames).not.toBe(views[1].frames);
    expect(views[0].frames[0].vars.a.value).toBe("1");
  });

  it("ignores frames with a malformed id instead of crashing", () => {
    const views = reconstruct({ steps: [
      step(0, 1, [frame(0, "main", 1, {})], { keyframe: true }),
      step(1, 1, [{ id: "__proto__", fn: "x", line: 1, vars: {} }]),
    ] });
    expect(views[1].frames).toHaveLength(1);
  });
});

describe("stdoutAt", () => {
  const trace = { stdout: "hello\n" };
  const views = [{ stdoutLen: 0 }, { stdoutLen: 3 }, { stdoutLen: 6 }];

  it("shows the prefix that had been written at that step", () => {
    expect(stdoutAt(trace, views, 1)).toBe("hel");
  });

  it("shows everything on the last step", () => {
    expect(stdoutAt(trace, [{ stdoutLen: 0 }, { stdoutLen: 0 }], 1)).toBe("hello\n");
  });

  it("handles a trace without steps", () => {
    expect(stdoutAt(trace, [], 0)).toBe("hello\n");
  });

  it("stdoutLen counts bytes, so non-ASCII output is cut on a character boundary", () => {
    const text = { stdout: "héllo→x" }; // h=1 é=2 l=1 l=1 o=1 →=3 x=1 bytes
    const lens = [{ stdoutLen: 3 }, { stdoutLen: 4 }, { stdoutLen: 5 }, { stdoutLen: 7 }, { stdoutLen: 9 }, { stdoutLen: 9 }];
    expect(stdoutAt(text, lens, 0)).toBe("hé"); // 3 bytes = h + é
    expect(stdoutAt(text, lens, 2)).toBe("héll"); // 5 bytes = h + é(2) + l + l
    expect(stdoutAt(text, [{ stdoutLen: 7 }, { stdoutLen: 9 }], 0)).toBe("héllo"); // 7 bytes, before the arrow
  });

  it("never shows a half-written character", () => {
    const text = { stdout: "a→b" };
    const out = stdoutAt(text, [{ stdoutLen: 2 }, { stdoutLen: 5 }], 0); // 2 bytes = 'a' + first byte of '→'
    expect(out).toBe("a");
    expect(out).not.toContain("�");
  });
});

describe("isChanged", () => {
  it("matches a variable path or a whole-frame change", () => {
    expect(isChanged(["f1.vars.n"], 1, "n")).toBe(true);
    expect(isChanged(["f1.vars.n"], 1, "m")).toBe(false);
    expect(isChanged(["f1"], 1, "anything")).toBe(true);
    expect(isChanged(["f0.vars.n"], 1, "n")).toBe(false);
  });
});
