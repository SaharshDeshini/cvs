import { describe, expect, it } from "vitest";
import { initialState, playerReducer, SPEEDS, stepDelayMs } from "./playerReducer";

const trace = (count) => ({
  stdout: "",
  steps: Array.from({ length: count }, (_, n) => ({
    n, line: n + 1, fn: "main", event: "step", depth: 1, stdoutLen: 0, keyframe: n === 0, frames: n === 0 ? [{ id: "f0", fn: "main", line: 1, vars: {} }] : [], changes: [], skipped: null,
  })),
});
const ready = (count) => playerReducer(initialState, { type: "run/success", trace: trace(count) });

describe("playerReducer", () => {
  it("run/start clears the previous trace but keeps the chosen speed", () => {
    const state = playerReducer({ ...ready(3), speedIndex: 3 }, { type: "run/start" });
    expect(state).toMatchObject({ phase: "loading", trace: null, views: [], speedIndex: 3 });
  });

  it("run/success decodes the trace and starts at step 0, paused", () => {
    const state = ready(4);
    expect(state).toMatchObject({ phase: "ready", index: 0, playing: false });
    expect(state.views).toHaveLength(4);
  });

  it("run/failure records the message", () => {
    expect(playerReducer(initialState, { type: "run/failure", message: "boom" })).toMatchObject({ phase: "failed", error: "boom" });
  });

  it("next and prev stay inside the trace", () => {
    let state = ready(2);
    state = playerReducer(state, { type: "step/next" });
    state = playerReducer(state, { type: "step/next" });
    expect(state.index).toBe(1);
    state = playerReducer(state, { type: "step/prev" });
    state = playerReducer(state, { type: "step/prev" });
    expect(state.index).toBe(0);
  });

  it("stepping on an empty trace does not produce a bad index", () => {
    const state = playerReducer(ready(0), { type: "step/next" });
    expect(state.index).toBe(0);
    expect(playerReducer(state, { type: "step/seek", index: 9 }).index).toBe(0);
  });

  it("seek clamps and pauses", () => {
    const playing = { ...ready(5), playing: true };
    expect(playerReducer(playing, { type: "step/seek", index: 99 })).toMatchObject({ index: 4, playing: false });
    expect(playerReducer(playing, { type: "step/seek", index: -3 }).index).toBe(0);
  });

  it("playing stops itself on the last step", () => {
    let state = playerReducer(ready(3), { type: "play/toggle" });
    expect(state.playing).toBe(true);
    state = playerReducer(state, { type: "step/next" });
    expect(state.playing).toBe(true);
    state = playerReducer(state, { type: "step/next" });
    expect(state).toMatchObject({ index: 2, playing: false });
  });

  it("pressing play at the end restarts from the beginning", () => {
    const atEnd = { ...ready(3), index: 2 };
    expect(playerReducer(atEnd, { type: "play/toggle" })).toMatchObject({ index: 0, playing: true });
  });

  it("play/toggle does nothing without a trace", () => {
    expect(playerReducer(initialState, { type: "play/toggle" })).toBe(initialState);
    expect(playerReducer(ready(0), { type: "play/toggle" }).playing).toBe(false);
  });

  it("reset returns to the first step and pauses", () => {
    expect(playerReducer({ ...ready(5), index: 3, playing: true }, { type: "step/reset" })).toMatchObject({ index: 0, playing: false });
  });

  it("prev pauses playback", () => {
    expect(playerReducer({ ...ready(5), index: 3, playing: true }, { type: "step/prev" }).playing).toBe(false);
  });

  it("speed is clamped to the available speeds and faster means a shorter delay", () => {
    expect(playerReducer(initialState, { type: "speed/set", index: 99 }).speedIndex).toBe(SPEEDS.length - 1);
    expect(playerReducer(initialState, { type: "speed/set", index: -1 }).speedIndex).toBe(0);
    expect(stepDelayMs(4)).toBeLessThan(stepDelayMs(0));
  });

  it("unknown actions return the same state object", () => {
    expect(playerReducer(initialState, { type: "nope" })).toBe(initialState);
  });
});
