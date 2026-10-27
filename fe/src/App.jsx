import { Component, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import AiPanel from "./components/AiPanel";
import CodeEditor from "./components/CodeEditor";
import Controls from "./components/Controls";
import HeapView from "./components/HeapView";
import OutputPanel from "./components/OutputPanel";
import PointerArrows from "./components/PointerArrows";
import StackView from "./components/StackView";
import StatusBanner from "./components/StatusBanner";
import StepNarration from "./components/StepNarration";
import { DiagramContext } from "./components/ValueView";
import { requestTrace } from "./lib/api";
import { detectBugs, findingStep } from "./lib/bugs";
import { captionFor } from "./lib/caption";
import { isRelated } from "./lib/focus";
import { inlineValuesFor } from "./lib/inlineValues";
import { pointerTags } from "./lib/pointerTags";
import { declaresMid } from "./lib/rangeHints";
import { classifyOrphans } from "./lib/heapLifetime";
import { buildDiagram } from "./lib/memoryGraph";
import { initialState, playerReducer, stepDelayMs } from "./lib/playerReducer";
import { stdoutAt } from "./lib/reconstruct";
import { chipFor } from "./lib/status";
import { useAssistant } from "./lib/useAssistant";

const SAMPLE_CODE = `#include <iostream>

int factorial(int n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}

int main() {
    int total = 0;
    for (int i = 1; i <= 3; i++) {
        total += factorial(i);
    }
    std::cout << "total = " << total << std::endl;
    return 0;
}
`;

const NO_LINES = [];
const NO_BUGS = [];
const PAGE_STEPS = 10; // PageUp / PageDown
const TEXT_FIELDS = new Set(["TEXTAREA", "INPUT", "SELECT"]);
const ACTIVATABLE = "button, summary, a, [role='button']"; // Space activates these natively
const isTypingTarget = (target) => TEXT_FIELDS.has(target.tagName) || Boolean(target.closest?.(".cm-editor, pre[tabindex]"));

const SHORTCUTS = [
  [["Ctrl", "Enter"], "Run the program"],
  [["Alt", "A"], "Open / close the AI assistant"],
  [["←"], "Previous step"],
  [["→"], "Next step"],
  [["Space"], "Play / pause"],
  [["Home"], "First step"],
  [["End"], "Last step"],
  [["PgUp"], `Back ${PAGE_STEPS} steps`],
  [["PgDn"], `Forward ${PAGE_STEPS} steps`],
  [["["], "Previous problem"],
  [["]"], "Next problem"],
];

/** The shortcut list. Ctrl+Enter works everywhere; the other keys pause while you type in the editor or stdin box (Alt+← → still step). */
function ShortcutHelp() {
  return (
    <details className="shortcuts">
      <summary>Shortcuts</summary>
      <dl className="shortcut-list">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={label} className="shortcut-row">
            <dt>{keys.map((key, index) => <span key={key}>{index > 0 && " + "}<kbd>{key}</kbd></span>)}</dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <p className="empty-title">Run your code to watch it execute.</p>
      <p className="empty-body">Every step is recorded from a real run under a debugger — nothing is guessed.</p>
      <p className="empty-keys">
        <span><kbd>Ctrl</kbd> <kbd>Enter</kbd> run</span>
        <span><kbd>←</kbd> <kbd>→</kbd> step</span>
        <span><kbd>Space</kbd> play</span>
        <span><kbd>[</kbd> <kbd>]</kbd> problems</span>
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="empty" role="status">
      <div className="pulse" aria-hidden="true" />
      <p className="empty-title">Compiling and tracing…</p>
      <p className="empty-body">Your program runs in an isolated container, one line at a time.</p>
    </div>
  );
}

// A rendering bug in the visualization must not blank the whole app (the editor and controls stay usable).
class VisualizationBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error("Visualization failed to render:", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="banner is-problem" role="alert">
        <strong>The visualization failed to draw this run</strong>
        <span className="banner-message"> — edit the code and press Run to try again.</span>
      </div>
    );
  }
}

/** The nearest box under the mouse that has an arrow to or from it (a number hovered inside a node counts as the node). */
function focusFor(target, edges) {
  for (let element = target.closest?.("[data-key]"); element; element = element.parentElement?.closest("[data-key]")) {
    const key = element.getAttribute("data-key");
    if (edges.some((edge) => isRelated(edge, key))) return key;
  }
  return null;
}

/** The call stack and the heap in one box, with the pointer arrows drawn over both. */
function Diagram({ view, previous, verdicts, searchFns }) {
  const containerRef = useRef(null);
  const [focus, setFocus] = useState(null);
  const model = useMemo(() => buildDiagram(view, previous, verdicts), [view, previous, verdicts]);
  const context = useMemo(() => ({ changed: model.changed, born: model.born, sources: new Set(model.edges.map((edge) => edge.from)), tags: pointerTags(model.edges), searchFns }), [model, searchFns]);
  const hasHeap = model.plan.length > 0;
  return (
    <DiagramContext.Provider value={context}>
      <div
        className={`diagram${hasHeap ? " has-heap" : ""}`}
        ref={containerRef}
        onMouseOver={(event) => setFocus(focusFor(event.target, model.edges))}
        onMouseLeave={() => setFocus(null)}
      >
        <StackView view={view} />
        {hasHeap && <HeapView plan={model.plan} heap={view.heap} />}
        <PointerArrows containerRef={containerRef} edges={model.edges} changed={model.changed} layoutKey={view.n} focus={focus} />
      </div>
    </DiagramContext.Provider>
  );
}

