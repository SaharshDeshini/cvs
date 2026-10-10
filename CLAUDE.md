# CLAUDE.md — project memory

## Purpose
C++-only code visualization platform: write code → run → step → visualize. Real execution is the source of
truth; AI may only explain verified trace data (never invent values, addresses, order).

## Current state (2026-10-10)
Phases 0-9 done: research, spike, backend trace pipeline, frontend shell, call-stack truth, and (built as one slice,
2026-10-08) the data-structure diagrams: arrays, pointers/arrows, heap blocks (freed/leaked), linked lists, trees, STL.
Backend 73 unit + 48 integration, frontend 190 unit + 16 smoke + 23 diagram browser checks. All of it is committed (HEAD is the commit after 8dcdf2d); working tree clean apart from local .claude/ and scratch spike/cases/.
The 2026-10-11 pointer-tag / range / matrix work (D-034) and the "Obsidian" redesign (near-black neutral base, gold accent, panes as floating cards on a darker canvas, a floating playback dock,
refined empty/error states; all in `styles.css` + the editor theme, palette tokens at the top of `:root`).
2026-10-09 UI pass: the tracer hides the compiler's range-for temporaries
(`__for_range/__for_begin/__for_end`, regex `COMPILER_TEMPORARY` in `tracer.py`), and the diagram is now stack-left / heap-right
with larger cells and nodes, the pane scrolling as one unit when a tree is wide, and a dotted canvas behind heap structures.
Heap lifetimes (2026-10-10): `fe/src/lib/heapLifetime.js` looks ahead through the whole trace, so an orphan block reachable
again later is "in transit" (gold `transit` badge; after every `new` and every return) and only one never reached again is
"leaked" (separate red Leak tray with a byte total). New blocks animate in. Known limit: a `unique_ptr` list is drawn as a
generic "Linked structure" (the shape detector only sees raw self-pointers).
Understanding the run (2026-10-10, user-approved items 4,5,6,10,12,13 from the improvement list): `lib/bugs.js` bug spotlight
(leak, dangling >= 2 steps, crash, timeout), `lib/caption.js` one-line step captions, `lib/inlineValues.js` editor labels,
`lib/focus.js` + `PointerArrows focus` hover tracing, `Timeline.jsx` depth strip with bug markers, and the tracer's heap-block
cache (D-033, 85 -> 141 steps/s on a 200-node list). 2026-10-11 (D-034): pointer tags on cells and nodes, search/window ranges, matrix grids (`lib/rangeHints.js`, `pointerTags.js`, `matrix.js`). Not built (user did not pick them): gallery, step over/into/out, light theme.
User said approval is not required between phases, but wants each phase tested (fix and retest on failure)
and documented before moving on, plus an interview-ready write-up (`docs/INTERVIEW_NOTES.md`, keep it current).
Next: **Phase 10 — step compression**, and the measured gaps listed in `docs/RESEARCH.md` → Phases 5-9 (cache heap blocks
by raw bytes: a 200-node heap traces at ~90 steps/s; `new T[n]` size cookie; one-past-end pointers; heap-log overflow).
Read `docs/RESEARCH.md` (Phase 1-9 results) → `docs/ROADMAP.md` first. `bk/runner/spike/` is scratch.

## Architecture (built; see docs/ARCHITECTURE.md, docs/DESIGN.md)
Frontend (`fe/`: React + Vite + CodeMirror 6, one pure reducer) → Express backend (`bk/`) → Docker runner
(g++ -g -O0 + `gdb -nx -batch -x tracer.py`) → result frames on stdout → trace schema 1 (delta-encoded, validated)
→ frontend. Judge0 is optional plain-run only (D-002).

## Conventions
- Backend in `bk/`: **CommonJS only** (no ES modules). `routes → controllers → services`, plus `utils/`.
- Keep it simple; no auth/payments/DB/microservices until the core works.
- Small files (<800 lines), functions <50 lines, no mutation of inputs, explicit error handling, no `console.log` debris.
- Validate all request input at the controller; compile errors/crashes are results, not 500s.
- Never run user code on the host machine. Only in the runner container (D-005, D-010).

