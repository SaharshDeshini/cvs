# Interview Notes — C++ Code Visualization Platform (CVis)

Kept current at the end of every phase. Last updated: 2026-10-07, after **Phase 4**. Numbers marked **measured**
were produced by running code in this repo (raw tables: `docs/RESEARCH.md`).

## 1. The 30-second pitch

A web tool where you write C++, run it, and step through what the program *actually did* — variables, call stack,
later arrays/pointers/heap — like Python Tutor, but for C++. The design rule: **every value shown comes from real
execution (a debugger), never from an AI guess.** AI may only explain data that was captured.

## 2. Honest status (say this first, it builds trust)

| Done | Not done yet |
|---|---|
| Research + 8 docs (research, requirements, architecture, decisions, roadmap, test plan, development, this file) | Light theme, real screen-reader test, WCAG contrast measurement |
| **Phase 4: call-stack truth** — recursion unwinds frame by frame, return values shown, output fills in live; 37 unit + 16 real-Chrome checks | Struct/container return values, stdout live under `sync_with_stdio(false)` (measured: shows at exit), a one-line `main` is one step |
| **Phase 3: frontend** — editor, stack + output, control bar, shortcuts, 7 designed states; 36 unit + 14 real-Chrome checks | Phase 4+: structured arrays/structs/pointers/lists/trees/STL, AI explanations |
| Phase 1 spike: GDB-in-Docker tracing proven, measured, GO | Arrays, structs, pointer graphs, linked lists, trees, STL as *structured* values (today: raw printer text) |
| **Phase 2: `POST /api/trace`** — compile, trace line-by-line in a hardened container, validate, delta-encode | AI explanations, caching, deployment, public-safe sandbox |
| 55 unit + 29 integration tests (adversarial: OOM/fork/disk bombs, forged result files, deep recursion); full suite re-run green 5× in a row after the security redesign | stepping into library callbacks, faster tracing, rate limiting, >64-frame marker |
| Two independent AI code/security reviews, every finding verified before fixing | |
| 23 logged decisions (D-001…D-023); three independent AI reviews (security, code, React), every finding verified first | |

It is an early-stage project with a validated, tested core pipeline — not a finished product.

## 3. Architecture (as built)

```
Browser (later) ──POST {code, stdin}──▶ Express  (routes → controllers → services, CommonJS)
   validateRequest (size/type/NUL) ─▶ runnerService ─▶ docker run (no shell, fixed args)
        container: --network none, --cap-drop ALL, no-new-privileges, 512 MB, 64 pids, 1 CPU, non-root,
                   source read-only, /tmp tmpfs, file-size ulimit
          run.sh: g++ -std=c++17 -g -O0  ──▶  gdb -nx -batch -x tracer.py  (Python inside GDB)
          tracer: bounded stepi per source line → JSONL (line, call stack, typed variables), flushed per record
        wall-clock kill (docker kill) is only the backstop
   traceProcessor: treat tracer output as UNTRUSTED → validate → status → delta-encode (keyframes) → JSON v1
```

Why: `-O0 -g` gives exact lines/variables; GDB reads DWARF so types are exact; the Python API runs in-process
(13× faster than GDB/MI measured); libstdc++ printers already know STL; Judge0 stays only as an optional plain run.

## 4. Key decisions and the reasoning (be ready to defend each)

