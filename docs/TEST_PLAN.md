# Test Plan

Living document. Status: ⬜ not written · 🟨 partial · ✅ passing. Automated: `cd bk && npm test` (58 unit) and
`npm run test:integration` (36 integration, needs Docker + image `cvis-runner:2`). Fixtures: `bk/src/tests/fixtures/`.
The old manual scripts (`test-compiler.js`, `test-gdb-service.js`) were removed with the MI experiment (D-005).
🟨 notes: #28 infinite recursion ends typed with depth <= 64, but the outermost frames are dropped without a marker · #3 fixture sums 0..4 (not 0..9) · #5 return values are primitives only (int/bool/char/enum/pointer/float/double); struct/container returns come with Phases 7-9 · #15 type/undeclared errors, not a bare syntax error · #17 SIGSEGV only (no throw/abort yet) · #29 declaration timing tested, uninitialised-value display not.

Layers: **U** unit (pure JS, no Docker) · **I** integration (needs runner container) · **E** end-to-end (browser: `cd fe && npm run e2e`, 16 checks) ·
**H** hostile (security). "Our server does not crash" is implied for every case.

| # | Case | Layer | Input sketch | Expected | Status |
|---|---|---|---|---|---|
| 1 | Hello world | I | `cout << "Hi"` | status ok; stdout "Hi"; ≥1 step in `main` | ✅ |
| 2 | Variables | I | int/double/char/bool declarations | values correct per step; `char` shows char+code | ✅ |
| 3 | Loops | I | for 0..9 sum | `i`, `sum` change each iteration; final 45 | ✅ |
| 4 | Arrays | I | init, bubble sort | cell changes tracked; length correct | ⬜ |
| 5 | Functions | I | call with args and return | call/return events; return value | ✅ |
| 6 | Recursion | I | fib(5), factorial(10) | depth grows/shrinks; frames distinct | ✅ |
| 7 | Pointers | I | swap via pointers, pointer to pointer | arrows target the right slot | ⬜ |
| 8 | Structs | I | struct with nested struct | fields correct | ⬜ |
| 9 | Classes | I | ctor/dtor, member functions | `this`, fields; ctor/dtor steps | ⬜ |
| 10 | Linked list | I | build, reverse, delete | shape=list; pointer rewiring per step | ⬜ |
| 11 | Trees | I | BST insert/inorder | shape=tree; 200-node skewed ok | ⬜ |
| 12 | map | I | insert/find/erase | entries correct; ordered | ⬜ |
| 13 | vector | I | push_back past capacity | reallocation visible; size/capacity | ⬜ |
| 14 | set/stack/queue/deque/string | I | basic ops; SSO vs heap string | renders or `unavailable`, never errors | ⬜ |
| 15 | Invalid code | I | `int main( {` | compile_error with line/col | 🟨 |
| 16 | Compiler error (type) | I | undeclared variable | message + line; no run | ✅ |
| 17 | Runtime error | I | uncaught throw, `abort()` | runtime_error with signal and last line | 🟨 |
| 18 | Segfault | I | null deref | crash step shows last line + frames; tracer not hung | ✅ |
| 19 | Infinite loop | I | `while(1);` | killed ≤ wall limit; status timeout; partial trace kept; container gone | ✅ |
| 20 | Huge loop | I | 10⁷ iterations | trace ≤ cap, `skipped` event, finishes in time | ✅ |
| 21 | Large memory | I/H | `new char[2e9]`, huge vector | memory-limit kill with message; host unaffected | ✅ |
| 22 | User input | I | `cin >> n` with stdin | works; empty stdin handles EOF | ✅ |
| 23 | Empty program | I | `int main(){}` | ok, minimal trace | ✅ |
| 24 | No main / only comments | I | | compile/link error shown | ✅ |
| 25 | Malformed requests | U | missing `code`/`files`, wrong types, null, array, 10 MB body | 400 with message; never 500 | ✅ |
| 26 | Very large source | U/I | 1 MB source | rejected (400/413) at limit | ✅ |
| 27 | Huge stdout | I | print 1e8 chars | truncated flag, bounded response | ✅ |
| 28 | Deep recursion | I | infinite recursion | stack overflow = crash status; frame display capped | 🟨 |
| 29 | Uninitialised vars | I | `int x;` | garbage shown raw, tracer fine | 🟨 |
| 30 | Bad pointers | I | wild/dangling/freed | `unavailable` with reason; tracer continues | ⬜ |
| 31 | Concurrency | I | 10 parallel requests | all complete, isolated dirs, cap respected | ✅ |
| 32 | Cache | U | same request twice | second is a hit, identical output | ⬜ |
| 33 | Trace schema | U | fuzzed/forged trace file | rejected cleanly | ✅ |

## Hostile suite (Phase 13; stubs written early)

fork bomb ✅ · disk bomb ✅ · symlink/FIFO result files ✅ · `while(fork())` · `#include "/dev/zero"` · `#include </etc/passwd>` · template recursion bomb ·
`system("curl …")` · open sockets · write to `/` · read `/proc`, `/sys` · write to inherited fd (forge trace) ·
`ptrace(PTRACE_ATTACH)` on gdb · massive stdout · `.gdbinit`/`#pragma` tricks · very long single line ·
unicode/BOM/NUL bytes in source · output containing ANSI/HTML (XSS in the UI) · deleting its own binary.

## Performance checks (from Phase 1; record numbers in RESEARCH.md)

compile time (hello, `<bits/stdc++.h>`) · tracer steps/s · trace size per 1k steps · backend latency p50/p95 ·
frontend render time for a 5k-step trace · runner memory per request.

## Manual checks per milestone

Run the app, exercise the new feature, read server and container logs, try one adversarial input, screenshot the UI.
