# CVis — C++ Code Visualization Platform

Write C++ on the left, run it, and step through what the program actually did on the right: variables,
arrays, pointers, heap objects, calls. State comes from **real execution**, never from an AI guess.

## Status (2026-10-08): Phases 0-9 done — the data-structure diagrams (arrays, pointers & arrows, heap, linked lists, trees, STL) work in the browser; next: Phase 10 (step compression)

What exists and works today:

- **`POST /api/trace`**: compiles the C++ (`g++ -g -O0`) and traces it line by line with GDB's Python API inside a
  locked-down Docker container (no network, memory/pid/CPU limits, all capabilities dropped, non-root). Returns a
  validated, delta-encoded trace: per step the line, call stack and typed variables (scalars, arrays, structs,
  pointers/references, STL containers) plus the heap blocks they reach, what each primitive-typed call returned, plus
  stdout/stderr, exit code, and typed failure results (`compile_error` with line/column, `runtime_error` with signal
  and line, `timeout`, `truncated`). Every call and every return is a step, so recursion builds up and unwinds one
  frame at a time, also for functions written on one source line.
- **Frontend (`fe/`, React + Vite + CodeMirror 6)**: editor on the left; call stack (innermost frame on top) and
  output on the right; control bar with Run, Previous, Play/Pause, Next, Reset, a scrubber, step counter and speed
  (0.5-8x). The executing line is highlighted, changed values flash, a returning call shows "fact() returned 6" on
  the frame that received it, the output panel fills in as the program prints, and compile errors, crashes, timeouts, stale
  code and a down backend each have a designed state. Shortcuts (also listed under "Shortcuts" in the top bar): Ctrl+Enter run (works while typing), ← → step, Space play, Home/End first/last, PgUp/PgDn ±10 steps, [ / ] previous/next problem.
  Editor help: brackets and quotes close themselves, names are suggested as you type (C++ keywords, common `std` names, and
  the functions, variables and types declared in your own code; after `std::` only `std` names), and **Format** (or Shift+Alt+F)
  reformats the code with clang-format compiled to WebAssembly (4-space indent; downloaded on the first click, ~1 MB gzipped).
  Design rationale: [docs/DESIGN.md](docs/DESIGN.md).
- `POST /api/code/run`: plain run through a public Judge0 instance (no tracing).
- 58 unit + 36 integration backend tests (hello, variables, loops, recursion and return values, compile/link errors, segfault, infinite loop,
  huge one-line loop, step budget, stdin, OOM/fork/disk bombs, forged result files, big stdout, deep recursion,
  malformed requests, concurrency cap, `__proto__` names; runner failure paths are unit-tested with a mocked docker).

- **Data-structure diagrams (Phases 5-9):** values are read from the stopped program as a typed tree, and every
  arrow comes from a real address. Arrays are index cells (64-cell window + "+N more", changed cells flash, loop
  variables like `i`/`j` are marked under their cell — a name-based guess, labelled as such). Pointers draw arrows to
  stack variables, array elements and heap blocks; `delete`d blocks are marked **freed** (dangling pointers dashed
  red). A block nothing points at is judged by looking ahead through the run: **in transit** (the pointer is just not
  stored yet, as after every `new`) or **leaked** (never reached again; collected in its own tray with a byte total,
  D-031). Heap structures are laid out by their real shape: singly
  and doubly linked lists, binary trees (collapsed past depth 6), or a general graph. STL containers (`vector`,
  `list`, `map`, `string`...) are read through GDB's pretty-printers. A tiny `LD_PRELOAD` shim logs `malloc`/`free` so
  block sizes and frees are known (D-027).
- **Understanding the run:** a one-sentence caption per step built only from the trace ("sum changed 6 → 10",
  "Allocated 16 bytes"); the line about to run shows the values of the variables it uses; hovering a pointer or node
  lights its arrows and rings what they point at; an execution timeline (height = call depth) with click/drag to jump;
  and a **bug spotlight** that pins leaks, dangling pointers, crashes and timeouts to their step with an explanation,
  wording any guess about a cause as a guess (D-032).
