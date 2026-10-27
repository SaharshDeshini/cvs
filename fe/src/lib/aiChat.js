// The assistant panel's conversation as one pure reducer (no network here). Messages belong to ONE run: a new run (new traceId)
// starts a fresh conversation, because values and addresses in the old answers describe a program that no longer exists.
export const initialChat = Object.freeze({ traceId: null, messages: Object.freeze([]), level: "standard" });

const HISTORY_TURNS = 8; // the server keeps at most 10; fewer turns keep free-tier prompts small

export const LEVELS = Object.freeze([
  { id: "beginner", label: "Beginner" },
  { id: "standard", label: "Standard" },
  { id: "expert", label: "Expert" },
]);

const replace = (messages, id, change) => messages.map((message) => (message.id === id ? { ...message, ...change } : message));

export function chatReducer(state, action) {
  switch (action.type) {
    case "run/changed":
      return state.traceId === action.traceId ? state : { ...state, traceId: action.traceId, messages: initialChat.messages };
    case "ask/start":
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: action.id, role: "user", kind: action.kind, step: action.step, text: action.label },
          { id: `${action.id}:answer`, role: "assistant", kind: action.kind, step: action.step, level: action.level, status: "pending", text: "" },
        ],
      };
    case "ask/success":
      return {
        ...state,
        messages: replace(state.messages, `${action.id}:answer`, {
          status: "done", text: action.answer.answer, step: action.answer.step, citations: action.answer.citations,
          verification: action.answer.verification, cached: action.answer.cached, truncated: action.answer.truncated, model: action.answer.model,
        }),
      };
    case "ask/failure":
      return { ...state, messages: replace(state.messages, `${action.id}:answer`, { status: "error", error: { code: action.code, message: action.message } }) };
    case "ask/remove":
      return { ...state, messages: state.messages.filter((message) => message.id !== action.id && message.id !== `${action.id}:answer`) };
    case "level/set":
      return { ...state, level: action.level };
    case "chat/clear":
      return { ...state, messages: initialChat.messages };
    default:
      return state;
  }
}

/** What the user's click is shown as in the conversation. */
export function labelFor({ kind, step, message }) {
  if (kind === "step") return `Explain step ${step + 1}`;
  if (kind === "error") return "Explain this run";
  return message;
}

/** The finished question/answer pairs, oldest first, as the server's `history` (errors and the pending answer are left out). */
export function historyFor(messages) {
  const turns = [];
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || message.status !== "done") return;
    const question = messages[index - 1];
    if (question?.role === "user") turns.push({ role: "user", text: question.text }, { role: "assistant", text: message.text });
  });
  return turns.slice(-HISTORY_TURNS);
}

/** An earlier finished answer to the same step/error question at the same level, so a repeated click shows it instead of asking again. */
export function findPriorAnswer(messages, { kind, step, level }) {
  if (kind === "chat") return undefined;
  return messages.find((message) => message.role === "assistant" && message.status === "done" && message.kind === kind && message.level === level
    && (kind === "error" || message.step === step));
}

export const isPending = (messages) => messages.some((message) => message.status === "pending");
