# Decisions

Format: Decision / Reason / Alternatives / Why rejected / Status. Update Status when evidence changes.

## D-001 — C++ only
- Decision: first version supports C++ only.
- Reason: product scope; the GDB+DWARF path is language-specific.
- Alternatives: multi-language (Python Tutor style). Rejected: scope creep.
- Status: **accepted** (user decision).

## D-002 — Judge0 is not the trace engine
- Decision: tracing runs in our own runner container. Judge0 stays as an optional plain-run path.
- Reason (FACT, probed 2026-10-03): the public Judge0 sandbox has g++ but no gdb/valgrind/strace; execution is
  one-shot; self-hosting needs cgroup v1 + privileged Docker and reportedly fails on Docker Desktop/WSL2.
- Alternatives: (a) trace via Judge0 + instrumented source; (b) self-host Judge0 with a custom image;
  (c) ship a static gdb as an additional file.
- Why rejected: (a) needs source rewriting, see D-004; (b) needs cgroup v1 + privileged on a dev machine that
  can't provide it, and is still one-shot; (c) untested, size limits, fragile.
- Status: **accepted 2026-10-07** — Phase 1 spike showed gdb+ptrace works in a hardened container (RESEARCH.md → Phase 1 Spike Results).

## D-003 — Tracer = Python script inside GDB (not MI from Node)
- Reason: MI measured 155 steps/s with no inspection; MI is asynchronous text needing a full parser; our
  `gdbService.sendCommand` hung on `-exec-run` for exactly that reason.
- Alternatives: MI from Node (rejected: speed, parser burden); Valgrind-based (kept as fallback); LLDB/DAP (revisit).
- Status: **accepted 2026-10-07** — measured 2,069 steps/s (`step`) and 1,204 steps/s (bounded `stepi`) in the container vs 155 steps/s over MI.

## D-004 — No source-to-source instrumentation
- Reason: the previous tree-sitter attempt (now deleted in the working tree) handled only primitive declarations;
  C++ syntax (templates, macros, overloads) makes rewriting unreliable.
- Alternative: Clang LibTooling — deferred, heavy.
- Status: **accepted**.

