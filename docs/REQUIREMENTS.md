# Requirements

Scope rule: if it isn't listed under MVP it is not built until MVP is done and approved.
Difficulty: S (days), M (1–2 weeks), L (weeks), XL (research-grade).

## MVP — "write code → run → step → visualize" for beginner programs

| # | Feature | User problem | Expected behaviour | Input → Output | Edge cases | Dependency | Diff. | Known limits |
|---|---|---|---|---|---|---|---|---|
| M1 | Sandboxed compile + trace | "What did my program do?" | Compile with `-g -O0`, run under tracer, return trace JSON | `{files:[{name,content}], stdin?}` → `{status, trace?, stdout, compileErrors[]}` | empty source, no `main`, 64 KB+ source, compile error, runtime crash, infinite loop, huge output | Runner image (Docker), tracer.py | L | Single file used; one GCC version; no threads |
| M2 | Compiler error display | "Why won't it run?" | Errors with line/col shown in editor gutter + panel | compile stderr → `[{line,col,severity,message}]` | warnings only; errors in headers | M1 | S | Parsing GCC text format |
| M3 | Step timeline | Follow execution in order | Prev / Next / Reset / Play / Speed / scrubber; current line highlighted | trace → UI state | 0-step trace (empty `main`); last step; trace truncated | M1, frontend | M | |
| M4 | Primitive variables | See values change | Stack frame cards with name/type/value; changed value flashes | step → frame vars | uninitialised garbage shown raw; `char` as char+code; `bool`; 64-bit ints as strings | M1 | M | No uninitialised detection |
| M5 | Call stack + recursion | Understand calls | Frames stacked; return values shown; recursion depth visible | step → frames[] | depth cap (e.g. 100 frames shown); stack overflow crash | M1 | M | |
| M6 | stdout panel | See program output as it appears | Output sliced per step | step → stdout prefix | no trailing newline; huge output truncated | M1 | S | |
| M7 | Arrays (fixed C arrays) | See array contents | Indexed cells; changed cell highlighted | array value → cells | length >100 → truncated with notice; array of structs | M4 | M | |
| M8 | Limits & honest errors | Don't hang / no confusion | Visible states: compiling, running, tracing, truncated, timeout, crashed (signal + line), unsupported | n/a | every limit hit has a message | M1 | M | |
| M9 | Editor | Write code | Monaco (or CodeMirror 6) C++ editor, line highlight, error markers, stdin box, a few sample programs | — | very long lines; paste of huge file | frontend | M | |

MVP acceptance: the programs in TEST_PLAN cases 1–6, 15–19, 22–23 produce correct traces and render correctly;
limits enforced.

## V1 — memory model and data structures

| # | Feature | User problem | Behaviour | Edge cases | Dep. | Diff. | Limits |
|---|---|---|---|---|---|---|---|
| V1.1 | Pointers & references | "What does this pointer point to?" | Arrow from pointer to stack slot / heap block | null, dangling, wild, `void*`, pointer-to-pointer, interior pointers | M4 | L | Wild pointers render as `unavailable` |
| V1.2 | Heap (new/delete/malloc/free) | See allocations | Heap panel; freed blocks greyed | leak at exit, double free, use after free | V1.1 | L | Block typing inferred |
| V1.3 | Structs/classes | See objects | Field list; base classes; nested | padding not shown; virtual tables hidden | V1.1 | M | |
| V1.4 | Linked lists (singly/doubly) | See `next`/`prev` | Horizontal chain layout | cycle, null tail, shared nodes | V1.2, V1.3 | M | Shape inferred from self-typed pointers |
| V1.5 | Trees / BST | See `left`/`right` | Tree layout | skewed, large (collapse subtrees), DAG sharing | V1.2 | M | |
| V1.6 | STL: vector, string, array | Most common containers | Contents as cells; size/capacity | empty, reallocation (new buffer), SSO string | GDB printers | L | Printer-version dependent |
| V1.7 | STL: map/set/unordered_*, stack, queue, deque, pair | | Key/value table, ordered by container | large, custom comparator keys | V1.6 | L | Same |
| V1.8 | Step compression | 10⁶-iteration loops usable | "Skipped N iterations" events, keyframes | nested loops, recursion | M1 | XL | Heuristic |
| V1.9 | Keyboard shortcuts, dark/light | Power use | ←/→ step, space play, `R` reset | | M3 | S | |
| V1.10 | Trace caching + share link | Re-open instantly | Hash of (source,stdin) | | M1 | S | No accounts |

## Future (do not start)

- AI explanations (Phase 11) — grounded only, optional
- Interactive stdin during stepping; multi-file projects UI; C++ standard / compiler selection
- Smart pointers, lambdas, `std::function`, exceptions, virtual dispatch visuals
- Threads; graph drawing; memory-leak/UB analyzers; reverse stepping beyond trace
- Public hosting, rate limiting, accounts, persistence, sharing/embedding
- Browser-side (WASM) execution