| ID | Decision | Why | Rejected |
|---|---|---|---|
| D-001 | C++ only | Scope; GDB+DWARF is language-specific | Multi-language |
| D-002 | Own runner container, not Judge0, for tracing | Public Judge0 has g++ but no gdb (probed); one-shot; self-hosting needs cgroup v1 + privileged Docker | Trace via Judge0 |
| D-003 | Tracer = Python inside GDB | MI measured 155 steps/s and needs a parser; in-process far faster | MI from Node; Valgrind (fallback) |
| D-004 | No source instrumentation | Earlier tree-sitter attempt only handled primitives; templates/macros break rewriting | Clang LibTooling |
| D-006 | AI only explains verified data | Trust | AI simulating execution |
| D-007 | Delta-encoded trace, keyframes, step budget | Million-step loops | Full snapshot per step |
| D-010 | Local-only until security review | Arbitrary native code | — |
| D-011 | Bounded `stepi`, not `step` | `step` never returns on a one-line loop | `step` + wall clock |
| D-012 | Flush every record; end state from GDB events | Lost output on kill | Buffered / text parsing |
| D-013 | Collapse long one-line loops with `advance *ADDR`; interrupt only if endless | `until`/`stepi` ≈1–2k instr/s: a 3M-iteration loop looked infinite | Abort at cap; bigger cap |
| D-014 | Never default to success | OOM-killed program was reported `ok` | — |
| D-015 | Local visible only after its declaring line ran | Showed uninitialised garbage as truth | `line < current` only |
| D-016 | Results as stdout frames from an in-container tmpfs; host mounts only the source (read-only) | Symlink/FIFO/disk attacks via a host dir the program controlled (two reviews) | `O_NOFOLLOW` checks only; `docker cp` |
| D-017 | Generic client errors, detail in server log; grace-kill hung docker | Path leaks; a stuck docker held a slot forever | Pass `err.message` through |
| D-018 | Per-frame visibility state pruned to live frames | Second call to a function showed locals early (reproduced) | Keep state forever |
| D-019 | React + Vite + CodeMirror 6, JS, one pure reducer, no state library | One screen, one state machine; CM6 ~10x lighter than Monaco and themable; 211 kB gzipped | Monaco; TypeScript (deferred until schema freezes); Redux |
| D-020 | Browser tests = puppeteer-core + system Chrome | Repeatable visual pass; it found 3 real bugs | Playwright (downloads browsers); manual clicking |
| D-021 | Run to end of prologue before snapshotting a function | Garbage `n = 30849` at function entry, found by looking at a screenshot | Show header line with a "not stored yet" marker |
| D-022 | Status chip reflects the outcome | Green "traced" on a failed compile | Chip = request finished |
| D-023 | CORS allows localhost and 127.0.0.1 dev origins | First browser run blocked | `cors()` open to all (insecure) |

## 5. Problems encountered and how they were solved (the best interview material)

**Phase 1**
1. *Infinite loop could not be limited.* `step` never returns on `while(true){i=i+1;}` (no code for the `while` at
   -O0, so the body jumps to itself on one line). My first "counter-example" was wrong; I reduced it by driving
   GDB by hand. Fix: bounded `stepi` (D-011). Lesson: smallest reproducer before theorising.
2. *Lost output on kill* (buffered writes) → flush per record. 3. *Crash only reported as "no frame"* → GDB events.
4. *Dead/uninitialised variables printed as garbage.* 5. *Original MI service hung* (`^running` vs `^done`).

**Phase 2**
6. *A legit 3M-iteration one-line loop was reported as an infinite loop.* `until` still single-steps. Fix: run at
   full speed to the next line's address with a temporary breakpoint (`advance *ADDR`); the timer interrupt
   (`gdb.interrupt`) stays for genuinely endless lines → the tool now distinguishes *huge* from *infinite* (D-013).
7. *Every collapsed line cost 10 s.* The per-line cap (20,000 instr) was itself the latency; 1,000 → ~2 s.
8. *OOM-killed program shown as success* — caught by writing the memory-bomb test first. GDB's `exited` event
   has no exit code when the program dies from SIGKILL; I had treated "no code" as a clean exit (D-014).
9. *Variable shown before its declaration ran* (test #3). Fixed with per-frame completed-line tracking; frame
   identity = function + the caller's stack pointer (= callee CFA), distinct per recursion level (D-015).
10. *Slowness hunt:* I guessed flushing, then CPU limits — both **measured wrong** (no effect). Instrumented the
    tracer (`timing` field): snapshot 4.1 s + advance 5.0 s per 4k steps ⇒ ~400 steps/s with full frames.
    Lesson: instrument, don't guess.
11. *My own mistakes:* a unit test asserted `__proto__` is dropped, but it's a legal C++ identifier (kept safely as
    data on a null-prototype object — test fixed); a doc claim about stdout buffering contradicted the trace
    (corrected + labelled inference); a README command walked into the wrong directory; docs claimed files were
    deleted before they were. All caught on re-read and fixed.