- **Pointers, ranges and matrices (D-034):** every pointer variable is a **tag on the cell or node it points at**
  (`lp`, `rp`, `slow`, `fast`, `head`) and moves with the code; the arrows from the variable table are quiet backdrop.
  A binary search dims the discarded half and lights the live range with `mid` ringed; a sliding window is lit; nodes
  between a `left` and a `right` pointer are lit in a linked list. `int m[3][4]` and `vector<vector<int>>` are drawn as
  grids with row and column numbers and the active cell highlighted. Ranges and row/column markers are **guessed from
  variable names** (lo/hi, left/right, i/j...) and say so; the pointer tags are facts from real addresses.
- 73 unit + 48 integration backend tests; 190 frontend unit tests; 16 + 23 real-Chrome checks (the 23 in
  `fe/e2e/diagrams.mjs` read lists, trees, arrows, STL, leaks, the timeline and hover tracing off the page).
- Heap blocks are cached by raw bytes in the tracer (D-033): a 200-node list traces at ~140 steps/s instead of ~85, and
  `node bk/runner/check_heap_cache.js` proves the output is identical to the uncached tracer.

What does **not** exist yet: globals/statics in the diagrams, step compression for very long runs, AI explanations,
a light theme, step over/into/out. Known limits (measured; details in [docs/RESEARCH.md](docs/RESEARCH.md) → Phases
5-9): arrays show the first 64 cells, the heap view stops at 150 blocks, tracing is ~140 steps/s with a 200-node heap
(~750 steps/s for plain code), a `unique_ptr` chain is drawn as a generic linked structure, and hover tracing needs a
mouse. Local use only — never expose publicly (see
[docs/DECISIONS.md](docs/DECISIONS.md) D-010). Architecture and schema: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Try it (Docker Desktop must be running):

```bash
cd bk/runner && docker build -t cvis-runner:2 .       # once
cd .. && npm install && npm run dev                    # backend on PORT (default 5000)
cd ../fe && npm install && npm run dev                # frontend on http://localhost:5173 (open this)
curl -X POST http://localhost:5000/api/trace -H "Content-Type: application/json" \
  -d '{"code":"int main(){int a=1; a=a+1; return 0;}"}'
cd ../bk && npm test && npm run test:integration      # backend: 73 unit, 48 runner-backed
node runner/check_heap_cache.js                       # heap cache on vs off must give identical traces (needs Docker)
cd ../fe && npm test                                  # frontend: 190 unit
cd ../fe && npm run e2e                               # 16 real-Chrome checks (backend + dev server must be running;
                                                      # if 127.0.0.1:5173 is refused: APP_URL=http://localhost:5173/ npm run e2e)
cd ../fe && npm run e2e:diagrams                      # 23 real-Chrome checks of the arrays / pointers / lists / trees / STL / leaks / timeline
                                                      # (rebuild the runner image first after any change under bk/runner)
cd ../fe && npm run e2e:editor                        # 10 real-Chrome checks of bracket closing, suggestions, Format (dev server only)
```

**Security:** this executes arbitrary C++. User code runs only inside the runner container, never on the host.
Do not expose the server publicly until the Phase 12/13 security review (D-010). The earlier host-side
experiment that ran code locally was deleted (D-005).

## Run the backend

```bash
cd bk
npm install
npm run dev              # nodemon server.js, listens on PORT (default 5000)
```

```bash
curl -X POST http://localhost:5000/api/code/run -H "Content-Type: application/json" \
  -d '{"code":"#include <iostream>\nint main(){std::cout<<\"hi\";}"}'
```

Response: `{stdout, stderr, compile_output, status, time, memory}`. Environment: `PORT`, `JUDGE0_URL` (optional).

## Docs

| File | Purpose |
|---|---|
| [docs/RESEARCH.md](docs/RESEARCH.md) | Landscape, evidence, open problems, recommendation |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | MVP / V1 / Future |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Proposed system and trace schema |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision log |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phased plan |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Test matrix |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup and commands |
| [docs/INTERVIEW_NOTES.md](docs/INTERVIEW_NOTES.md) | Plain-language project summary: decisions, problems, numbers |
| [CLAUDE.md](CLAUDE.md) | Project memory for Claude Code |
