import { describe, expect, it } from "vitest";
import { chatReducer, findPriorAnswer, historyFor, initialChat, isPending, labelFor } from "./aiChat";

const started = (state, id, kind = "chat", step = null, label = "why?", level = "standard") => chatReducer(state, { type: "ask/start", id, kind, step, label, level });
const answered = (state, id, text = "because", extra = {}) =>
  chatReducer(state, { type: "ask/success", id, answer: { answer: text, step: null, citations: [], verification: { invalidCitations: 0, unverifiedValues: [] }, cached: false, truncated: false, model: "m", ...extra } });

describe("chatReducer", () => {
  it("starts with no messages and the standard level", () => {
    expect(initialChat.messages).toEqual([]);
    expect(initialChat.level).toBe("standard");
  });

  it("adds the question and a pending answer together, then fills the answer in", () => {
    let state = started(initialChat, "a1");
    expect(state.messages.map((m) => [m.role, m.status ?? "-"])).toEqual([["user", "-"], ["assistant", "pending"]]);
    expect(isPending(state.messages)).toBe(true);
    state = answered(state, "a1", "Because [[step:2]].");
    expect(state.messages[1]).toMatchObject({ status: "done", text: "Because [[step:2]]." });
    expect(isPending(state.messages)).toBe(false);
  });

  it("records a failure on the pending answer without touching earlier messages", () => {
    let state = answered(started(initialChat, "a1"), "a1");
    state = chatReducer(started(state, "a2"), { type: "ask/failure", id: "a2", code: "RATE_LIMITED", message: "slow down" });
    expect(state.messages[1].status).toBe("done");
    expect(state.messages[3]).toMatchObject({ status: "error", error: { code: "RATE_LIMITED", message: "slow down" } });
  });

  it("removes a cancelled question and its pending answer", () => {
    const state = chatReducer(started(initialChat, "a1"), { type: "ask/remove", id: "a1" });
    expect(state.messages).toEqual([]);
  });

  it("clears the conversation when the run changes, keeps it when the same run is announced again", () => {
    const withMessage = answered(started(chatReducer(initialChat, { type: "run/changed", traceId: "t1" }), "a1"), "a1");
    expect(chatReducer(withMessage, { type: "run/changed", traceId: "t1" })).toBe(withMessage);
    const next = chatReducer(withMessage, { type: "run/changed", traceId: "t2" });
    expect(next.messages).toEqual([]);
    expect(next.traceId).toBe("t2");
  });

  it("keeps the chosen level across runs and clears on request", () => {
    let state = chatReducer(initialChat, { type: "level/set", level: "expert" });
    state = chatReducer(state, { type: "run/changed", traceId: "t9" });
    expect(state.level).toBe("expert");
    expect(chatReducer(answered(started(state, "a1"), "a1"), { type: "chat/clear" }).messages).toEqual([]);
  });

  it("never mutates the previous state", () => {
    const before = answered(started(initialChat, "a1"), "a1");
    const snapshot = JSON.stringify(before);
    chatReducer(before, { type: "ask/failure", id: "a1", code: "X", message: "m" });
    chatReducer(before, { type: "level/set", level: "beginner" });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("ignores unknown actions", () => {
    expect(chatReducer(initialChat, { type: "nope" })).toBe(initialChat);
  });
});

describe("historyFor / findPriorAnswer / labelFor", () => {
  it("sends only finished pairs, oldest first, never an error or a pending answer", () => {
    let state = answered(started(initialChat, "a1", "chat", null, "what is n?"), "a1", "seven");
    state = chatReducer(started(state, "a2", "chat", null, "and m?"), { type: "ask/failure", id: "a2", code: "X", message: "m" });
    state = started(state, "a3", "chat", null, "pending one");
    expect(historyFor(state.messages)).toEqual([{ role: "user", text: "what is n?" }, { role: "assistant", text: "seven" }]);
  });

  it("keeps only the most recent turns", () => {
    let state = initialChat;
    for (let i = 0; i < 7; i += 1) state = answered(started(state, `a${i}`, "chat", null, `q${i}`), `a${i}`, `r${i}`);
    const history = historyFor(state.messages);
    expect(history).toHaveLength(8);
    expect(history[0].text).toBe("q3");
    expect(history.at(-1).text).toBe("r6");
  });

  it("finds a finished step answer for the same step and level only", () => {
    const state = answered(started(initialChat, "a1", "step", 4, "Explain step 5", "beginner"), "a1", "text", { step: 4 }); // the server echoes the step it explained
    expect(findPriorAnswer(state.messages, { kind: "step", step: 4, level: "beginner" })).toBeDefined();
    expect(findPriorAnswer(state.messages, { kind: "step", step: 5, level: "beginner" })).toBeUndefined();
    expect(findPriorAnswer(state.messages, { kind: "step", step: 4, level: "expert" })).toBeUndefined();
    expect(findPriorAnswer(state.messages, { kind: "chat", step: null, level: "beginner" })).toBeUndefined();
  });

  it("labels the click the way the user sees it", () => {
    expect(labelFor({ kind: "step", step: 0 })).toBe("Explain step 1");
    expect(labelFor({ kind: "error" })).toBe("Explain this run");
    expect(labelFor({ kind: "chat", message: "hello" })).toBe("hello");
  });
});
