# C++ Visualization Research

Status: Phase 0, 2026-10-03. Labels used throughout:

- **FACT** — read in a source or measured by us (source/measurement named).
- **INFERENCE** — our reasoning from facts; not verified.
- **RECOMMENDATION** — what we should do.

Honest scope note: this was done in one session with web search/fetch and a few local experiments. Several
claims marked INFERENCE must be validated by the Phase 1 spike before the architecture is locked. Subagents
were not used; the research was done inline.

## Problem

Show a programmer what their C++ program actually does, step by step: variables changing, pointers moving, heap
objects appearing, calls stacking up. The data must come from **real execution**, never from an LLM.

What makes this hard (not a UI problem):

1. Getting a faithful per-step state of a native, unsafe-by-default language (raw pointers, uninitialised memory).
2. Turning raw memory into *meaningful* structures (a vector, a linked list, a tree).
3. Running untrusted native code safely.
4. Not drowning the user (or the browser) in millions of steps.

## Existing Solutions

| Tool | How it works | Strengths | Limits | Lesson |
|---|---|---|---|---|
| **Python Tutor C/C++** (`opt-cpp-backend`) | Hacked **Valgrind 3.11.0** records stack/heap/globals per executed line; `vg_to_opt_trace.py` converts to OPT JSON. | Proven UX; true heap/pointer picture; no debugger round-trips. | FACT: the converter's own comments call it "pretty brittle", assume `gcc -ggdb -O0 -fno-omit-frame-pointer`, developed on GCC 4.8/Ubuntu 14.04; "not suitable for millions of steps" (Guo, IEEE Software blog). Valgrind fork is old (3.11.0), GPL. | "Snapshot per step: stack, heap, globals" is the right mental model. Cap steps. |
| **cpp-tutor** (jmanoj0905) | Patched Valgrind + opt-cpp-backend in Docker; React frontend with stack/heap cells, shape panels, call tree, SVG pointer arrows; traces cached by hash. | Good reference frontend decomposition; shape detection (list/tree) in the frontend. | GPL-3.0; its README says traced code is "only process-limited" inside the container — must be hardened. | Detect linked-list/tree *shapes* from the pointer graph in post-processing/frontend, not in the tracer. |
| **See++** (knazir) | Valgrind (SPP-Valgrind submodule), Docker → AWS Lambda for sandboxing. | Stanford CS106B pedagogy; arrows between stack/heap; leaks highlighted. | App MIT, Valgrind part GPL. Original design ran untrusted code on EC2, which the maintainers call "incredibly" insecure, before the rewrite. | Even maintainers of a working tool had to rework sandboxing; do it first. |
| **Apepsis/SeePlusPlus** | **GDB/DWARF** tracer → versioned "ProgramTrace v1" → analyzers (leaks, dangling). | Closest to our recommended path; unsupported values reported as *unavailable*, never guessed; seccomp'd runner container; hostile-code CI tests. | Prototype (14 commits, 0 stars); STL "experimental"; no threads. Its README: not a secure online judge. | Normalise to a UI-independent schema; "unavailable" is a first-class value; test hostile code in CI. |
| **OPT_CPP** (dive4dec) | WASM (xeus-cpp/Clang-REPL) in the browser; LLDB-over-DAP described as a natural integration. | No server execution at all. | The debugger part appears to be a proposal, not built. | Browser-side execution is a future option that removes server sandboxing. INFERENCE only. |
| **gdbgui-style GUIs** | Frontend over GDB MI. | Mature MI usage. | Interactive-debugger oriented, not trace-oriented. | MI is workable but round-trip bound (see Performance). |

## Execution

FACT sources: Judge0 docs (ce.judge0.com), Judge0 CHANGELOG, our probes of `https://ce.judge0.com` on 2026-10-03.

### Judge0 (current candidate)

- FACT: open-source (GPL-3.0), uses `isolate`; v1.13.1 (2024-04-18) is the latest release in the changelog; it
  fixed three critical vulnerabilities (CVE-2024-28185/28189/29021). Execution is **one-shot**: submit source →
  get stdout/stderr/status. No interactive session.
- FACT (our probe): the public sandbox contains `g++` (Debian 8.3.0 on PATH) but **no gdb, no gdbserver, no
  valgrind, no strace**. The user process had no seccomp filter (`Seccomp: 0`). `ptrace(PTRACE_TRACEME)`
  returns 0. Network is disabled (`allow_enable_network:false`). Limits on that instance: CPU 5 s default /
  20 s max, wall 10 s / 30 s, memory 256 MB default / 2 GB max, 128 processes.
- FACT: self-hosting needs Linux amd64, privileged Docker, Docker Compose, and **cgroup v1** (isolate 1.8.1).
  Reports say Docker Desktop/WSL2 (cgroup v2 only) fails with "Failed to create control group". A privileged
  container on the same host is a documented risk.