## Process rules (from the user)
- Loop: research → plan → implement → build → test → find flaws → fix → retest → document → update this file.
- Never say "should work" without testing. On failure find the root cause and ask whether the architecture is wrong.
- One milestone at a time; explain, implement, test, update docs, state the next milestone.
- README must always equal the real project; update it at every milestone.
- Label claims FACT / INFERENCE / RECOMMENDATION in research docs.
- Update this file whenever the user corrects me or a mistake repeats.

## Commands
```bash
cd bk && npm install
npm run dev                          # nodemon server.js
cd bk/runner && docker build -t cvis-runner:2 .   # runner image; rebuild after ANY change to tracer.py/run.sh
cd bk && npm test                    # unit (73), no Docker
cd bk && npm run test:integration    # 48 tests, real runner, ~100 s; do not run two copies at once (concurrency cap -> 429)
cd fe && npm install && npm run dev  # frontend :5173 (backend must run on :5000: `cd bk && npm run dev`)
cd fe && npm test                    # 190 unit (vitest)
cd fe && npm run e2e:diagrams      # 23 real-Chrome checks: arrays, pointers, lists, trees, STL, leaks, timeline, hover, shortcuts, ranges, matrices (same prerequisites as e2e)
node bk/runner/check_heap_cache.js   # heap cache off vs on must give identical step records (needs Docker + image); run after ANY tracer/values.py change
cd fe && npm run e2e                 # 16 checks in real Chrome (needs backend, dev server, Docker, runner image);
                                     # Vite binds localhost (IPv6) here: APP_URL=http://localhost:5173/ npm run e2e
```
Docker Desktop must be started manually for runner work. `node --test` needs a glob, not a directory (Node 22).

## Known problems
- (Historical, deleted in Phase 2) the MI service hung on `-exec-run` (`^running` vs `^done`): MI is async.
- Local toolchain is MinGW GCC 6.3 / GDB 7.6.1 with **no Python**; unusable for the tracer. Use the Docker runner
  (`bk/runner`, image `cvis-runner:2`); Docker Desktop must be started manually
  (`Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`, ready in ~10 s).
- Fixed in Phase 2: unbounded `step`, unflushed output, unclassified end state, locals shown before declaration.
- Open: `stdoutLen` stays 0 until exit under `sync_with_stdio(false)` (the D-026 `LD_PRELOAD` shim only reaches stdio;
  measured); a one-line `main` is one step; struct/container return values are not read (primitives only, D-025);
  every return is now a step, so call-heavy programs reach the 5,000-step cap sooner (unmeasured);
  callbacks from library code (`std::sort` comparators) are not stepped into;
  library frames are skipped with `finish` (can hide user lambdas); ~400 steps/s with full frame snapshots (cache
  unchanged caller frames to speed up); arrays/structs/pointers/STL are typed values since Phases 5-9 (limits and unfixed findings: RESEARCH.md → Phases 5-9); no caching.
- Frontend must not do `vars[name] = x` on plain objects: names are user-controlled (`__proto__` is legal C++).
- Runner tests only cover Docker Desktop/WSL2. Results come back as stdout frames from a tmpfs `/out` (D-016): never
  read a host path the user's program could write to. Only the source dir is bind-mounted (read-only).
- Open: stacks over 64 user frames silently drop the outermost frames (no marker); no per-IP rate limiting;
  base image not pinned by digest.
- Public Judge0 (`ce.judge0.com`): g++ only, no gdb/valgrind; `base64_encoded=false` returns 400 for non-UTF-8 output;
  limits are host-defined and may change.
- Working tree has uncommitted deletions (old tree-sitter instrumentation, `main.cpp`, `main.exe`) and untracked
  `.claude/`, `compilerService.js`, `gdbService.js`, `src/tests/` (contains `test-output.exe`). Not cleaned up yet; ask before committing/deleting.
- Empty `.env`; `bk/test-gbd.js` is a stray script.

