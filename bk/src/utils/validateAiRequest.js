// Validates the body of POST /api/ai/ask. Never throws. The browser sends a run id, a question and a little chat history; it never
// sends the run itself (the server holds the verified trace). `findings` are the browser analyzer's labels for this run: they are
// shown to the model as hints, so they are bounded and typed like any other input.
const { ID_PATTERN } = require("../services/ai/traceStore");

const KINDS = new Set(["step", "error", "chat"]);
const LEVELS = new Set(["beginner", "standard", "expert"]);
const SEVERITIES = new Set(["bad", "warn"]);
const MAX = Object.freeze({ message: 1000, history: 10, historyText: 2000, findings: 20, title: 200, detail: 600, kind: 24, step: 100_000 });

const fail = (error) => ({ ok: false, error });
const isText = (value, max) => typeof value === "string" && value.length <= max && !value.includes("\u0000");
const isIndex = (value, max = MAX.step) => Number.isInteger(value) && value >= 0 && value <= max;

function cleanFinding(finding) {
  if (finding === null || typeof finding !== "object") return null;
  const { step, kind, severity, line, title, detail } = finding;
  if (!isIndex(step) || !isIndex(line, 1_000_000) || !SEVERITIES.has(severity)) return null;
  if (!isText(kind, MAX.kind) || !isText(title, MAX.title) || !isText(detail, MAX.detail)) return null;
  return { step, kind, severity, line, title, detail };
}

/** Chat turns must alternate and start with the user; a trailing user turn (a question that failed) is dropped. */
function cleanHistory(history) {
  const turns = [];
  for (const turn of history) {
    if (turn === null || typeof turn !== "object" || !["user", "assistant"].includes(turn.role) || !isText(turn.text, MAX.historyText)) return null;
    const text = turn.text.trim();
    if (text === "") continue;
    const last = turns.at(-1);
    if (last && last.role === turn.role) turns[turns.length - 1] = { role: last.role, text: `${last.text}\n${text}` };
    else if (last || turn.role === "user") turns.push({ role: turn.role, text });
  }
  while (turns.at(-1)?.role === "user") turns.pop();
  return turns;
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, value: { traceId: string, kind: string, step: number | null, message: string, level: string,
 *   history: { role: string, text: string }[], findings: object[] } } | { ok: false, error: string }}
 */
function validateAskRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return fail("Request body must be a JSON object");
  const { traceId, kind, step = null, message = "", level = "standard", history = [], findings = [] } = body;
  if (typeof traceId !== "string" || !ID_PATTERN.test(traceId)) return fail("traceId is missing or malformed");
  if (!KINDS.has(kind)) return fail("kind must be step, error or chat");
  if (!LEVELS.has(level)) return fail("level must be beginner, standard or expert");
  if (step !== null && !isIndex(step)) return fail("step must be a non-negative integer");
  if (kind === "step" && step === null) return fail("step is required to explain a step");
  if (!isText(message, MAX.message)) return fail(`message must be text of at most ${MAX.message} characters`);
  if (kind === "chat" && message.trim() === "") return fail("message must not be empty");
  if (!Array.isArray(history) || history.length > MAX.history * 2) return fail("history must be a short list of turns");
  if (!Array.isArray(findings) || findings.length > MAX.findings) return fail(`findings must be a list of at most ${MAX.findings}`);
  const cleanedHistory = cleanHistory(history);
  if (cleanedHistory === null) return fail("history turns need a role (user or assistant) and text");
  const cleanedFindings = findings.map(cleanFinding);
  if (cleanedFindings.includes(null)) return fail("a finding is malformed");
  return { ok: true, value: { traceId, kind, step, message: message.trim(), level, history: cleanedHistory.slice(-MAX.history), findings: cleanedFindings } };
}

module.exports = { validateAskRequest };