**Phase 2 review round (the most interview-worthy story)**
12. *Both reviewers independently flagged my result channel as a design flaw.* The backend read result files from
    a bind-mounted directory the user's program could write to: it could replace a file with a symlink (host file
    read), plant a FIFO (hang the reader forever) or write thousands of files (fill the host disk — `ulimit fsize`
    caps one file, not the count). One root cause, so one redesign instead of three patches: `/out` became a
    size-limited tmpfs inside the container and results return as length-prefixed frames on stdout; the host now
    mounts only the read-only source (D-016). Lesson: data crossing a trust boundary must travel on a channel whose
    path the hostile side cannot choose.
13. *A reviewer finding that I reproduced before fixing:* a function called twice showed its local before its
    declaration on the second call — my own D-015 fix kept per-frame state after the frame died. Wrote the failing
    case (`twocalls.cpp`), saw the wrong variables at steps 6–7, fixed by pruning state to live frames (D-018).
14. *A bug no reviewer named, found by an unrelated test:* the big-stdout test hit the 5,000-step limit because every
    library call on a line (`cout << a << endl` = 3 calls) produced its own step — the tracer returned "new line"
    after `finish` without checking the line had changed. Added a RED assertion (one step per `cout` line), fixed,
    GREEN. It had survived 10 green runs because no test counted steps per line.
15. *Failure paths I had never exercised:* a hung `docker kill` could hold a concurrency slot forever (two = permanent
    429); error messages leaked temp paths; forged end-record fields were reflected to the client; CORS was open.
    Each now has a unit test using a mocked `child_process` (no Docker needed).
16. *Judgement calls:* per-IP rate limiting (new dependency, only matters when exposed), image digest pinning, and a
    >64-frame marker were deliberately deferred and documented rather than silently skipped.
17. *Tooling:* Node 22 `node --test <dir>` needs a glob; a safety check refused a dynamically built `bash -c`
    string (moved logic into a script file); Docker Desktop restarts its engine after launch (build `EOF` → retry).

**Phase 3 (frontend) — what looking at the product found**
18. *Passing tests, wrong product.* After 30 unit + 12 browser assertions were green, I opened the screenshots: the
    current `factorial()` frame showed `n = 30849`. The tracer snapshotted a function on its first instruction,
    before the prologue stored the argument, so GDB read stack garbage. This had been wrong since Phase 2 and no
    test noticed because no test asked "is every argument value legal?". Wrote that test first (RED:
    `1819242352, 31691`), fixed the tracer to run to the end of the prologue (D-021), GREEN. Lesson: assertions
    check what you thought of; screenshots check what you didn't.
19. *Green chip on a failed compile* and a banner reading "Compilation failed — Compilation failed" — also seen,
    not asserted. Status text is now derived from the outcome, unknown statuses show as failures (D-022).
20. *CORS blocked `127.0.0.1`* — the first browser run never got a trace; the same wall any developer following
    Vite's printed URL would hit. Allow-list now has both loopback spellings, still never `*` (D-023).
21. *Reviewer found a units bug:* `stdoutLen` is a byte count (the tracer reads a file size) but the UI sliced
    UTF-16 characters, so non-ASCII output would be cut wrongly. RED unit test, fix, and I then caught my own test
    arithmetic error (`héll` is 5 bytes, not `hél`) — worked out which side was wrong before touching code.
22. *Double run on Ctrl+Enter:* CodeMirror handled the key and the window listener handled it again. Browser test
    now counts POSTs (exactly 1); global handlers return on `event.defaultPrevented`, which also fixed Alt+Arrow
    moving the caret *and* stepping the trace.
23. *Environment:* the Claude-in-Chrome extension was not connected, so I built a repeatable `puppeteer-core` +
    system-Chrome script instead of clicking manually; it is now `npm run e2e`.
24. *A claim I walked back:* the design doc said text contrast was "≥ 7:1". I had never measured it. Corrected to
    "not verified" — an unverified accessibility claim is worse than none in an interview.

**Phase 4 (call stack truth) — what real traces found, again before any assertion did**
25. *Recursion never unwound.* I printed the trace of `fact(4)`: the stack depth went 5 → 1 in one step, so the three
    middle returns did not exist. Cause (**measured**): "is this a new step?" compared `(line, function name)`, and
    every recursion level ends on the same `}`. Failing test first (`depth jumped 5 -> 1`), then frame identity
    (function + CFA) became part of the step identity (D-024).