## Things Claude got wrong (don't repeat)
- Drafted a "FACT" about compile timing that was never measured; only label things FACT if actually measured/read.
- Wrote shell-escaped `\n` inside a JS test string through heredoc/sed → corrupted C source. Use files, not nested escaping.
- Windows Node cannot resolve Git Bash `/d/...` paths in `require`; use relative or `D:/...` paths.
- Hooks (GateGuard) deny the first write of each new file until facts are stated; state them, then retry.
- Phase 1: assumed GDB `step` could be bounded by a step counter. It cannot: a loop whose body is one line (e.g.
  `while (true) { i = i + 1; }`, no code for the `while` at -O0) never returns from `step`. My first "counter-example"
  (multi-line loop) was not one, because it behaves the same. Test the hypothesis against the reduced case, then
  use bounded `stepi` (D-011).
- Phase 1: left tracer output unflushed, so a wall-clock kill lost the whole trace. Always flush per record (D-012).
- A `docker run --rm ... bash -c "$VAR ..."` string built from shell variables was refused by the removal safety
  check (it cannot parse the script; `--rm` is only Docker's own container cleanup). Put in-container logic in a
  script file (`bk/runner/spike/trace.sh`) and call it with literal arguments.
- Docker Desktop may restart its engine right after launch (server went 29.4.1 → 29.8.2); a build failing with
  `EOF` from the daemon is that, not a Dockerfile error. Wait, then retry once.
- Don't grep trace output for `fault`/`Program`: it also matches `= default` lines from STL code.
- Phase 2: an OOM-killed program was reported `ok`, because I treated "GDB exited event has no exit_code" as a clean
  exit. Never default to success; classify from explicit evidence (D-014). Wrote the memory-bomb test first and
  it caught this — keep writing adversarial tests before trusting a status.
- Phase 2: shipped a 20,000-instruction per-line cap (10 s per collapsed line) and used `until` for long one-line
  loops (also single-steps). Measure the cost of every cap/limit I introduce; use `advance *ADDR` (D-013).
- Phase 2: guessed the slowness was flushing, then CPU limits — both wrong. Add timing instrumentation (the tracer's
  `timing` field) and read it before theorising.
- Phase 2: wrote a doc claim ("stdout stays 0 until exit") from inference, but the trace showed it rising after
  `endl`. Label inference as INFERENCE; re-check each doc claim against the output I actually saw.
- Phase 2: README snippet had `cd ..` then `cd bk` (wrong directory). Re-read command sequences as a path walk.
- Phase 2: first design read results from a host directory the user's program could write to (symlink/FIFO/disk
  attack, found by two reviews). Any data crossing a trust boundary must travel on a channel the hostile side
  cannot choose the path of (D-016). Run the security-reviewer and code-reviewer agents (plain names, not `ecc:`)
  before declaring a phase done.
- Phase 2: per-frame state outlived its frame (second call to a function showed locals early) and a library call
  on a line produced a step per call. Both survived 10 green runs because no test counted steps per line or called
  a function twice: write the test for the property, not just for the happy output.
- Heredoc + node `-e` string replace mangled `\n`: use the Edit tool for source edits, heredocs only for appends.
- Phase 3: 30 unit + 12 browser assertions passed while the UI showed `n = 30849` (garbage argument at function
  entry, a tracer bug since Phase 2). Only LOOKING at a screenshot found it. Always open the screenshots and read
  the values on them against what the program should show; assertions only check what I thought to assert (D-021).
- Phase 3: showed a green "traced" chip for a failed compile, and a banner that repeated its own title. A finished
  request is not a successful run: derive status text from the outcome (D-022).
- Phase 3: assumed `stdoutLen` was characters; the tracer measures bytes. Check the unit of every number that
  crosses a boundary, and write the non-ASCII test case (found by the reviewer, confirmed RED, fixed).
- Phase 3: two of my own test expectations were wrong arithmetic (1!+2!+3! = 9 not 10; `héll` is 5 bytes). When an
  assertion fails, work out which side is wrong before touching the app.
