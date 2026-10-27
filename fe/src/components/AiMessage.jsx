import { useState } from "react";
import { parseAnswer } from "../lib/aiText";

/** Inline tokens as React elements. Every string is rendered as text, so a model answer (or the program text it quotes) cannot inject markup. */
function Inline({ tokens, total, onSeek }) {
  return tokens.map((token, index) => {
    if (token.type === "bold") return <strong key={index}>{token.text}</strong>;
    if (token.type === "code") return <code key={index} className="ai-inline-code">{token.text}</code>;
    if (token.type === "step") {
      const inRun = token.n >= 1 && token.n <= total;
      return (
        <button key={index} type="button" className="ai-step" disabled={!inRun} onClick={() => onSeek(token.n - 1)} title={inRun ? `Jump to step ${token.n}` : "Not a step of this run"}>
          step {token.n}
        </button>
      );
    }
    return <span key={index}>{token.text}</span>;
  });
}

function CodeBlock({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false); // clipboard not available (insecure origin): the text is still selectable
    }
  };
  return (
    <div className="ai-code">
      <button type="button" className="ai-copy" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      <pre><code>{text}</code></pre>
    </div>
  );
}

function Blocks({ text, total, onSeek }) {
  return parseAnswer(text).map((block, index) => {
    if (block.type === "code") return <CodeBlock key={index} text={block.text} />;
    if (block.type === "list") {
      const List = block.ordered ? "ol" : "ul";
      return <List key={index} className="ai-list">{block.items.map((item, i) => <li key={i}><Inline tokens={item} total={total} onSeek={onSeek} /></li>)}</List>;
    }
    return <p key={index}><Inline tokens={block.inline} total={total} onSeek={onSeek} /></p>;
  });
}

/** What the checker found wrong with an answer. Said plainly, never hidden: the product's promise is "nothing is guessed". */
function VerificationNotes({ message }) {
  const { invalidCitations = 0, unverifiedValues = [] } = message.verification ?? {};
  if (!invalidCitations && unverifiedValues.length === 0 && !message.truncated) return null;
  return (
    <ul className="ai-notes">
      {invalidCitations > 0 && <li>{invalidCitations} reference{invalidCitations === 1 ? "" : "s"} to a step that does not exist in this run {invalidCitations === 1 ? "was" : "were"} removed.</li>}
      {unverifiedValues.length > 0 && (
        <li>Could not find {unverifiedValues.map((value, i) => <span key={value}>{i > 0 && ", "}<code>{value}</code></span>)} in the run data. It may be the assistant's own arithmetic; check it against the diagram.</li>
      )}
      {message.truncated && <li>The answer was cut off. Ask a narrower question for the rest.</li>}
    </ul>
  );
}

/** One chat bubble: the user's question, a pending answer, a failure with Retry, or a finished answer with step chips. */
export default function AiMessage({ message, total, onSeek, onRetry }) {
  if (message.role === "user") return <div className="ai-msg is-user"><p>{message.text}</p></div>;
  if (message.status === "pending") {
    return <div className="ai-msg is-assistant" role="status" aria-label="The assistant is thinking"><span className="ai-dots" aria-hidden="true"><i /><i /><i /></span></div>;
  }
  if (message.status === "error") {
    return (
      <div className="ai-msg is-error" role="alert">
        <p>{message.error.message}</p>
        {message.error.code !== "TRACE_NOT_FOUND" && message.error.code !== "AI_DISABLED" && message.error.code !== "KEY_REJECTED" && (
          <button type="button" className="ai-retry" onClick={() => onRetry(message.id)}>Try again</button>
        )}
      </div>
    );
  }
  return (
    <div className="ai-msg is-assistant">
      <Blocks text={message.text} total={total} onSeek={onSeek} />
      <VerificationNotes message={message} />
      {(message.model || message.cached) && <p className="ai-meta">{message.model}{message.cached ? " · saved answer" : ""}</p>}
    </div>
  );
}