## D-005 — Remove the host-local MI experiment
- Reason: `compilerService.js` / `gdbService.js` run user code on the host (violates "never expose arbitrary
  execution to the host"), target a GDB 7.6.1 without Python, and `gdbService` is broken.
- Status: **done 2026-10-07** — files deleted in Phase 2 after the runner and tests existed (nothing referenced them).

## D-006 — Facts only from execution; AI is an explanation layer
- Reason: product trust. AI receives validated trace slices and answers "insufficient data" otherwise.
- Status: **accepted**.

## D-007 — Delta-encoded trace with keyframes and a step budget
- Reason: million-step programs; memory; frontend responsiveness.
- Alternative: full snapshot per step (Python Tutor style) — too large beyond small programs.
- Status: **proposed**; compression heuristics are an open problem.

## D-008 — No database, auth, or deployment until the core works
- Status: **accepted** (user rule).

## D-009 — Backend stays CommonJS, routes → controllers → services
- Status: **accepted** (user rule).

## D-010 — Local-only until the Phase 13 security review
- Reason: arbitrary native code execution.
- Status: **accepted**.

## D-011 — Advance with bounded `stepi`, not `step`
- Decision: the tracer advances one source line by `stepi` until a new line-table entry starts, capped at
  `MAX_INSN_PER_LINE` instructions.
- Reason (FACT, reproduced 2026-10-07): at `-O0`, `while (true) { i = i + 1; }` has no code for the `while`, so
  the body loops on one line. `step` never returns, so no step budget can fire and only a wall-clock kill ends it.
- Alternatives: keep `step` + wall-clock only (rejected: loses all output unless flushed, and cannot say *which*
  line looped); a timer thread that interrupts GDB (rejected: GDB's Python API is not thread-safe).
- Cost (FACT): 1,204 vs 2,069 steps/s. Accepted.
- Open: a legitimate one-line loop with a huge count also trips the cap; on a trip collapse that line and continue.
- Status: **accepted**.

## D-012 — Stream every trace record; classify the end state from GDB events
- Decision: flush each record as it is produced; wall clock is a backstop, the step/instruction budgets are the
  primary limits; end state (`exited` / `crashed:<signal>` / `limit`) comes from `gdb.events.exited` and
  `gdb.events.stop`, never from parsing `step` output text.
- Reason (FACT): an 8 s wall-clock kill produced an empty trace because records were buffered; SIGSEGV was only
  reported as "No frame is currently selected".
- Status: **accepted**; implemented in Phase 2.

## D-013 — Collapse a long one-line loop with `advance *ADDR`; interrupt only if it never ends
- Decision: when a line exceeds `MAX_INSN_PER_LINE` (1,000), emit a `skip` record and run at full speed to the first
  code address of the next source line (`advance *ADDR`, a temporary breakpoint). A timer calls `gdb.interrupt()`
  after `LINE_SECONDS` (3 s); that yields `line_timeout`, reported as "Line N did not finish".
- Reason (FACT): `until` and `stepi` both single-step through GDB at ~1–2k instr/s, so a 3M-iteration loop looked
  infinite; breakpoint-based running took ~2 s and gave the right answer.
- Alternatives: abort on cap (rejected: false "infinite loop" for legitimate programs); raise the cap
  (rejected: 20,000 cost 10 s per collapsed line).
- Limitation: the program is not observed inside the collapsed line; the UI must show the `skipped` marker.
- Status: **accepted**; tested by `bigloop` (completes) and `infinite` (times out).

## D-014 — Never default to success; classify exits from explicit evidence
- Decision: end status comes from explicit signals: exit code present → `exited`; signal stop → `crashed`;
  `exited` with no exit code → `killed`; no end record → `timeout`/`internal_error`. A program killed by a signal
  is `runtime_error`, never `ok`.
- Reason (FACT, test #18): an OOM-killed program was reported as `ok` because the *absence* of an exit code was
  treated as a normal exit.
- Status: **accepted**; unit + integration tests.

## D-015 — A local becomes visible only after its declaring line has run
- Decision: arguments are visible from the start; a local is visible when its declaring line is before the current
  line or has completed once in that frame (frame identity = function + caller's `sp`).
- Reason (FACT, test #3): showing the variable on its own declaration line displays uninitialised garbage as truth.
- Alternatives: `sym.line < current` only (rejected: hides `for (int i…)` during its own line); show with an
  "uninitialised" flag (kept for later: detecting it needs the DWARF location/definition range).
- Status: **accepted**.

## D-016 — Results leave the container as length-prefixed frames on stdout; `/out` is a size-limited tmpfs
- Decision: the container writes compile/trace/stdout/stderr into an in-container tmpfs (`/out`, 48 MB) and `run.sh`
  prints them on stdout as `\x01CVIS <name> <emitted> <original>\n<bytes>` frames (`bk/src/utils/frames.js`). The
  backend reads only that stream, under a hard 8 MB cap. The host bind-mounts just the source, read-only.
- Reason (FACT: two independent reviews, then a test): with a rw bind mount the user's program owns the directory
  the host reads, so it can (a) replace a result file with a symlink and make the backend return an arbitrary host
  file, (b) plant a FIFO that blocks the reader forever, (c) fill the host disk with many files (`fsize` caps one
  file, not the count). All three share one root cause: results travelled through a host path the hostile program
  controlled.
- Alternatives: `O_NOFOLLOW`/`lstat` checks on the host reader (rejected as the primary fix: still a shared
  writable host directory, disk exhaustion unsolved); `docker cp` (rejected: unreliable with tmpfs).
- Consequences: a wall-clock kill now loses the frames (the in-container `timeout`s are shorter than the wall clock
  so this only happens if they fail → result is `timeout` with no steps); `run.sh` skips non-regular or symlinked
  files; a program that fills `/out` can starve its own trace (→ `internal_error`, self-inflicted only).
- Status: **accepted**; tests: frames parser (8 unit), runnerService (13 unit), symlink/FIFO and disk-bomb fixtures.

## D-017 — Failures of the runner are typed, generic to the client, detailed in the server log
- Decision: `RunnerError` carries a fixed public message per code plus a private `detail`; the controller logs the
  detail and returns only the generic text. Docker-daemon-down is 503, not 502. Every other docker/tracer failure
  path releases its concurrency slot (hung `docker kill` gets a grace period, then `child.kill` + `docker rm -f`).
- Reason (FACT, review): errors embedded host temp paths and docker stderr; a daemon that ignored `kill` would have
  held a slot forever (two such hangs = permanent 429).
- Status: **accepted**; unit-tested with a mocked `child_process`.

## D-018 — Local variable visibility state is per live frame, pruned every snapshot
- Decision: D-015's "completed lines" memory is dropped for any frame that is no longer on the stack.
- Reason (FACT, review + reproduced): a function called twice from the same site has the same frame key, so the
  second call inherited the first call's completed lines and showed `result` before its declaration. Reproduced
  with `twocalls.cpp` (steps 6–7 listed `result`), fixed, regression test added.
- Status: **accepted**.

## D-019 — Frontend: React + Vite + CodeMirror 6, JavaScript, no state library
- Decision: `fe/` is Vite + React 19 with CodeMirror 6 as the editor. State is one pure reducer
  (`lib/playerReducer.js`) plus a pure decoder (`lib/reconstruct.js`); no Redux/Zustand, no TypeScript yet.
- Reason: the app has one screen and one state machine (idle → loading → ready | failed + a step index); both
  pieces are pure functions and unit-tested without a DOM. CodeMirror 6 is ~10× lighter than Monaco, themable
  with CSS variables (the amber "now" line needs it), and has no worker/loader setup. Whole app: 211 kB gzipped
  (budget for an app page: 300 kB).
- Alternatives: Monaco (rejected: size, workers, theming friction); TypeScript (deferred: the schema is still
  moving — Phases 5–9 add value kinds — revisit when it freezes; the web rules ask us to flag untyped React);
  state library (rejected: YAGNI).
- Status: **accepted**.

## D-020 — Browser tests drive the system Chrome with `puppeteer-core`
- Decision: `fe/e2e/smoke.mjs` (14 checks, screenshots) uses `puppeteer-core` against the installed Chrome; no
  browser download. The Claude-in-Chrome extension was not connected in this environment.
- Reason (FACT): the visual pass is only worth anything if it is repeatable; the script found three real bugs
  (D-021, D-022) that unit tests could not.
- Alternatives: Playwright (rejected for now: downloads its own browsers); manual clicking (not repeatable).
- Limitation: needs Chrome at `CHROME_PATH`, Docker, the backend and the dev server running; not in CI yet.
- Status: **accepted**.

## D-021 — Never snapshot a function at its first instruction: run to the end of the prologue
- Decision: when a step lands on a function's entry address, the tracer runs to the first line-table address after
  it that starts a different line before taking the snapshot. The "call" step therefore shows the first body line.
- Reason (FACT, found by *looking* at a screenshot, then reproduced): the current `factorial()` frame showed
  `n = 30849`. At the entry instruction the argument has not been stored, so GDB reads stack garbage; the unit
  tests, the integration tests and the 12 browser assertions all passed with that bug present.
- Test: integration test asserts every argument value ever shown is one of the legal values (RED with
  `1819242352, 31691, …`, GREEN after). Also covers same-line recursion (`int f(int n){ return f(n-1); }`) because
  the entry check no longer depends on the line number changing.
- Cost: the function-header line is not shown as its own step (Python Tutor shows it). Accepted: a true value on
  line 4 beats a garbage value on line 3.
- Status: **accepted**.

## D-022 — The status chip reports the outcome, not that a response arrived
- Decision: `lib/status.js` maps trace status → chip label/tone (`compile error`, `crashed`, `timed out`, …);
  unknown statuses are shown as a failure, never as success. The banner drops a message that repeats its title.
- Reason (FACT, from screenshots): a failed compile showed a green "traced" chip and "Compilation failed —
  Compilation failed".
- Status: **accepted**; unit-tested, plus two browser assertions.

## D-023 — CORS allows both loopback spellings of the dev frontend
- Decision: default allow-list is `http://localhost:5173` and `http://127.0.0.1:5173` (env `FRONTEND_ORIGIN`,
  comma-separated). Still never `*`.
- Reason (FACT): the browser test loaded `127.0.0.1` and every run failed with "Cannot reach the backend"; a
  developer following Vite's printed URL would hit the same wall.
- Status: **accepted**; unit-tested for both origins and for a rejected foreign origin.

## D-024 — A step's identity is (line, function, frame), not (line, function)
- Decision: `advance_one_line` also compares the frame key (function + caller's `sp`, D-018) at every line boundary.
- Reason (FACT, reproduced on the real trace): in `fact()` the closing `}` of every recursion level is line 5. After
  `fact(1)` returned into `fact(2)`, the tracer saw "same line, same function name" and kept stepping, so the stack
  depth went `5 -> 1` in one step and the three intermediate returns were never shown.
- Test: integration test "recursion unwinds one frame at a time" asserts the depth never falls by more than 1 between
  steps after the peak (RED `depth jumped 5 -> 1: 1,2,2,3,3,4,4,5,5,1,1,1`, GREEN after).
- Status: **accepted**.

## D-025 — A return that lands in user code is a step of its own, and carries the return value
- Decision: the tracer ends the step when a real `ret` lands in user code (`pc == caller's resume address` and
  `sp >= the callee's CFA`; an exception unwind satisfies only the second). If the callee's return type is a primitive
  (int/bool/char/enum/pointer in `rax`, float/double in `xmm0`, x86-64 SysV) the value is read at that moment and sent
  as `returned` on the next step. Void, struct, reference, `long double` and `main` carry none. The backend re-validates
  `returned` like any variable; the stack view shows "fact() returned 6" on the frame that received it.
- Reason (FACT): for a function written on one source line there is no later line boundary after the return, so one
  `advance_one_line` ran the rest of the program: the trace of `int fact(int n){...}` stopped after the third call with
  `status: ok`, `stepsRecorded: 4` and `stdout "6\n"` (the program had finished; the trace had not). TEST_PLAN #5 also
  asked for return values. Side effect, intended: `return` steps now land mid-line in the caller (`n * fact(n-1)`
  with the result arriving), which is where the value is actually received.
- Tests: `recursion_oneline` (RED `trace ended before unwinding: 1,2,3,4`), per-type values in `returns.cpp`
  (`2.5`, `true`, `65 'A'`, void gives none), recursion values `1, 2, 6, 24` in order; backend unit tests for forged
  `returned` values; a browser check that reads the notes while stepping.
- Not covered (documented, not guessed): struct/container return values (Phases 7-9), `long long` > 8 bytes, a
  one-line `main` (still a single step).
- Status: **accepted**.

## D-026 — The traced program's stdout is unbuffered (`LD_PRELOAD` shim), so the output panel can replay it
- Decision: `bk/runner/unbuf.c` (a constructor calling `setvbuf(stdout, NULL, _IONBF, 0)`) is compiled into the
  image as `/opt/unbuf.so`; the tracer sets `LD_PRELOAD` for the traced program only, and only if the file exists
  (a missing library would put a loader warning into the user's stderr).
- Reason (FACT, measured): with `cout << ... << "\n"` the per-step `stdoutLen` was `0,0,0,0,0,0,0,0,0` and the whole
  output appeared at the last step; after the shim `0,0,7,7,14,14,21,21,21`. Bytes and order are unchanged; only
  timing differs from a normal (block-buffered) run.
- Measured limit: after `std::ios::sync_with_stdio(false)` `cout` keeps its own buffer, the shim cannot reach it and
  `stdoutLen` stays 0 until exit.
- Alternatives not taken (INFERENCE): a pty (changes isatty behaviour and merges stderr), `stdbuf` (same LD_PRELOAD
  mechanism, one more dependency).
- Status: **accepted**.

## D-027 — Heap blocks come from an allocation log (`heaplog.so`), not from guessing at pointers
- Decision: `bk/runner/heaplog.c` wraps `malloc/calloc/realloc/free` (so `new`/`delete` are covered) and appends
  `{addr, size, kind}` events to a static 65,536-entry table; the tracer (`heap.py`) replays the new events at every
  snapshot, keeps freed blocks marked dead, and queries blocks by address (sorted list + bisect). It is preloaded next
  to `unbuf.so` for the traced program only.
- Reason (FACT, measured): GDB cannot tell how big a heap block is or whether it was freed. With the log, `new int[5]`
  is read as five ints, `delete` leaves a block marked `live: false` (pointer `state: "freed"`), and a block that was
  visible and is no longer reachable is reported `orphan` (leak). A double free is still reported as the SIGABRT it is.
- Limits: events past 65,536 are lost (`overflowed`); aligned allocations (`aligned_alloc`) are not logged; a block
  is typed by the first pointer that reaches it (`void*` blocks are not followed).
- Alternatives not taken (INFERENCE): breakpoints on malloc/free (fire inside library code during `finish`, one stop
  per allocation), reading glibc chunk headers (sizes are rounded up, no freed state).
- Status: **accepted**.

## D-028 — Values are a typed tree; the heap travels as per-step deltas; schema stays 1
- Decision: variable entries gain kinds `array`, `struct`, `string`, `seq`, `map` (plus pointer fields `to`, `state`,
  `block`, `text`); scalars inside arrays/containers are plain strings (compact). Each step may carry
  `heap: {full, set, del}`: the tracer sends only blocks whose JSON changed, the processor keeps the running table and
  emits the whole table on keyframes, the frontend rebuilds it exactly like frames. `at`/`size` (own address) are kept
  only on entries some pointer in the same snapshot points into.
- Why schema 1 is kept: every addition is optional; an old-style step still decodes.
- Why a sanitizer: the entries come from the untrusted side (D-016). `valueSanitizer.js` re-derives every field, caps
  depth (8), items (64), fields (40), blocks (150) and total entries per step (3,000). A test found that collapsing
  members past the budget still let a forged container emit one placeholder per member (≈ budget × 64 entries); the
  loops now stop when the budget is spent.
- Status: **accepted**.

## D-029 — Shapes are detected from the data: self-pointer fields decide list / tree / graph
- Decision: a heap struct with exactly one pointer field to its own type is a list node, with two a tree node, or a
  doubly linked node when the pointers are inverses of each other (`a.f1 == b` and `b.f2 == a`); three or more is a
  general graph. Field names (`next`, `prev`, `left`...) only break ties and the no-evidence case. Connected pieces
  are found with union-find; the head is the node nothing else on the spine points at. Trees past depth 6 collapse into
  "N more nodes"; a node reachable from two parents is drawn once and flagged `shared`; cycles stop the chain.
- Reason (INFERENCE, checked on the demo programs): structure beats naming, and a half-reversed list correctly
  shows as two lists.
- Status: **accepted**.

## D-030 — Arrows are measured from the real layout, and are pure geometry
- Decision: components render dots (`data-src`) and boxes (`data-key`); `PointerArrows` measures both with
  `getBoundingClientRect` (re-measured on resize, nested scroll and step change) and `arrowPath` (pure, unit tested)
  picks the curve. Arrow targets come from addresses (`memoryGraph.buildResolver`: innermost box containing the
  address, ties broken by the pointer's target type). Loop-variable markers under array cells are an INFERENCE from
  names (`i`, `j`, `lo`, `mid`...) and are labelled as such in code.
- Known polish gap: stack arrows cross the rows of the call stack on their way down; a routed "bus" along the right
  edge would be cleaner (Phase 12).
- Status: **accepted**.
