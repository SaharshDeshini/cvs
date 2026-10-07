# Roadmap

One milestone at a time; each ends with build → tests → manual check → docs/README/CLAUDE.md update → approval.
Order differs from the initial sketch: a **feasibility spike** comes first, **security is designed in from
Phase 1** (reviewed in Phase 13), and the **frontend vertical slice** comes before the data-structure phases so
every later phase is visible.

## Phase 0 — Research & plan  ✅ (this document set)

## Phase 1 — Feasibility spike (gate)  ✅ GO (2026-10-07)
Result: in-container gdb+Python tracing works (2,069 steps/s `step`, 1,204 steps/s bounded `stepi`; STL printers,
SIGSEGV, wall-clock kill, memory/pid/network limits all verified). Five flaws found and carried into Phase 2:
unbounded `step` (D-011), buffered output (D-012), unclassified end state (D-012), dead-object garbage, library
frames. Numbers and details: RESEARCH.md → Phase 1 Spike Results. Spike code: `bk/runner/` (throwaway).
- Objective: prove or kill the GDB-in-container approach before building on it.
- Files: `bk/runner/Dockerfile`, `bk/runner/tracer.py` (throwaway), `docs/RESEARCH.md` (results).
- Tasks: start Docker Desktop; image with pinned GCC + gdb(Python) + libstdc++ printers; trace a 2,000-iteration
  loop in-process; emit JSON of line + int locals; run under `--network none --pids-limit --memory`; read a
  `vector<int>` and `map` via printers; test `ptrace` under default seccomp; measure compile time and steps/s.
- Tests: loop trace has the expected lines; STL value readable; null-deref caught with line; infinite loop
  killed from outside.
- Acceptance: numbers written into RESEARCH.md; go/no-go recorded in DECISIONS (D-002, D-003).
  **No-go → revisit the Valgrind route.**

## Phase 2 — Backend trace pipeline (no UI)  ✅ done 2026-10-07
Result: `POST /api/trace` implemented; 55 unit + 29 integration tests pass. The integration suite passed 10
consecutive runs, then two independent reviews (security, code) led to a redesign of the result channel (D-016) and
five more fixes (D-017, D-018, library-call steps, `tracer_error`, error hygiene); the full suite then passed 5
consecutive runs. Details: RESEARCH.md → Phase 2 Results / review table. Deviations from the plan below: no
JSON-Schema library (hand-written validation in `traceProcessor.js`, tested with forged records); no hash/cache
util (YAGNI); `shreshu` script not yet renamed.
Deferred (documented): `stdoutLen` accuracy, callbacks from library code, uninitialised-variable flag, per-IP rate
limiting, image digest pinning, marker for stacks over 64 frames.
- Objective: `POST /api/trace` returns a validated trace for primitive programs.
- Files: `routes/traceRoutes.js`, `controllers/traceController.js`, `services/runnerService.js`,
  `services/traceProcessor.js`, `utils/{limits,hash,validate}.js`, `runner/*`, tests.
- Tasks: request validation; runner spawn/kill/timeouts/output caps; compile-error parsing; crash status;
  trace schema v1 + JSON Schema validation; in-memory cache; remove `compilerService`/`gdbService` (D-005);
  add `node --test` runner.
- Tests: TEST_PLAN cases 1–3, 5, 15–19, 22–27 as integration tests; unit tests for the processor.
- Acceptance: all pass repeatably (10 runs); no host-side execution of user code; README API example accurate.

## Phase 3 — Frontend shell + step timeline  ✅ done 2026-10-07
Result: `fe/` works end to end (36 unit + 14 browser checks, 3 green runs; details RESEARCH.md → Phase 3).
Deviations: CodeMirror 6 instead of Monaco (D-019); `puppeteer-core` + system Chrome instead of Playwright (D-020);
dark theme only; JavaScript, not TypeScript. The visual pass found and fixed a real tracer bug (D-021).
Deferred: 5,000-step render timing, light theme, Firefox/Safari, a11y with a real screen reader.