- FACT: docs say `wait=true` "doesn't scale well"; the official api.judge0.com host doesn't enable it.
- FACT: limits on a public instance are set by that host's admin and can change; no SLA on the page we read.
- INFERENCE: Judge0 **cannot be the trace engine**. Tracing needs gdb (or equivalent) *inside* the sandbox next
  to the program, and the public instance has none. Shipping a static gdb via `additional_files` was not tried
  and looks fragile.
- INFERENCE: Judge0 fits "run and grade", poorly fits "step and inspect".
- RECOMMENDATION: keep `judge0Service` only as an optional plain-run path in the MVP (it works today). Do not
  build the tracer on it. Re-evaluate deleting it once our own runner exists (DECISIONS D-002). Note that
  sending users' code to a third-party public endpoint is a privacy/availability dependency.

### Own runner (container with g++ + gdb)

- RECOMMENDATION: a Linux container image with a modern GCC, GDB with Python, our tracer script, run per request
  with strict limits. It is the only option found that gives DWARF-accurate types plus STL pretty-printers.

### Alternatives considered

| Approach | Verdict |
|---|---|
| Valgrind-based (Python Tutor lineage) | Gives heap/stack picture but depends on an old patched fork, brittle, GPL, no STL awareness. Fallback/reference. |
| Source instrumentation (tree-sitter, the previous attempt in this repo) | Already abandoned in the working tree (deleted files, dependency removed). It only handled primitive declarations (`TRACEABLE_TYPES`). C++ is too hard to rewrite correctly (templates, macros, overloads). Rejected. |
| Clang LibTooling instrumentation | Robust but heavy build/maintenance, compiler-version coupling. Future only. |
| LLDB + DAP | Plausible, DAP is a standard. GDB's Python API is better documented for in-process scripting. Revisit if GDB limits bite. |
| rr / record-replay | Not needed: we want forward stepping with rich values. |
| WASM in browser | Future; removes server execution risk, but debug-info/STL story unknown. |

## Debugging / State Capture

FACT sources: GDB manual (MI Variable Objects, Python Events), search results on libstdc++ printers.

| Need | Mechanism | Notes |
|---|---|---|
| Line info | `-g -O0` → DWARF line table; GDB `step`/`next`, frame `find_sal()` | `-O0` mandatory; optimised code skips/merges lines. |
| Local variables / args | GDB Python: iterate `frame.block()`, `symbol.value(frame)`; or MI `-stack-list-variables` | Types come from DWARF, so no source parsing. |
| Call stack | `gdb.newest_frame()` / `frame.older()`; MI `-stack-list-frames` | Filter frames without symtab (libc, libstdc++ internals). |
| Pointers | `Value.dereference()`, `Value.address`, `Type.code == TYPE_CODE_PTR` | Wrap reads in try/except `gdb.MemoryError` → emit `unavailable`. |
| Structs/classes | `Type.fields()` recursion; base classes via `is_base_class` | Cap depth and size. |
| Arrays | `TYPE_CODE_ARRAY` + `range()` | Cap element count; mark `truncated`. |
| STL containers | GDB libstdc++ pretty-printers (`children()`, `display_hint()` = `array`/`map`/`string`) | FACT: MI needs `-enable-pretty-printing`; printers need the libstdc++ Python script auto-loaded. FACT (reports): a GCC 15 map/set printer `num_children` problem affects DAP-style use; a cpptools issue reports failures with complex map keys. Pin the toolchain and test. |
| Heap objects | Breakpoints on `operator new`/`malloc`/`free` to record `(addr, size)`; or treat pointer targets outside stack/globals as heap | INFERENCE: per-allocation breakpoints add overhead; a `malloc` block has no type, only the *pointer* type at the use site. Needs prototype. |
| stdout | Redirect inferior stdout to a file; slice by offset per step | Keep separate from the tracer's own channel. |
| Calls/returns | Frame-depth change between stops; `StopEvent.details['return-value']` after `finish` | FACT: GDB docs say `StopEvent` carries `return-value` after `finish`. |

### MI vs. in-process Python

- FACT (measured): driving `-exec-next` over MI from Node with GDB 7.6.1 on Windows gave **155 steps/s** with
  *no* variable inspection (3000 steps in 19.4 s). Old GDB on Windows, so a pessimistic data point only.
- FACT (secondary sources): per-stop work (backtraces, symbol lookups) costs more than the step itself.
- INFERENCE: a Node↔GDB MI round-trip per step plus several queries will be too slow beyond hundreds of steps.
  An in-process Python script (`gdb -batch -x tracer.py`) removes the pipe round-trips and MI text parsing.
  The improvement is unmeasured → the Phase 1 spike must measure on Linux.
- RECOMMENDATION: tracer = Python script inside GDB, writing JSON to a file; Node only spawns the container and
  reads the result. `gdbService.js` MI code stays only as a throwaway experiment.

### Existing bug in our MI code (root cause, reproduced)

