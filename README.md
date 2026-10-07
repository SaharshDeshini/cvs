# SCV — C++ Code Visualization Platform

Write C++ on the left, run it, and step through what the program actually did on the right: variables,
arrays, pointers, heap objects, calls. State comes from **real execution**, never from an AI guess.

## Status (2026-10-07): Phase 4 done — recursion, return values and live output work in the browser; next: Phase 5 (arrays)

What exists and works today:

- **`POST /api/trace`**: compiles the C++ (`g++ -g -O0`) and traces it line by line with GDB's Python API inside a
  locked-down Docker container (no network, memory/pid/CPU limits, all capabilities dropped, non-root). Returns a
  validated, delta-encoded trace: per step the line, call stack and primitive variables (`int float bool char enum
  ptr`; anything else comes back as raw printer text for now), what each primitive-typed call returned, plus
  stdout/stderr, exit code, and typed failure results (`compile_error` with line/column, `runtime_error` with signal
  and line, `timeout`, `truncated`). Every call and every return is a step, so recursion builds up and unwinds one
  frame at a time, also for functions written on one source line.
- **Frontend (`fe/`, React + Vite + CodeMirror 6)**: editor on the left; call stack (innermost frame on top) and
  output on the right; control bar with Run, Previous, Play/Pause, Next, Reset, a scrubber, step counter and speed
  (0.5-8x). The executing line is highlighted, changed values flash, a returning call shows "fact() returned 6" on
  the frame that received it, the output panel fills in as the program prints, and compile errors, crashes, timeouts, stale
  code and a down backend each have a designed state. Shortcuts: Ctrl+Enter run, arrows step, Space play, Home reset.
  Design rationale: [docs/DESIGN.md](docs/DESIGN.md).
- `POST /api/code/run`: plain run through a public Judge0 instance (no tracing).
- 58 unit + 36 integration backend tests (hello, variables, loops, recursion and return values, compile/link errors, segfault, infinite loop,
  huge one-line loop, step budget, stdin, OOM/fork/disk bombs, forged result files, big stdout, deep recursion,
  malformed requests, concurrency cap, `__proto__` names; runner failure paths are unit-tested with a mocked docker).

What does **not** exist yet: arrays/structs/pointer graphs/STL as structured values (they show as raw text),
AI explanations, caching, a light theme. Trace speed is ~400 steps/s (5,000-step budget). Local use only — never expose publicly (see
[docs/DECISIONS.md](docs/DECISIONS.md) D-010). Architecture and schema: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Try it (Docker Desktop must be running):

```bash
cd bk/runner && docker build -t cvis-runner:2 .       # once
cd .. && npm install && npm run shreshu               # backend on PORT (default 5000)
cd ../fe && npm install && npm run dev                # frontend on http://localhost:5173 (open this)
curl -X POST http://localhost:5000/api/trace -H "Content-Type: application/json" \
  -d '{"code":"int main(){int a=1; a=a+1; return 0;}"}'
cd ../bk && npm test && npm run test:integration      # backend: 58 unit, 36 runner-backed
cd ../fe && npm test                                  # frontend: 37 unit
cd ../fe && npm run e2e                               # 16 real-Chrome checks (backend + dev server must be running;
                                                      # if 127.0.0.1:5173 is refused: APP_URL=http://localhost:5173/ npm run e2e)
```

**Security:** this executes arbitrary C++. User code runs only inside the runner container, never on the host.
Do not expose the server publicly until the Phase 12/13 security review (D-010). The earlier host-side
experiment that ran code locally was deleted (D-005).

## Run the backend

```bash
cd bk
npm install
npm run shreshu          # nodemon server.js, listens on PORT (default 5000)
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
