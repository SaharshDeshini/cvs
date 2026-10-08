import { Component, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import CodeEditor from "./components/CodeEditor";
import Controls from "./components/Controls";
import HeapView from "./components/HeapView";
import OutputPanel from "./components/OutputPanel";
import PointerArrows from "./components/PointerArrows";
import StackView from "./components/StackView";
import StatusBanner from "./components/StatusBanner";
import { DiagramContext } from "./components/ValueView";
import { requestTrace } from "./lib/api";
import { buildDiagram } from "./lib/memoryGraph";
import { initialState, playerReducer, stepDelayMs } from "./lib/playerReducer";
import { stdoutAt } from "./lib/reconstruct";
import { chipFor } from "./lib/status";

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
const TEXT_FIELDS = new Set(["TEXTAREA", "INPUT", "SELECT"]);
const ACTIVATABLE = "button, summary, a, [role='button']"; // Space activates these natively
const isTypingTarget = (target) => TEXT_FIELDS.has(target.tagName) || Boolean(target.closest?.(".cm-editor, pre[tabindex]"));

function EmptyState() {
  return (
    <div className="empty">
      <p className="empty-title">Run your code to watch it execute.</p>
      <p className="empty-body">Every step is recorded from a real run under a debugger — nothing is guessed.</p>
      <p className="empty-keys"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to run · <kbd>←</kbd> <kbd>→</kbd> to step · <kbd>Space</kbd> to play</p>
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

/** The call stack and the heap in one box, with the pointer arrows drawn over both. */
function Diagram({ view, previous }) {
  const containerRef = useRef(null);
  const model = useMemo(() => buildDiagram(view, previous), [view, previous]);
  const context = useMemo(() => ({ changed: model.changed, sources: new Set(model.edges.map((edge) => edge.from)) }), [model]);
  return (
    <DiagramContext.Provider value={context}>
      <div className="diagram" ref={containerRef}>
        <StackView view={view} />
        {model.plan.length > 0 && <HeapView plan={model.plan} heap={view.heap} />}
        <PointerArrows containerRef={containerRef} edges={model.edges} changed={model.changed} layoutKey={view.n} />
      </div>
    </DiagramContext.Provider>
  );
}

function Visualization({ state, isStale }) {
  const { trace, views, index } = state;
  const view = views[index];
  const isLast = views.length === 0 || index >= views.length - 1;
  const hasNothing = trace.status === "ok" && views.length === 0 && !trace.stdout && !trace.stderr;
  return (
    <>
      <StatusBanner trace={trace} />
      {hasNothing && <div className="banner is-notice" role="status">The program finished without any steps to show.</div>}
      {isStale && <div className="banner is-notice" role="status">The code changed since this run. Press Run to trace the new version.</div>}
      {view && <Diagram view={view} previous={views[index - 1] ?? null} />}
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
    const handleKey = (event) => {
      if (event.defaultPrevented) return; // the editor (or another control) already handled this key
      const typing = isTypingTarget(event.target);
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        handleRun();
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

  const chip = chipFor(state.phase, state.trace);

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="wordmark">SCV <span className="wordmark-sub">see what your C++ does</span></h1>
        <span className={`chip chip-${chip.tone}`} aria-live="polite">{chip.label}</span>
      </header>
      <main className="workspace">
        <section className="pane pane-editor" aria-label="Editor">
          <CodeEditor initialCode={SAMPLE_CODE} onChange={setCode} onRun={handleRun} currentLine={currentLine} errorLines={errorLines} />
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
              <Visualization state={state} isStale={isStale} />
            </VisualizationBoundary>
          )}
        </section>
      </main>
      <Controls
        phase={state.phase}
        index={state.index}
        total={state.views.length}
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