`gdbService.sendCommand` resolves on `^done`/`^error`. `-exec-run` replies `^running` followed by asynchronous
`*stopped`, so the promise never resolves: `test-gdb-service.js` prints the breakpoint response and then hangs
(reproduced 2026-10-03, killed at the 20 s guard). It is not a one-line fix: MI output is asynchronous and
needs a real record parser (result `^`, async `*`, stream `~@&`, tokens). Another reason to prefer in-process
Python.

## Data Structures

Principle: the tracer reports **memory facts** (typed values, addresses, edges). A post-processor/frontend
derives **shapes**. The tracer must not know what a "linked list" is.

- **Primitives**: `{kind:"int", value:"42"}` (value as string for 64-bit safety). Uninitialised-vs-garbage is not
  reliably knowable (INFERENCE); show the raw value.
- **Arrays**: `{kind:"array", elemType, length, elems:[…], truncated}`.
- **Structs/classes**: `{kind:"struct", type, fields:[{name,value}]}`; base classes as fields.
- **Pointers**: `{kind:"ptr", addr:"0x…"|null, target:"<id>"|null}` — the arrow is an edge, not text.
- **References**: same as pointer with `ref:true`.
- **Heap**: map `heapId → {addr,size,type,value,live}`; freed blocks keep `live:false` so dangling arrows can be shown.
- **Linked / doubly linked list**: post-processor rule: struct with ≥1 self-typed pointer field → follow chain
  with cycle guard; `next`+`prev` → doubly.
- **Trees / BST**: struct with two self-typed pointers → tree layout; "BST" is only a display hint (ordered keys).
- **STL**: `{kind:"container", container:"vector|map|set|string|stack|queue|deque", size, elems|entries}` from
  printers' `display_hint()`/`children()`. `stack`/`queue` are adaptors over `deque`; expect to unwrap them.
- **Graphs**: adjacency lists appear as `vector<vector<int>>` / `map<int,vector<int>>`; show as containers first;
  graph *drawing* is Future.
- **Unavailable**: `{kind:"unavailable", reason:"memory-error|too-deep|too-large|no-printer"}` — never guess.

## Security

FACT: See++'s maintainers called their original run-on-the-server design "incredibly" insecure; Judge0 had
three critical CVEs in versions up to 1.13.0 and needs privileged Docker; nsjail/isolate/containers share the
host kernel; Firecracker gives hardware-level isolation but needs KVM. Our probe: Judge0's user process had no
seccomp filter.

Controls (RECOMMENDATION; designed in from Phase 1, hardened/reviewed in Phase 12):

| Threat | Control |
|---|---|
| Reads host files | Container: read-only root, no host mounts, per-run tmpfs work dir, non-root user |
| Network abuse | `--network none` |
| Fork/thread bomb | `--pids-limit` + `RLIMIT_NPROC` |
| Memory exhaustion | `--memory` with swap off + `RLIMIT_AS` |
| Infinite loop / CPU burn | Wall-clock kill from *outside* (Node kills container) + CPU quota + tracer step cap |
| Giant output | Cap stdout/stderr/trace size; truncate with flag |
| Compile bombs (template recursion, `#include "/dev/zero"`) | Compile inside sandbox with timeout and output cap; limit source size (e.g. 64 KB) |
| Malicious `.gdbinit` / auto-load | `gdb -nx -batch`, empty `auto-load safe-path`; user files never in gdb's cwd |
| Forged tracer output | Tracer writes to a file the user program has no fd for; frontend treats all strings as untrusted (no `innerHTML`) |
| ptrace inside container | Keep Docker default seccomp, `no-new-privileges`, drop all caps. INFERENCE: seccomp's `personality` rule may break gdb's ASLR disable → measure in the spike |
| Container escape | Shared kernel. For public deployment use gVisor or a microVM (Firecracker/Kata); decide at Phase 12 |
| Request flooding | Per-IP rate limit, global concurrency cap, queue |
| Secrets in sandbox | Runner image has no env secrets; Node never forwards `.env` |

RECOMMENDATION: until Phase 12 is complete the app must **not** be publicly exposed. Local-only.

## Performance

Measured so far (all weak, see caveats):

- Judge0 executed a 10⁷-iteration loop natively (user-reported earlier test). Our probes ran in ~0.01 s.
- MI stepping: 155 steps/s (Windows, GDB 7.6.1, no inspection).
- **Not yet measured**: compile time on the runner image, in-process tracer steps/s, trace size, frontend render.
  INFERENCE: `<bits/stdc++.h>` compiles slowly (seconds); a precompiled header in the runner image may help.

Design consequences:

- Tracing 10⁷ loop iterations line by line is infeasible → need a **step budget** and a trace that does not
  store every step.
- **Delta encoding**: each step stores only `changes` since the previous one; a full keyframe every N steps so
  the frontend can seek by replaying from the nearest keyframe.
