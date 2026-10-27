import { useEffect, useRef, useState } from "react";
import AiMessage from "./AiMessage";
import { LEVELS, isPending } from "../lib/aiChat";

const MESSAGE_LIMIT = 1000; // the server's limit
const STARTERS = ["Why did the last value change?", "What happens next?", "Is there a bug here?"];
const GROQ_URL = "https://console.groq.com/keys";
const KEY_URL = "https://aistudio.google.com/apikey";

/** The one-click question for the run's outcome, worded for what actually happened. */
function outcomeAction({ traceStatus, hasFindings }) {
  if (traceStatus === "compile_error") return "Explain the compile error";
  if (traceStatus === "runtime_error") return "Why did it crash?";
  if (traceStatus === "timeout" || traceStatus === "truncated") return "Why didn't it finish?";
  if (traceStatus === "ok") return hasFindings ? "Explain the problems found" : "Summarise this run";
  return "What went wrong?";
}

function SetupCard({ status }) {
  const needsKey = status.reason === "no_key";
  return (
    <div className="ai-setup" role="note">
      <p className="ai-setup-title">{status.phase === "unreachable" ? "Can't reach the backend" : "The assistant is switched off"}</p>
      <p>{status.message}</p>
      {needsKey && (
        <ol>
          <li>Get an API key from <a href={GROQ_URL} target="_blank" rel="noopener noreferrer">Groq Console</a> (preferred) or <a href={KEY_URL} target="_blank" rel="noopener noreferrer">Google AI Studio</a>.</li>
          <li>Put it in <code>bk/.env</code> as <code>GROQ_API_KEY=…</code> and/or <code>GEMINI_API_KEY=…</code>.</li>
          <li>Restart the backend (<code>npm start</code>).</li>
        </ol>
      )}
    </div>
  );
}

function Composer({ disabled, onSend }) {
  const [text, setText] = useState("");
  const submit = (event) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || disabled) return;
    onSend(message);
    setText("");
  };
  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };
  return (
    <form className="ai-composer" onSubmit={submit}>
      <textarea
        value={text} onChange={(event) => setText(event.target.value)} onKeyDown={handleKeyDown} rows={2} maxLength={MESSAGE_LIMIT} spellCheck
        aria-label="Ask about this run" placeholder="Ask about this run…  (Enter to send)" disabled={disabled}
      />
      <button type="submit" className="btn ai-send" disabled={disabled || text.trim() === ""}>Ask</button>
    </form>
  );
}

/**
 * The assistant drawer. `run` describes what can be asked about: { traceId, traceStatus, stepIndex, total, isStale, hasFindings }.
 * Nothing here talks to the network; it calls `assistant.ask` and renders `assistant.chat`.
 */
export default function AiPanel({ assistant, run, onSeek, onClose }) {
  const { status, chat, ask, retry, setLevel, clear } = assistant;
  const bodyRef = useRef(null);
  const busy = isPending(chat.messages);
  const ready = status.enabled && run.traceId !== null;

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [chat.messages]);

  return (
    <aside className="pane pane-ai" aria-label="AI assistant" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      <header className="ai-head">
        <h2 className="ai-title">Assistant</h2>
        <div className="ai-levels" role="radiogroup" aria-label="Explanation level">
          {LEVELS.map(({ id, label }) => (
            <button key={id} type="button" role="radio" aria-checked={chat.level === id} className={`ai-level${chat.level === id ? " is-on" : ""}`} onClick={() => setLevel(id)}>{label}</button>
          ))}
        </div>
        {chat.messages.length > 0 && <button type="button" className="ai-quiet" onClick={clear} disabled={busy}>Clear</button>}
        <button type="button" className="ai-quiet" onClick={onClose} aria-label="Close assistant" title="Close (Esc)">✕</button>
      </header>

      <div className="ai-body" ref={bodyRef}>
        {status.phase === "checking" && <p className="ai-hint" role="status">Checking the assistant…</p>}
        {status.phase !== "checking" && !status.enabled && <SetupCard status={status} />}
        {status.enabled && run.traceId === null && (
          <p className="ai-hint">Run your code first. The assistant explains the real recorded run, not a guess.</p>
        )}
        {ready && run.isStale && <p className="ai-stale" role="note">The code changed since this run. Answers still describe the last run you traced.</p>}
        {ready && chat.messages.length === 0 && (
          <div className="ai-intro">
            <p className="ai-hint">Ask about the run you are looking at. Every value it quotes is checked against the recording, and step references jump the timeline.</p>
            <div className="ai-starters">
              {STARTERS.map((question) => (
                <button key={question} type="button" className="ai-chip" disabled={busy} onClick={() => ask({ kind: "chat", step: run.stepIndex, message: question })}>{question}</button>
              ))}
            </div>
          </div>
        )}
        <div className="ai-log" role="log" aria-live="polite">
          {chat.messages.map((message) => <AiMessage key={message.id} message={message} total={run.total} onSeek={onSeek} onRetry={retry} />)}
        </div>
      </div>

      {ready && (
        <footer className="ai-foot">
          <div className="ai-actions">
            {run.total > 0 && (
              <button type="button" className="ai-chip is-primary" disabled={busy} onClick={() => ask({ kind: "step", step: run.stepIndex })}>Explain step {run.stepIndex + 1}</button>
            )}
            <button type="button" className="ai-chip" disabled={busy} onClick={() => ask({ kind: "error" })}>{outcomeAction(run)}</button>
          </div>
          <Composer disabled={busy} onSend={(message) => ask({ kind: "chat", step: run.total > 0 ? run.stepIndex : null, message })} />
          <p className="ai-privacy">Your code and its run data are sent to Google's Gemini API to answer. Answers can be wrong; the diagram is the truth.</p>
        </footer>
      )}
    </aside>
  );
}
