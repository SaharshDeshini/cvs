/** The sentence under the controls' step: what this step did, any bug that shows right here, and every finding as a jump link. */
export default function StepNarration({ caption, index, bugs, onSeek, onExplain }) {
  const here = bugs.filter((bug) => bug.step === index);
  return (
    <section className="narration" aria-label="What this step does">
      <p className="caption">
        <span className="caption-step">Step {index + 1}</span> {caption}
        {onExplain && <button type="button" className="ai-explain" onClick={onExplain} title="Ask the AI assistant to explain this step">Explain with AI</button>}
      </p>
      {here.map((bug) => (
        <div key={bug.id} className={`bug-card is-${bug.severity}`} role="note">
          <strong className="bug-title">{bug.title}</strong>
          <span className="bug-detail">{bug.detail}</span>
          <span className="bug-line">line {bug.line}</span>
        </div>
      ))}
      {bugs.length > 0 && (
        <ul className="findings" aria-label="Problems found in this run">
          {bugs.map((bug) => (
            <li key={bug.id}>
              <button type="button" className={`finding is-${bug.severity}${bug.step === index ? " is-here" : ""}`} aria-current={bug.step === index ? "step" : undefined} onClick={() => onSeek(bug.step)}>
                {bug.title} <span className="finding-step">step {bug.step + 1}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