(Original plan, kept for reference:)
## Phase 3 — Frontend shell + step timeline
- Objective: editor | visualization | control bar; step through a trace.
- Files: new `fe/` (Vite + React), api client, store, Controls, Editor, Timeline.
- Tasks: short design-direction doc first; Monaco/CM6; Run/Prev/Next/Reset/Play/Speed/scrubber; keyboard
  shortcuts; empty/loading/error states; current-line highlight; dark theme first.
- Tests: reducer/timeline unit tests; Playwright smoke (run hello world, step to end).
- Acceptance: visually inspected at 3 widths; no console errors; works against Phase 2.

## Phase 4 — Primitive variables & call stack  ✅ done 2026-10-07
Result: recursion now unwinds one frame at a time (D-024), every return that lands in user code is a step and shows
what the call returned (D-025), and the output panel fills in as the program prints (D-026). 37 frontend unit + 16
browser checks, 58 backend unit + 36 integration; details and the review table in RESEARCH.md → Phase 4 Results.
Deviations: frame cards, change flash and the stdout panel already existed from Phase 3, so the work was the three
tracer defects the real traces exposed. Deferred: return values of structs/containers (Phases 7-9), stdout with
`sync_with_stdio(false)` (measured: stays 0 until exit), a one-line `main` is still one step, step-budget cost of the
extra return steps (not measured).

(Original plan, kept for reference:)
## Phase 4 — Primitive variables & call stack
- Tasks: frame cards, change highlighting from `changes`, recursion depth, stdout panel.
- Tests: variables/loops/functions/recursion programs; fib(5) depth; highlight unit tests.
- Acceptance: cases 2, 3, 5, 6 visually correct.

## Phase 5 — Arrays
- Tasks: array cells, truncation, index highlight.
- Acceptance: bubble-sort demo correct; 1,000-element array truncates gracefully.

## Phase 6 — Pointers, references & heap
- Tasks: tracer tracks new/delete/malloc/free and pointer targets; processor assigns ids, marks dangling/null;
  frontend SVG arrows; freed/leaked states.
- Tests: pointer swap, new/delete, double free, use-after-free (shows `unavailable`/dangling, tracer survives).
- Acceptance: arrows correct; tracer survives bad pointers.

## Phase 7 — Structs/classes & linked lists
- Tasks: struct rendering; shape detection (list/dlist); horizontal layout; cycle guard.
- Tests: singly/doubly lists, insert/delete/reverse, cyclic list.
- Acceptance: reversal demo shows pointer rewiring correctly.

## Phase 8 — Trees / BST
- Tasks: tree layout; collapse large subtrees; recursion + tree combined view.
- Tests: BST insert/inorder; 200-node skewed tree; shared-node DAG.

## Phase 9 — STL
- Tasks: vector/string/array → map/set/unordered → stack/queue/deque/pair via printers; `unavailable` fallback;
  pinned GCC.
- Tests: TEST_PLAN cases 12–14 incl. reallocation, SSO strings, empty containers.

## Phase 10 — Step compression (move earlier if the spike shows speed problems)
- Tasks: loop detection, `skipped` events, keyframes, lazy expansion, `truncated` UX.
- Tests: 10⁷-iteration loop returns <5k steps within the wall limit; nested loops; recursion.

## Phase 11 — AI explanations (optional)
- Tasks: `/api/explain`; slice builder; grounded prompt; numeric/identifier cross-check; cache.
- Tests: golden slices; adversarial "invent a value" prompts; insufficient-data path.
- Acceptance: no unsupported values in output across the test set.

## Phase 12 — UI polish
- Tasks: typography, motion, responsive, light theme, sample gallery, accessibility pass.
- Acceptance: screenshot review at 3 breakpoints; keyboard-only use.

## Phase 13 — Security & performance hardening
- Tasks: security-reviewer pass; hostile-code suite; gVisor/microVM decision; rate limits; concurrency queue; load test.
- Acceptance: all hostile tests contained; threat model documented; only then consider deployment.

## Phase 14 — Deployment
- Not started until Phase 13 passes. No auth/payments/DB before then.