- **Loop collapsing** (RECOMMENDATION, design open): after the budget, switch to fast mode — run to the loop exit
  and record `{kind:"skipped", iterations:N}`. Loop detection by repeated line sequence in the same frame.
- **Frontend**: render only the current step; timeline scrubber; never ship more than ~5,000 steps by default;
  show a `truncated` banner when the cap is hit; lazily expand large containers.
- **Large programs / multi-file**: API takes `files:[{name,content}]` from day one; MVP supports one file.

## AI

AI **may** (Phase 10, optional):

- Narrate a *given* transition: input `{prevState, nextState, changes, sourceLine}` → prose.
- Explain an algorithm at a high level from source plus a verified trace summary.
- Explain a crash **grounded in the captured crash state**.

AI **must not**:

- Produce, guess, fill in or "repair" any variable value, address, pointer target, line number or ordering.
- Claim what code "would" do when there is no trace for it.

Guardrails: AI receives only schema-validated trace slices; prompt requires "insufficient data" when a needed
fact is absent; responses cached by `(traceHash, step)`; UI marks AI text as explanation, visually distinct from
trace data. Idea to evaluate: reject AI text containing numbers/identifiers absent from the supplied slice.

## Phase 1 Spike Results (measured 2026-10-07)

Setup (FACT): `ubuntu:24.04` image (`bk/runner/Dockerfile`: g++ 13, gdb with Python, libstdc++ printers), Docker
Desktop 29.x on Windows 11 / WSL2, 16 CPUs. Runs used `--network none --memory 512m --pids-limit 64`, default
seccomp, non-root user (uid 10001). Tracer = `bk/runner/tracer.py` run as `gdb -nx -batch -x`. Programs in
`bk/runner/spike/`.

| Check | Result |
|---|---|
| `ptrace`/gdb under default seccomp and the limits above | **FACT: works** (only a harmless "cannot disable ASLR" warning) |
| Compile `-g -O0`, iostream program | **FACT: 0.29 s**; with `<bits/stdc++.h>`: **1.30 s** |
| Trace speed, GDB `step` | **FACT: 2,069 steps/s** (4,005 steps, 1.94 s) vs 155 steps/s measured earlier over MI |
| Trace speed, bounded `stepi` (D-011) | **FACT: 1,204 steps/s** (4,006 steps, 3.33 s) |
| Whole `docker run` for a 4k-step trace | **FACT: 3.7 s** wall (includes container start, compile, trace) |
| `std::vector<int>`, `std::map<string,int>` | **FACT: readable** via `str(value)` → `std::vector of length 2, capacity 2 = {10, 20}`, `std::map with 2 elements = {["a"] = 1, ["b"] = 2}` |
| Null dereference | **FACT: caught**, SIGSEGV with the faulting line (4) |
| Infinite loop, killed from outside | **FACT: works** (`timeout`, exit 124, no leaked container) |
| Memory limit | **FACT:** 2 GB allocator killed at `--memory 256m` (exit 137) |
| PID limit | **FACT:** `fork()` loop stopped at 62 of 200 with `--pids-limit 64` |
| Network | **FACT:** `Network is unreachable` with `--network none` |

**Verdict (RECOMMENDATION, evidence above): GO.** In-container GDB-Python tracing is feasible and ~13x faster
than MI. D-002 and D-003 are confirmed. Valgrind stays a documented fallback only.

Flaws the spike exposed (each one changes the Phase 2 design):

1. **`step` cannot be bounded (FACT, reproduced).** At `-O0`, `while (true) { i = i + 1; }` emits no code for the
   `while`, so the body jumps back to itself on the same line. GDB's `step` only returns on a *different* line, so
   it never returns and a step budget never fires. First attempt to test this used a multi-line loop and hit the
   same hang, which is what led to the diagnosis. Fix: advance with `stepi` and a per-line instruction cap
   (D-011). Measured: the cap trips after 20,000 instructions in ~5 s. INFERENCE: a *legitimate* one-line loop
   with a huge iteration count trips the same cap, so on a trip we must collapse the line and continue, not abort.
2. **Output is lost when the tracer is killed (FACT).** Records were buffered, so the 8 s wall-clock kill left an
   empty trace. Fix: flush every record (done in the spike) and treat wall clock as the backstop, not the
   primary limit (D-012).
3. **End-of-run state is not classified (FACT).** SIGSEGV text lands in `to_string` output of `step`; the spike
   only reported "No frame is currently selected". Fix: use `gdb.events.stop` (signal events) and
   `gdb.events.exited` (exit code) to produce `status: exited | crashed(signal) | limit`.
4. **Dead objects are shown with garbage (FACT).** On the closing brace the destroyed vector printed
   `{1210914145, 25731}` (freed memory). Locals must be filtered by lexical scope/lifetime, and uninitialised
   locals (e.g. `sum` at step 0 = `140730915244600`) need an "uninitialised" marker.
