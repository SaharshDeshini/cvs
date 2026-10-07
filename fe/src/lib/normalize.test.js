import { describe, expect, it } from "vitest";
import { normalizeTrace } from "./normalize";
import { reconstruct } from "./reconstruct";

describe("normalizeTrace", () => {
  it("fills in every field the UI dereferences", () => {
    const trace = normalizeTrace({ schema: 1, steps: [] });
    expect(trace).toMatchObject({ stdout: "", stderr: "", compileErrors: [], limits: { stdoutTruncated: false }, steps: [] });
  });

  it("repairs steps with missing frames or changes so the decoder cannot throw", () => {
    const trace = normalizeTrace({ steps: [{ n: 0, keyframe: true }, { n: 1 }, null, "junk"] });
    expect(trace.steps).toHaveLength(2);
    expect(() => reconstruct(trace)).not.toThrow();
  });

  it("keeps real values and does not mutate the input", () => {
    const raw = { status: "ok", stdout: "hi", limits: { maxSteps: 5000, stdoutTruncated: true }, steps: [{ n: 0, frames: [], changes: ["f0"], depth: 1 }] };
    const snapshot = JSON.stringify(raw);
    const trace = normalizeTrace(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
    expect(trace.stdout).toBe("hi");
    expect(trace.limits).toEqual({ stdoutTruncated: true, truncated: false, maxSteps: 5000 });
    expect(trace.steps[0].changes).toEqual(["f0"]);
  });

  it("ignores wrongly typed fields instead of passing them through", () => {
    const trace = normalizeTrace({ stdout: 5, stderr: { a: 1 }, compileErrors: "x", limits: "y", steps: "z" });
    expect(trace).toMatchObject({ stdout: "", stderr: "", compileErrors: [], steps: [] });
    expect(trace.limits.stdoutTruncated).toBe(false);
  });
});