/** Names of the functions that declare a midpoint somewhere in the run: their lo/hi style pairs are a binary search on EVERY step. */
function functionsWithMid(views) {
  const names = new Set();
  for (const view of views) for (const frame of view.frames) if (declaresMid(frame.vars)) names.add(frame.fn);
  return names;
}

function Visualization({ state, isStale, bugs, lifetimes, onSeek, onExplainStep, onExplainOutcome }) {
  const { trace, views, index } = state;
  const view = views[index];
  const searchFns = useMemo(() => functionsWithMid(views), [views]);
  const caption = view ? captionFor(view, views[index - 1] ?? null) : "";
  const isLast = views.length === 0 || index >= views.length - 1;
  const hasNothing = trace.status === "ok" && views.length === 0 && !trace.stdout && !trace.stderr;
  return (
    <>
      <StatusBanner trace={trace} onExplain={onExplainOutcome} />
      {hasNothing && <div className="banner is-notice" role="status">The program finished without any steps to show.</div>}
      {isStale && <div className="banner is-notice" role="status">The code changed since this run. Press Run to trace the new version.</div>}
      {view && <StepNarration caption={caption} index={index} bugs={bugs} onSeek={onSeek} onExplain={onExplainStep} />}
      {view && <Diagram view={view} previous={views[index - 1] ?? null} verdicts={lifetimes[index]} searchFns={searchFns} />}
      {(view || trace.stdout || trace.stderr) && (
        <OutputPanel
          stdout={stdoutAt(trace, views, index)}
          stderr={trace.stderr}
          stdoutTruncated={trace.limits.stdoutTruncated}
          showFull={isLast}
        />
      )}
    </>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(playerReducer, initialState);
  const [code, setCode] = useState(SAMPLE_CODE);
  const [stdin, setStdin] = useState("");
  const [codeAtRun, setCodeAtRun] = useState(null);
  const abortRef = useRef(null);
  const latest = useRef({ code, stdin, phase: state.phase });
  latest.current = { code, stdin, phase: state.phase };
  const stepContext = useRef({ index: 0, bugs: NO_BUGS }); // what the [ and ] keys need, without re-binding the key listener each step
  const toggleAssistant = useRef(() => {}); // set below once the assistant hook exists; Alt+A calls it

  const handleRun = useCallback(async () => {
    if (latest.current.phase === "loading") return;
    latest.current.phase = "loading"; // synchronously: a second trigger in the same tick must see it
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { code: source, stdin: input } = latest.current;
    dispatch({ type: "run/start" });
    try {
      const trace = await requestTrace({ code: source, stdin: input }, controller.signal);
      if (controller.signal.aborted) return; // superseded or unmounted while the response was in flight
      setCodeAtRun(source);
      dispatch({ type: "run/success", trace });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") return;
      dispatch({ type: "run/failure", message: error.message });
    }
  }, []);

  // Playback timer: one interval per speed while playing.
  useEffect(() => {
    if (!state.playing) return undefined;
    const id = setInterval(() => dispatch({ type: "step/next" }), stepDelayMs(state.speedIndex));
    return () => clearInterval(id);
  }, [state.playing, state.speedIndex]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const jumpToFinding = (direction) => {
      const target = findingStep(stepContext.current.bugs, stepContext.current.index, direction);
      if (target !== null) dispatch({ type: "step/seek", index: target });
    };
    const handleKey = (event) => {
      if (event.defaultPrevented) return; // the editor (or another control) already handled this key
      const typing = isTypingTarget(event.target);
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        handleRun();
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === "KeyA") {
        event.preventDefault();
        toggleAssistant.current();
      } else if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        dispatch({ type: "step/next" });
      } else if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        dispatch({ type: "step/prev" });
      } else if (!typing && !event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === "ArrowRight") dispatch({ type: "step/next" });
        else if (event.key === "ArrowLeft") dispatch({ type: "step/prev" });
        else if (event.key === "Home") dispatch({ type: "step/reset" });
        else if (event.key === "End") dispatch({ type: "step/last" });
        else if (event.key === "PageDown") dispatch({ type: "step/jump", delta: PAGE_STEPS });
        else if (event.key === "PageUp") dispatch({ type: "step/jump", delta: -PAGE_STEPS });
        else if (event.key === "]" || event.key === "[") jumpToFinding(event.key === "]" ? 1 : -1);
        else if (event.key === " " && !event.repeat && !event.target.closest?.(ACTIVATABLE)) {
          event.preventDefault();
          dispatch({ type: "play/toggle" });
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleRun]);

  const isStale = codeAtRun !== null && state.phase === "ready" && code !== codeAtRun;
  const view = state.views[state.index];
  const currentLine = state.phase === "ready" && !isStale && view ? view.line : null;
  const showErrorLines = state.phase === "ready" && !isStale && state.trace.status === "compile_error";
  // memoised: a fresh array on every render would re-dispatch the editor's decorations while typing in stdin
  const errorLines = useMemo(
    () => (showErrorLines ? state.trace.compileErrors.map((d) => d.line) : NO_LINES),
    [showErrorLines, state.trace],
  );

  // one look-ahead pass over the whole run per trace; the diagram and the bug finder both read it
  const runFinished = state.phase === "ready" && state.trace.status === "ok";
  const lifetimes = useMemo(() => classifyOrphans(state.views, { complete: runFinished }), [state.views, runFinished]);
  const bugs = useMemo(
    () => (state.phase === "ready" ? detectBugs(state.views, state.trace, { source: codeAtRun ?? "", lifetimes }) : NO_BUGS),
    [state.phase, state.views, state.trace, codeAtRun, lifetimes],
  );
  stepContext.current = { index: state.index, bugs };
  const seekStep = useCallback((step) => dispatch({ type: "step/seek", index: step }), []);
  // The assistant talks about the LAST traced run (the server holds it by id), even while the editor text has moved on.
  const traceId = state.phase === "ready" ? (state.trace.traceId ?? null) : null;
  const assistant = useAssistant({ traceId, bugs });
  toggleAssistant.current = assistant.toggle;
  const assistantRun = { traceId, traceStatus: state.phase === "ready" ? state.trace.status : "idle", stepIndex: state.index, total: state.views.length, isStale, hasFindings: bugs.length > 0 };
  const explainStep = assistant.available ? () => assistant.ask({ kind: "step", step: state.index }) : undefined;
  const explainOutcome = assistant.available ? () => assistant.ask({ kind: "error" }) : undefined;
  const assistantTone = assistant.status.enabled ? "on" : assistant.status.phase === "checking" ? "idle" : "off"; // "idle": not asked yet
  // the faint "sum = 6   x = 7" label after the line that is about to run, from the run's own source text
  const inlineText = useMemo(() => {
    if (currentLine === null || codeAtRun === null) return null;
    const vars = view.frames.at(-1)?.vars;
    return (vars && inlineValuesFor(codeAtRun.split("\n")[currentLine - 1] ?? "", vars)) || null;
  }, [currentLine, codeAtRun, view]);

  const chip = chipFor(state.phase, state.trace);

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="wordmark">CVis <span className="wordmark-sub">see what your C++ does</span></h1>
        <div className="topbar-right">
          <button type="button" className={`ai-toggle${assistant.open ? " is-open" : ""}`} onClick={assistant.toggle} aria-pressed={assistant.open} title="Ask the AI assistant (Alt+A)">
            <span className={`ai-dot ai-dot-${assistantTone}`} aria-hidden="true" /> Ask AI
          </button>
          <ShortcutHelp />
          <span className={`chip chip-${chip.tone}`} aria-live="polite">{chip.label}</span>
        </div>
      </header>
      <main className={`workspace${assistant.open ? " has-assistant" : ""}`}>
        <section className="pane pane-editor" aria-label="Editor">
          <CodeEditor initialCode={SAMPLE_CODE} onChange={setCode} onRun={handleRun} currentLine={currentLine} errorLines={errorLines} inlineText={inlineText} />
          <details className="stdin">
            <summary>Program input (stdin)</summary>
            <textarea value={stdin} onChange={(event) => setStdin(event.target.value)} rows={3} spellCheck={false} aria-label="Program input" placeholder="Text the program reads with cin / scanf" />
          </details>
        </section>
        <section className="pane pane-viz" aria-label="Visualization">
          {state.phase === "idle" && <EmptyState />}
          {state.phase === "loading" && <LoadingState />}
          {state.phase === "failed" && <div className="banner is-problem" role="alert"><strong>Could not run</strong><span className="banner-message"> — {state.error}</span></div>}
          {state.phase === "ready" && (
            <VisualizationBoundary key={state.trace.steps.length + state.trace.status + state.trace.stdout.length}>
              <Visualization state={state} isStale={isStale} bugs={bugs} lifetimes={lifetimes} onSeek={seekStep} onExplainStep={explainStep} onExplainOutcome={explainOutcome} />
            </VisualizationBoundary>
          )}
        </section>
        {assistant.open && <AiPanel assistant={assistant} run={assistantRun} onSeek={seekStep} onClose={() => assistant.setOpen(false)} />}
      </main>
      <Controls
        phase={state.phase}
        index={state.index}
        total={state.views.length}
        views={state.views}
        bugs={bugs}
        playing={state.playing}
        speedIndex={state.speedIndex}
        line={view?.line}
        isStale={isStale}
        dispatch={dispatch}
        onRun={handleRun}
      />
    </div>
  );
}