5. **Library frames (INFERENCE, partly seen):** template instantiations from headers carry line info, so GDB
   enters them; the spike steps out with `finish` when the frame's file is not the user file. Needs a proper
   rule (skip `/usr/include`, keep user lambdas/templates).

Not yet measured: traces with 100k+ steps, trace JSON size, memory of the gdb process, compile time on cold
container start vs. a warm container pool, behaviour on Docker engines other than Docker Desktop.

## Phase 2 Results (measured 2026-10-07, production runner image `cvis-runner:2`)

Container flags used by the backend (final, after the security review below): `--network none --read-only
--memory 512m --memory-swap 512m --pids-limit 64 --cpus 1 --cap-drop ALL --security-opt no-new-privileges
--tmpfs /tmp:exec,64m --tmpfs /out:noexec,48m --ulimit core=0 --ulimit nofile=256 --ulimit fsize=16MB`, non-root,
only the source bind-mounted (read-only). **FACT:** GDB + ptrace still work with *all capabilities dropped* and a
read-only root filesystem.

| Check | Result |
|---|---|
| Plain 4,005-step loop, full-frame snapshots | **FACT:** ~10 s wall; tracer time split snapshot 4.1 s + advance 5.0 s ≈ 400 steps/s (the spike's 1,200–2,000 steps/s read only the top frame's locals) |
| Flush interval (1 / 50 / 1000 records) | **FACT:** no effect (10 / 9 / 10 s) — flushing is not the bottleneck |
| `--cpus` 1 / 2 / 4 | **FACT:** no effect (10 / 11 / 11 s) |
| One-line infinite loop | **FACT:** `line_timeout` after the 1,000-instruction cap + 3 s interrupt, ~5 s total |
| Legit 3M-iteration one-line loop | **FACT:** completes in ~2 s, correct sum, 6 steps + a `skipped` marker |
| Whole suite | **FACT:** 25 unit + 23 integration tests; one integration run ≈ 46 s |

Flaws found by testing, and what was done (root causes, not patches):

1. **Per-line cap was 20,000 instructions → 10 s per collapsed line (FACT).** `stepi` runs at ~2,000/s through
   GDB, so the cap itself was the latency. A source line is tens of instructions; default now 1,000.
2. **`until` cannot leave a long one-line loop (FACT).** It re-uses range stepping, again ~1,000 instr/s; a
   3M-iteration loop timed out as if infinite. Fix: `advance *<address of the next code line>` runs at full speed
   (a temporary breakpoint); the timer interrupt (`gdb.interrupt`, thread-safe, GDB 15.1) remains the backstop
   for real infinite loops. This is what lets the tracer tell "huge" from "infinite" (D-013).
3. **A variable was shown before its declaration ran (FACT, test #3).** `int a = 5;` appeared at line 3 holding
   garbage. Fix: a local is alive once its declaring line is completed in that frame (or lies before the current
   line); frame identity = function + caller's `sp` (the callee's CFA), stable across steps and distinct per
   recursion level. Cost: one extra register read per frame per step.