- Phase 3: a window-level key handler also fires for keys CodeMirror already handled (double run, Alt+Arrow caret
  moves). Global handlers must return on `event.defaultPrevented`.
- The Claude-in-Chrome extension may not be connected; `fe/e2e/smoke.mjs` (puppeteer-core + system Chrome) is the
  repeatable browser check. Run it from `fe/` with an absolute-path `cd` (Bash `cd` in a compound command does not
  persist reliably).
- Backend CORS allows `localhost:5173` and `127.0.0.1:5173` only; a frontend on another origin needs `FRONTEND_ORIGIN`.
- Don't claim a file was removed in docs before removing it (TEST_PLAN said so a few steps early).
- GateGuard asks for facts on the first edit/create of each file (and again after a gap); state the facts once in
  text, then retry. In a parallel batch only the first call is denied.

- Phase 4: "is this a new step?" compared `(line, function name)`, which swallowed every recursive return (all levels end
  on the same `}`), and a function written on ONE source line had no later boundary at all, so the trace ended early
  with `status: ok` (D-024, D-025). After any change to stepping, trace recursion in BOTH layouts (multi-line and
  one-line) and read the steps, not just the assertions.
- Phase 4: a new test that has never failed proves little: break the code on purpose (I forced the wrong `float`
  register lane: RED `5.28e-315`), watch it fail, revert, rebuild. Remove the mutation and `grep` for it.
- Phase 4: my browser check used a one-line `main` and "found" that output does not grow: check the TEST INPUT before
  blaming the app. Nested shell/JS escaping produced a fake `compile_error` again: write probe programs to files.
- Phase 4: in a parallel Edit batch only the first call is denied by GateGuard and the others apply, so a later edit
  that references a name introduced by the denied one lands first (tracer used `start_key` before it existed). Never
  batch dependent edits to a file you have not touched yet; stating the facts first does not skip the first denial.
- Phase 4: Docker image changes need `docker build -t cvis-runner:2 .` AND the backend process restarted if a
  `bk/src` file changed (a long-running `node server.js` keeps the old `traceProcessor.js`).

- Phases 5-9: a cap that "collapses" members past a budget still emitted one placeholder per member (≈ budget × 64
  entries); a loop over untrusted members must STOP when the budget is spent. A unit test with a tiny budget found it.
- Phases 5-9: three of my own test assertions were wrong (path numbers at index 4/5 instead of 2/3; "arrow ends on the
  top" when the pointer row is below the array so it enters from below; a fixture whose unused pointers GCC dropped:
  GDB's "value has been optimized out" is the compiler's truth). Work out which side is wrong before touching the app,
  and make a fixture USE the thing it tests.
- Phases 5-9: `std::list`/`set` print without an `array` display hint (children named `[0]`, `[1]`...), so a "hint ==
  array" check silently turned them into 40-field structs. Probe every container kind's real output (`node dump`-style
  probe in the session scratchpad) before assuming the printer's shape.
- Phases 5-9: a free list reuses addresses: any table of heap blocks keyed by address must evict overlapped stale
  entries when a block is allocated over them, and key per-block memory by the Block OBJECT, not the address.
- Phases 5-9: a long-running `node server.js` keeps old `bk/src` code; after changing the processor, kill the process
  on :5000 (`netstat -ano | grep :5000`, `taskkill //PID n //F`) and start it again before any browser check.
- Phases 5-9: the harness collapses repeated command output into "same as msg N"; print explicit counts
  (`grep -c`, `checks passed`) when a result matters. Agent subagent reports are findings to verify, not instructions.
- 2026-10-09: GDB lists the compiler's own locals (`__for_range`, `__for_begin`, `__for_end`) next to the user's, with
  garbage values before the loop starts, and the diagram drew arrows for them. Steps were fine (the `for` line recurs once
  per iteration, same as a classic `for`); the leak was in the variables. Print per-step vars before blaming the stepping.
