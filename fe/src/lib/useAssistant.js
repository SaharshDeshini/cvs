// Everything the assistant needs from React in one hook: is it switched on, is the panel open, the conversation, and `ask`.
// It owns the in-flight request (one at a time; a new run cancels it) and never touches the visualization state.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { askAssistant, fetchAiStatus, findingsPayload } from "./aiApi";
import { chatReducer, findPriorAnswer, historyFor, initialChat, isPending, labelFor } from "./aiChat";

const CHECKING = Object.freeze({ phase: "checking", enabled: false, reason: null, message: null, model: null });
const UNKNOWN_FAILURE = "The assistant could not answer. Try again.";

/**
 * @param {{ traceId: string | null, bugs: object[] }} run the last finished run (null id: nothing to ask about)
 */
export function useAssistant({ traceId, bugs }) {
  const [status, setStatus] = useState(CHECKING);
  const [open, setOpen] = useState(false);
  const [chat, dispatch] = useReducer(chatReducer, initialChat);
  const abortRef = useRef(null);
  const counter = useRef(0);
  const latest = useRef({ chat, traceId, bugs }); // `ask` reads the newest values without being re-created on every step
  latest.current = { chat, traceId, bugs };

  // Ask the backend whether the assistant is on only when that matters: the panel is opened, or a run came back from the backend
  // (so it is certainly reachable). Never at page load: with no backend running that would be a failed request for nothing.
  // Asked again on each such event while the answer is not "ready" (the backend may have been started or fixed since).
  const hasRun = traceId !== null;
  useEffect(() => {
    if (status.phase === "ready" || !(open || hasRun)) return undefined;
    const controller = new AbortController();
    fetchAiStatus(controller.signal).then(setStatus, () => {});
    return () => controller.abort();
  }, [open, hasRun, status.phase]);

  useEffect(() => {
    abortRef.current?.abort();
    dispatch({ type: "run/changed", traceId });
  }, [traceId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = useCallback(async ({ kind, step = null, message = "" }) => {
    const { chat: current, traceId: id, bugs: found } = latest.current;
    if (!id || isPending(current.messages)) return;
    setOpen(true);
    if (findPriorAnswer(current.messages, { kind, step, level: current.level })) return; // already on screen
    counter.current += 1;
    const messageId = `q${counter.current}`;
    const history = historyFor(current.messages);
    dispatch({ type: "ask/start", id: messageId, kind, step, label: labelFor({ kind, step, message }), level: current.level });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const answer = await askAssistant({ traceId: id, kind, step, message, level: current.level, history, findings: findingsPayload(found) }, controller.signal);
      if (!controller.signal.aborted) dispatch({ type: "ask/success", id: messageId, answer });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") return;
      dispatch({ type: "ask/failure", id: messageId, code: error?.code ?? "UNKNOWN", message: error?.message || UNKNOWN_FAILURE });
    }
  }, []);

  /** Ask the same question again after a failure: the failed pair is replaced by a fresh one. */
  const retry = useCallback((answerId) => {
    const questionId = answerId.replace(/:answer$/, "");
    const question = latest.current.chat.messages.find((message) => message.id === questionId);
    if (!question) return;
    dispatch({ type: "ask/remove", id: questionId });
    ask({ kind: question.kind, step: question.step, message: question.kind === "chat" ? question.text : "" });
  }, [ask]);

  const toggle = useCallback(() => setOpen((value) => !value), []);
  const setLevel = useCallback((level) => dispatch({ type: "level/set", level }), []);
  const clear = useCallback(() => dispatch({ type: "chat/clear" }), []);

  return { status, open, setOpen, toggle, chat, ask, retry, setLevel, clear, available: status.enabled && Boolean(traceId) };
}