4. **OOM kill reported as a clean exit (FACT, test #18) — a correctness bug.** The cgroup kills the program with
   SIGKILL; GDB's `exited` event then has no `exit_code`, and the tracer mapped that to `exited` → status `ok`.
   Fix: `exited` without an exit code is `killed` → `runtime_error`. Lesson: classify from the *absence* of
   information explicitly; never default to success.
5. **Test-runner trivia:** Node 22 `node --test <dir>` treats a directory as a file; scripts use a glob.
6. **Wrong test expectation (mine):** `__proto__` is a legal C++ identifier. The processor keeps it as plain data
   on a null-prototype object; the test now asserts "no prototype pollution" instead of "name dropped".

### Phase 2 security and code review (two independent subagent reviews, then verified by me)

Both reviews found no command injection, path traversal or obvious escape (docker args are an array, names are
random hex, limits are constants). Findings that were real, and what changed:

| Finding | Evidence | Fix |
|---|---|---|
| HIGH: backend reads result files from a rw bind mount the hostile program controls (symlink → arbitrary host file; FIFO → permanent hang) | Both reviewers, from the code; the reading path is `fs.open` on a path inside that directory | D-016: results as frames on container stdout, `/out` tmpfs; `run.sh` skips symlinks/non-regular files. Tests: forged-files fixture |
| HIGH: disk exhaustion — `fsize` caps one file, not the count | Reviewer; design reasoning | Same tmpfs (48 MB) + per-file `fsize` 16 MB; disk-bomb fixture answers normally |
| Reproduced bug: function called twice showed its local before declaration | `twocalls.cpp`: step 6–7 listed `result` (FACT) | D-018; regression test |
| Tracer failures reported as clean exit / generic timeout | Code review; reasoning from the `except gdb.error` path | `tracer_error` end status → `internal_error`; per-variable error handling; last line read before the process can exit |
| Hung `docker kill` holds a concurrency slot forever | Reviewer; unit test with a docker mock that ignores the kill | Grace timer → `child.kill`, `docker rm -f`, slot released |
| Error messages leaked temp paths / docker stderr | Reviewer; unit test asserts no leak | D-017 |
| Forged `end` record fields (signal/exitCode/line) reflected to the client | Reviewer; unit test with an HTML-laden signal | Each field re-validated |
| Open CORS | Reviewer | Only `FRONTEND_ORIGIN` (default `http://localhost:5173`); unit-tested |
| stdout truncation silent; `stdoutLen` reset to 0 past the cap | Reviewer | `limits.stdoutTruncated`; clamp |
| `g++ \| head -c` can die of SIGPIPE → fake compile error | Reviewer, reasoning | Compile to a file first, then `head` |
| Timeouts inconsistent (20 + 25 s compile+trace vs 40 s wall clock) | Reviewer | Wall clock 60 s |
| Also: `--ulimit core=0`, `--read-only`, `nofile`, setuid bits stripped, comma-in-path check | Reviewer (LOW) | Done |

A bug none of the reviewers named, found by a test written for something else (`bigstdout`): **a source line that
contains library calls produced one step per call**, because after `finish` returned from library code the tracer
declared "new line" without checking that the line had changed (`cout << a << endl` = three steps at one line).
Fixed by re-checking the landed state; a RED→GREEN assertion (`hello.cpp` has exactly one step at its `cout` line)
guards it.

Deliberately not done (documented, with reasons): per-IP rate limiting (new dependency; only matters once the app is
exposed, D-010 → Phase 12); pinning the base image by digest and apt versions (reproducibility, deferred to
deployment); `frames_truncated` marker for stacks over 64 frames (the outermost frames are dropped silently and
`f<n>` ids shift — recorded as an open problem); `handle SIGUSR1 nostop` (unverified inference about GDB defaults).

## Phase 3 Results (measured 2026-10-07: frontend shell + step timeline)

Built: `fe/` (Vite + React 19 + CodeMirror 6): editor | stack + output | control bar (Run, Previous, Play/Pause,
Next, Reset, scrubber, step counter, speed 0.5–8×), current-line highlight, change flash, empty / loading /
compile-error / crash / stale / backend-down states, keyboard shortcuts, stacked layout under 900 px. Design
rationale: `docs/DESIGN.md`. Production bundle: **652 kB, 211 kB gzipped** (app-page budget 300 kB).

Tests: 36 frontend unit tests (trace decoder, playback reducer, status mapping, normaliser) + 14 browser checks driving real
Chrome against the real backend and runner, 3 consecutive green runs; backend unit suite 56, integration 30.

What the visual pass found (none of it was caught by any assertion until it was seen):

1. **Garbage argument values at function entry (FACT; correctness bug, since Phase 2).** The innermost
   `factorial()` frame showed `n = 30849`: the snapshot was taken on the function's first instruction, before the
   prologue stored the argument. Fixed in the tracer (D-021) with a RED→GREEN integration test (`1819242352, 31691`
   → only legal values). The trace also got shorter (29 → 23 steps for the sample).
2. **Misleading status chip and a stuttering banner** (green "traced" on a failed compile; "Compilation failed —
   Compilation failed"). D-022.
3. **CORS rejected `127.0.0.1:5173`** — the first browser run never got a trace; the page said "Cannot reach the
   backend". D-023.
4. A test expectation of mine was wrong (`1!+2!+3!` printed 9, I asserted 10); the app was right.

Not measured: render time for a 5,000-step trace in the browser; behaviour in Firefox/Safari; real screen readers
(only ARIA roles/labels were checked structurally); the light theme does not exist yet.

Still unmeasured / open after Phase 2: trace size per 1k steps; steps/s with deep stacks; memory-bomb and
fork-bomb behaviour on a Linux host (only Docker Desktop/WSL2 tested); `std::sort` comparators and other callbacks
from library code are not stepped into; stdout buffering (`'\n'` vs `endl`) not tested; container start cost with
many concurrent runs.

## Open Problems

1. **Heap block typing** — `malloc` blocks are untyped; infer from the pointer type. `new`/`new[]`, allocators complicate it.
2. **STL printer stability** — depends on GCC/libstdc++ version; GCC 15 map/set issue reported; pin versions; fall back to `unavailable`.
3. **In-process GDB step speed on Linux** — unmeasured; defines the default step budget.
4. **Loop/step compression design.**
5. **Uninitialised variables** — garbage vs value is indistinguishable; UI policy needed.
6. **`std::cin` input** — non-interactive; stdin supplied up front via a UI field. Interactive input is Future.
7. **Optimised code (`-O2`)** — unsupported by design; say so in the UI.
8. **Threads** — unsupported in MVP; detect and report.
9. **Smart pointers, `std::function`, lambdas, exceptions, virtual dispatch** — printer coverage varies.
10. **Dev environment** — Docker Desktop is installed but currently stopped; the only WSL distro is `docker-desktop`.
    Local MinGW GCC 6.3 / GDB 7.6.1 has **no Python** ("Python scripting is not supported in this copy of GDB"),
    so the tracer cannot be developed against the local toolchain. Docker must run.
11. **Licensing** — invoking GDB as a separate process looks fine (INFERENCE, not legal advice); copying Valgrind-fork code would bring GPL.
12. **Public hosting model/cost** — where isolated runners live (gVisor / Firecracker). Decide late.
13. **C++ standard/toolchain** — pin one GCC and `-std`; user choice is Future.
14. **Judge0 public instance** — third-party uptime/limits for the plain-run path.
15. **Heavy claims not verified from primary sources**: Valgrind internals and DWARF details come from
    secondary sources and the opt-cpp-backend materials; Valgrind manual and DWARF spec were not read.

## Recommended Direction

1. **Own Linux runner container** (modern g++, gdb with Python, libstdc++ printers), invoked by Node via Docker, strict limits, no network.
2. **Tracer = Python script inside GDB** (`gdb -nx -batch -x tracer.py`), stepping by source line with a step
   budget, writing a delta-encoded JSON trace. Node reads it, validates against a schema, post-processes
   (shape detection, compression), and returns it.
3. **Frontend renders from the trace only**; AI is a separate, optional, grounded layer.
4. **Judge0 demoted** to optional plain-run; not used for tracing.
5. **Vertical slice first**: hello world → ints + loop → real trace → real frontend scrubber. Then arrays,
   pointers/heap, linked list, trees, STL.
6. **Hard gate — Phase 1 spike before any product code**: build the runner image, run a ~20-line tracer on a
   loop, measure steps/s, prove ptrace-in-container and STL printers work. If it fails, the architecture is
   wrong and we revisit Valgrind-based tracing *before* building on it.

## Sources

- Judge0: https://ce.judge0.com/ ; changelog https://github.com/judge0/judge0/blob/master/CHANGELOG.md
- Judge0 self-hosting reports: https://github.com/KN-Sfera/sfera-contester , https://station.railway.com/questions/judge0-deployment-failing-with-cgroup-an-c536e4d6
- GDB MI variable objects: https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Variable-Objects.html
- GDB Python events: https://sourceware.org/gdb/current/onlinedocs/gdb.html/Events-In-Python.html
- GDB STL: https://sourceware.org/gdb/wiki/STLSupport ; https://github.com/microsoft/vscode-cpptools/issues/3024 ; https://github.com/AlDanial/tdb/pull/68
- Python Tutor backend: https://github.com/JuezUN/opt-cpp-backend (fork of pgbovine's) ; https://glacier.andrew.cmu.edu/coding-vs-WE/pathrise-python-tutor-master/v4-cokapi/backends/c_cpp/vg_to_opt_trace.py ; http://blog.ieeesoftware.org/2019/02/python-tutor.html
- cpp-tutor https://github.com/jmanoj0905/cpp-tutor ; See++ https://github.com/knazir/SeePlusPlus ; GDB-based https://github.com/Apepsis/SeePlusPlus ; OPT_CPP https://github.com/dive4dec/OPT_CPP
- Sandboxes: https://northflank.com/blog/firecracker-vs-gvisor , https://www.pandastack.ai/blog/firecracker-vs-nsjail/
- Our measurements: `ce.judge0.com` probes (config_info, tool presence, ptrace) and local MI step benchmark, 2026-10-03.

### Phase 3 review (react-reviewer subagent, findings verified before fixing)

No XSS or unsafe rendering found (all program text is a React text node; no `dangerouslySetInnerHTML`; no
program-derived `href`/`src`). Real findings and fixes:

| Finding | Verification | Fix |
|---|---|---|
| **`stdoutLen` is bytes, the UI sliced UTF-16 units** (non-ASCII output cut in the wrong place) | RED unit test: `héllo→x` cut at the wrong character | `stdoutAt` cuts on UTF-8 bytes and drops a half character |
| Ctrl+Enter in the editor ran twice (CodeMirror binding *and* the window listener) | Read the code; browser test now counts POSTs (exactly 1) | window handler returns on `event.defaultPrevented` |
| Alt+Arrow stepped while moving the caret (macOS binds it to word movement) | Read the code; same `defaultPrevented` guard | one guard fixes both |
| Space on the stdin `<summary>` toggled playback instead of opening it | Browser check: details opens, playback stays off | exclusion widened to `button, summary, a, [role=button]`; key repeat ignored |
| `aria-live` on the step readout would announce every step at 8× | Read the code | removed (scrubber has `aria-valuetext`) |
| A malformed trace would blank the page (no defaults, no error boundary) | Unit tests with wrongly typed fields | `normalizeTrace` in `api.js` + a `VisualizationBoundary` |
| A superseded request could dispatch a stale failure | Read the code | abort checks before every dispatch; run guard set synchronously |
| `errorLines` re-created every render; empty `ok` trace rendered a blank pane; unnamed `<pre>` regions | Read the code | `useMemo`; notice banner; `aria-label`s, `pre[tabindex]` treated as a typing target |
| `entry.kind` interpolated into `className` | Not exploitable: the backend already restricts `kind` to a fixed set | no change (documented) |

## Phase 4 Results (measured 2026-10-07: recursion, return values, stdout timing)

Phase 3 had already built frame cards, change flash and the stdout panel, so Phase 4 was "look at real traces of
recursion, calls and output and fix what is wrong". Every row below was found by reading a real trace or screenshot,
none by an existing assertion.

| # | Defect | Evidence | Fix |
|---|---|---|---|
| 1 | **Recursive returns invisible.** The tracer decided "new step" from `(line, function name)`; every `fact()` level ends on the same `}` line | FACT: `depth jumped 5 -> 1: 1,2,2,3,3,4,4,5,5,1,1,1` | D-024: frame identity is part of the step identity |
| 2 | **Trace silently ends early on one-line functions.** No line boundary exists after the callee returns, so one advance ran the rest of the program | FACT: `int fact(int n){...}` on one line gave `status ok`, 4 steps, `stdout "6\n"` (program finished, trace did not) | D-025: a return that lands in user code is a step |
| 3 | **No return values** (TEST_PLAN #5 was 🟨) | FACT: only `r = 24` at the very end | D-025: `returned` on the next step; rax/xmm0 per type, none for void/struct/ref/main |
| 4 | **Output invisible until exit with `"\n"`** | FACT: `stdoutLen` per step `0,0,0,0,0,0,0,0,0` (the Phase 2 doc said INFERENCE; now measured) | D-026: `LD_PRELOAD` unbuffered stdout; same program `0,0,7,7,14,14,21,21,21` |

Measured limits that remain: with `std::ios::sync_with_stdio(false)` `stdoutLen` stays 0 until exit (probe: `[0,0,0,0,0,0,0,0,0,0]`);
a one-line `main` is a single step; struct/container return values are not read.

Tests (all RED first): integration `recursion unwinds one frame at a time`, `recursion written on one source line…`
(RED `trace ended before unwinding: 1,2,3,4`), `each call's return value…`, per-type values (`returns.cpp`:
`2.5`, `true`, `65 'A'`, void none), `stdout grows as the program prints` (RED `0,0,0,…`); backend unit tests for forged
`returned` values; frontend `reconstruct` test; two new browser checks. Totals: backend 58 unit + 36 integration,
frontend 37 unit + 16 browser checks, 3 suites green on the final code. Integration wall time 65-68 s after the
changes (CLAUDE.md recorded ~90 s earlier; I did not re-measure the old tracer, so no speed claim). Not measured:
steps/s with the extra register reads, trace size, and how much faster call-heavy programs reach the 5,000-step cap
(INFERENCE: roughly one extra step per call).

### Phase 4 reviews (security-reviewer and code-reviewer subagents; both read the code only and ran nothing)

No CRITICAL or HIGH findings from either. What was real, and what changed:

| Finding | Verification | Fix |
|---|---|---|
| MEDIUM (both reviewers): a return value could be attached to an unrelated step if the function returned into library code (comparator, libc) | Reasoning from the code; not reproduced (callbacks are not stepped into today) | the value is read only when the landing is user code |
| MEDIUM: type/ABI claims untested beyond double/bool/char/void; a wrong `float` lane would pass CI | Agreed | `returns_types.cpp`: float, negative int, 64-bit, unsigned char, `enum class`, pointer (equals `main`'s own `p`), struct/reference/throw report none. **Mutation check:** forcing the `v2_double` lane turned the test RED (`5.28e-315` instead of `1.5`), then reverted |
| LOW: `.returned-fn` could overflow the card with a very long name | Read the CSS | `min-width: 0; overflow-wrap: anywhere` |
| LOW: stale `tracer.py` header and docs; `sync_with_stdio(false)` not mentioned | Agreed | header, ARCHITECTURE, D-026 updated |
| LOW (pre-existing, not changed): `sanitizeStep` does not require `n` unique/increasing or `stdoutLen` monotonic | Reviewer reasoning; depends on whether the program can write the trace channel (D-016 says it cannot) | recorded for the Phase 12 hardening pass |

Mistakes of mine in this phase (kept so they are not repeated): a browser check wrote `main` on one line and then
"found" that output does not grow (a one-line main is one step; the test input was wrong, not the app); a probe built
from nested shell/JS escaping returned `compile_error` (the known "use files, not nested escaping" rule, again);
Vite on this machine listens on `localhost` (IPv6), so `127.0.0.1:5173` is refused: set `APP_URL=http://localhost:5173/`
for `npm run e2e`.