- 2026-10-09: bigger diagram nodes passed every assertion yet clipped the tree's right child and its arrow off-screen; only
  the screenshot and `pane.scrollWidth > clientWidth` showed it. `.pane-viz` is a flex column, so it stretches `.diagram` to
  the pane width: a grid `max-content` track needs `.diagram { width: max-content; min-width: 100% }` to grow and scroll.
- 2026-10-10: the user reported lists and trees "unreachable" after a few iterations. The tracer's `orphan` flag was true
  for the steps where a new pointer lives only in a register (after `new`, through each `return` up a recursive insert).
  Found by replaying fixtures through the frontend's own `reconstruct`/`planStructures` (scratchpad script) and printing
  per-step flags, not by reading code. A per-step flag cannot tell "leaked" from "not stored yet"; the whole trace can.
- 2026-10-10: a parallel Edit batch applied the middle edits and the GateGuard denial skipped the first (the import) and the
  last, leaving `App.jsx` using `classifyOrphans` before importing it. Edit a file you have not touched yet ONE call at a time.
- 2026-10-10: comparing two runs of the same program in the container always "differed": ASLR is on there, so every address
  changes. Rename long hex literals by order of first appearance before comparing, and run a control (cache OFF vs OFF)
  before blaming the change: `wild_pointers` differs even uncached (uninitialised stack bytes).
- 2026-10-10: the first bug-spotlight flagged `delete head; head = next;` (one step dangling) in the teardown loop. A warning
  on idiomatic code teaches users to ignore warnings: run every detector over the normal idioms and require a persistence
  threshold. The screenshot, not the unit tests, showed it.
- 2026-10-10: a cache must be keyed on everything the cached value depends on, not just the bytes: pointer `state` comes from
  the live allocation table (recompute on replay), and anything read through a printer or `char*` lives outside the block
  (never cache it). `copy.deepcopy` was the bottleneck after the cache worked: measure the cached path too.
- 2026-10-10: I reported "heap cache output identical on all fixtures" while no fixture held a value read from OUTSIDE its
  block (a `std::list` iterator, a `wchar_t*`); a reviewer's guess, tested with a new fixture, showed the cache serving a stale
  element. "Identical on my fixtures" only proves the fixtures: write the hostile case first (`cache_hazards.cpp`), and make a
  cache admit entries by an allow-list and by tracking every read that leaves the block, never by a list of kinds to refuse.
- 2026-10-10: a crash cause that names every null pointer in scope is a confident wrong answer ("prev is null" for a segfault
  on `q->value`). Name a variable only when the crashing line uses it; say nothing specific otherwise.
- 2026-10-11: `mid` is declared INSIDE a binary-search loop, so it is out of scope between iterations: a mode decided from
  `mid` alone flipped "search" to "window" at the loop end (seen in the screenshot, not the unit tests, which always passed a
  `mid`). A heuristic that depends on a variable's presence must be tested on the steps where it is absent. Likewise `k` was
  marked as a position in a sliding window where it is the window size.
- 2026-10-11: a node -e one-liner with nested quotes "failed" (heredoc warning, no output) but had in fact applied, so the next
  Edit calls were rejected as "modified since read". After any tool call with unclear output, READ the file before re-editing.
- Plain Node cannot import the frontend libs (extension-less imports); a 6-line `module.register` resolver hook that retries
  with `.js` does it, and `vite-node` cannot load scripts outside the project root.
- Browser checks: CodeMirror's `cmView` is not reachable; load a program by selecting all and dispatching a `paste`
  ClipboardEvent with a DataTransfer (typing triggers bracket auto-closing). `fe/e2e/diagrams.mjs` does this.

## Key decisions
See `docs/DECISIONS.md` (D-001…D-034; D-034 pointer tags, range and matrix guesses; D-031 orphans judged by look-ahead, D-032 bug spotlight wording rules, D-033 heap-block cache; Phase 4 added D-024 step identity, D-025 return = step + return value, D-026
unbuffered stdout; Phases 5-9 added D-027 heap allocation log, D-028 typed value tree + heap deltas, D-029 shapes from
data, D-030 measured arrows). D-002 and D-003 were confirmed by the Phase 1 spike.