26. *A trace that stopped early while saying `ok`.* My own browser check wrote `fact` on one line. The trace had 4
    steps and `status: ok` — the program had finished (stdout `6`), the *trace* had not. With no later line
    boundary after the return, one advance ran the rest of the program. A probe script in the container plus the GDB
    log showed it. Fix: a return that lands in user code is a step (D-025). A silently truncated "ok" is the worst
    kind of wrong, and compact one-line recursion is exactly what people paste.
27. *Return values* (TEST_PLAN #5 was only partial): read from `rax`/`xmm0` per the System V ABI right after `ret`,
    only when `pc` is the caller's resume address *and* `sp` is back at the callee's CFA (an exception unwind must
    not look like a return; recursion reuses the same return address, so the `sp` test matters). Never guessed:
    void, struct, reference, `long double` and `main` report nothing.
28. *Tests that cannot fail are worthless, so I mutated one.* The reviewer pointed out that a wrong `float` register
    lane would pass CI. I added exact-value cases (float, negative int, 64-bit, `unsigned char`, `enum class`,
    pointer equal to `main`'s own variable; struct/reference/throw → none), then deliberately broke the lane: the
    test went RED with `5.28e-315` instead of `1.5`. Reverted, GREEN.
29. *Output only at exit with `"\n"`* (Phase 2 had labelled this INFERENCE; now **measured**: `0,0,0,0,0,0,0,0,0`).
    stdout is a file, so libc block-buffers it. An `LD_PRELOAD` constructor makes it unbuffered for the traced
    program only: `0,0,7,7,14,14,21,21,21`. Measured limit: `sync_with_stdio(false)` keeps its own buffer, so output
    still arrives at exit. Not hidden — documented in D-026.
30. *Mistakes of mine, same session:* a browser test of live output used a one-line `main` (one step by design — the
    input was wrong, not the app); a probe built from nested shell/JS escaping failed with `compile_error` (the rule
    "use files, not nested escaping" was already in my notes); Vite binds `localhost` (IPv6) so `127.0.0.1` was refused.
    Reviews (security + code, read-only): no CRITICAL/HIGH; the MEDIUMs were a stale-value path and the missing type tests.

## 6. Security (likely interview topic)

Design: user code never runs on the host; docker args are an array (no shell); the only host mount is the source,
read-only; results come back as length-prefixed frames on container stdout from an in-container tmpfs (nothing is
read from a host path the program can write — D-016); no network; read-only root filesystem; all capabilities
dropped; no-new-privileges; setuid bits stripped; memory/pids/CPU/open-files/file-size limits; core dumps off;
non-root; wall-clock kill with a grace period; instruction/step budgets; concurrency cap (429); request
size/type/NUL validation; 413/400/4xx JSON errors; CORS limited to the frontend origin; generic client errors,
technical detail only in the server log.
Verified by tests: OOM bomb is killed and reported as `runtime_error`; fork bomb and disk bomb are contained and
answered; a program that swaps result files for a symlink to `/etc/passwd` and a FIFO gets neither returned nor
hangs the host; a hung docker cannot hold a slot; `ptrace` works with every capability dropped and a read-only
root; no leftover containers after any test (asserted).
**Trust boundary people miss:** the trace file is written by a process that shares the container with the user's
program, so it is *untrusted data* — every record is validated, strings clipped, depth bounded, names restricted,
stored on null-prototype objects (a variable named `__proto__` is legal C++ and tested).
Not claimed: safety for public exposure. Containers share the host kernel → gVisor/microVM + review in Phase 12/13.
Untested: Linux host (only Docker Desktop/WSL2), disk-fill via `/out` beyond the 20 MB ulimit, `/proc` probing.

## 7. Performance numbers you can quote (measured)

- Compile `-g -O0`: 0.29 s (iostream), 1.30 s (`<bits/stdc++.h>`).
- Trace: ~400 steps/s with full call-stack snapshots (2,000/s when reading only top-frame locals in the spike).
- 3M-iteration one-line loop: ~2 s total, 6 steps + a `skipped` marker (not millions of steps).
- Infinite loop detected in ~5 s; integration suite (23 tests incl. bombs) ≈ 46 s, 10/10 consecutive passes.
- Step budget 5,000 ⇒ ~12 s tracing worst case; trace size per 1k steps **not yet measured**.

## 8. Likely questions and short answers

- **Why not ask an LLM to simulate the code?** It hallucinates values/order; the debugger is the source of truth.
- **Why GDB, not source instrumentation?** Rewriting breaks on templates/macros (tried, D-004); DWARF handles
  arbitrary C++ untouched.
- **How do you tell a huge loop from an infinite one?** Cap instructions per line, then run at full speed to the
  next line with a breakpoint; if it doesn't arrive within 3 s, interrupt and report the line.
- **How do you stop a million-step timeline?** Per-line collapsing + 5,000-step budget + delta encoding with
  keyframes; deeper compression is future work.
- **What was your hardest bug?** OOM reported as success — absence of evidence treated as success; fixed by
  explicit classification and an adversarial test.
- **How do you know it works?** 136 automated checks (backend 56 unit + 30 integration, frontend 36 unit + 14 real-Chrome) incl. adversarial ones; the integration
  suite ran 10× with zero flakes before review and the full suite 5× after the redesign. Failures changed the design
  five times (D-011, D-013, D-014, D-016, D-018). Also: green runs are not proof — two bugs survived 10 green runs
  because no test asserted that property, so I now write the failing test for the property first.
- **How did you use AI reviewers?** Two independent subagents (security, code) reviewed read-only; I treated their
  reports as claims to verify, reproduced one bug before fixing, rejected/deferred some (rate limiting, digest
  pinning) with written reasons, and the redesign they triggered is documented as D-016.
- **What would you do next?** Phase 5 (arrays: cells, index highlight, truncation), then pointers/heap, lists, trees, STL, then AI explanations over verified data.
- **How did you test the UI?** 37 vitest unit tests for the pure logic (decoder, reducer, status, normaliser) plus 16 real-Chrome checks (run, keyboard, scrub, play to end, stale code, compile error, crash, XSS probe, narrow viewport, backend down, exactly-one-POST, Space on summary, recursion unwinding with return values, live output); three consecutive green runs in Phase 3, one full green run after Phase 4. And I looked at the screenshots — that is what caught the garbage-argument bug.
- **Biggest remaining risk?** Reliably rendering pointer graphs from raw memory; tracing speed on big programs.

## 9. Things not to overclaim

Only primitives are structured (arrays/structs/STL arrive as raw text), and only primitive return values are shown.
Live output relies on stdio buffering we can control (`sync_with_stdio(false)` shows output at exit). Pointers are shown as
address + value, not arrows. One machine (Windows 11 + Docker Desktop). Library callbacks (e.g. `std::sort`
comparators) are not stepped into. Valgrind route researched, not prototyped. Public deployment unsafe by design
until the security phase.

## Phases 5-9: how the diagrams are made (one-minute version)
- **Problem:** GDB gives you values, not memory structure. To draw arrows you need to know what a pointer points *at*.
- **Approach:** read every value into a typed tree from the stopped program (arrays, structs, pointers, STL through
  GDB's own pretty-printers) and keep each box's address; an arrow exists only if a pointer's address lies inside a box
  we actually read. Nothing is inferred except loop-variable markers, which are labelled as name-based.
- **Heap:** GDB can't see allocation sizes or frees, so a tiny `LD_PRELOAD` shim logs `malloc`/`free`; the tracer
  replays the log. That gives `new int[5]` as 5 cells, freed blocks (dangling pointers), and leaks (a block you could
  see that nothing reaches any more).
- **Shapes from data, not names:** one self-pointer field = list, two = tree, two that are each other's inverse =
  doubly linked list. Reversing a list mid-way shows as two lists, which is exactly what it is.
- **Trust boundary:** the trace comes from the sandbox, so the backend re-validates every field and bounds the
  work. A test found my cap leaked (≈ 64× over budget); an independent security review found the heap table was
  unbounded; both fixed with tests that fail without the fix.
- **Honest limits:** 64-cell window, 150-block heap, ~90 steps/s with a large heap (cache by raw bytes is the next
  optimisation), no globals, guest can forge its own heap log (only its own diagram).
