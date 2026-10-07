# Architecture

Status: **confirmed by the Phase 1 spike (2026-10-07); trace schema still draft v0** (see RESEARCH.md → Recommended Direction). Nothing below has been
built except the existing Express skeleton and the Judge0 plain-run endpoint.

## Overview

```
 Browser (React + Vite: editor | visualization | controls)
        │  POST /api/trace  {files, stdin}
        ▼
 Express backend (CommonJS)           routes → controllers → services
   traceController
        │ validate request, enforce size limits, hash for cache
        ▼
   traceService ──► runnerService ──► Docker run (per request, no network, limits)
        │                               ┌───────────────────────────────────┐
        │                               │ runner image (Linux, amd64)       │
        │                               │ 1. g++ -g -O0 (timeout)           │
        │                               │ 2. gdb -nx -batch -x tracer.py    │
        │                               │    steps by line, snapshots       │
        │                               │    → trace.raw.json (file)        │
        │                               └───────────────────────────────────┘
        ▼
   traceProcessor: schema-validate → heap/pointer graph → shape detection
                   → delta-encode + compress loops → Visualization JSON
        │
        ▼
 Browser: renders strictly from the trace (no AI, no guessing)
        │ (later, optional) POST /api/explain {traceSlice} → grounded LLM text
```

## Components and why

| Component | Choice | Why |
|---|---|---|
| Tracer | Python script **inside** GDB | Avoids per-step MI round-trips (MI measured 155 steps/s, RESEARCH.md); DWARF gives exact types; libstdc++ printers give STL. |
| Execution | Own runner container | Public Judge0 sandbox has no gdb; self-hosted Judge0 needs cgroup v1 + privileged and fails on Docker Desktop/WSL2. |
| Tracer language | Python | GDB's scripting API exposes types, frames and pretty-printers. |
| Trace transport | Files on an in-container tmpfs, returned as length-prefixed frames on container stdout (D-016) | The original "file on a bind mount read by Node" let the user's program plant symlinks/FIFOs and fill the host disk. The program still shares the container with the tracer, so the frames stay untrusted. |
| Post-processing | JS service in Node | Pure functions, unit-testable without Docker; shape detection lives here, not in the tracer. |
| Frontend | React + Vite (confirm in Phase 3) | Component model suits stack/heap panels; no SSR need. |
| Rendering | SVG for arrows/structures, DOM for cards | Pointer arrows need coordinates (cpp-tutor does likewise). |
| Cache | In-memory map keyed by SHA-256(source+stdin+runnerVersion) | No database until needed. |
| Judge0 | Optional `/api/code/run` plain run | Works today; not on the tracing path. |

## Backend layout (existing structure retained)

```
bk/
  server.js
  src/
    app.js
    routes/        codeRoutes.js (existing)    traceRoutes.js (new)
    controllers/   codeController.js (existing) traceController.js (new)
    services/      judge0Service.js (existing)
                   runnerService.js      docker spawn + limits + kill
                   traceProcessor.js     validate / graph / shapes / delta-encode
    utils/         limits.js  hash.js  validate.js
  runner/          Dockerfile  tracer.py  compile.sh      (not Node code)
  src/tests/       unit + integration tests (see TEST_PLAN.md)
```

`compilerService.js` / `gdbService.js` (local MI experiment) were removed in Phase 2 (DECISIONS D-005).
Implemented additions: `routes/traceRoutes.js`, `controllers/traceController.js`, `services/runnerService.js`,
`services/traceProcessor.js`, `utils/limits.js`, `utils/validateRequest.js`, `runner/{Dockerfile,tracer.py,run.sh}`.
No hash/cache util yet (YAGNI until traces are slow enough to matter).

## Trace schema v1 (implemented in Phase 2: `bk/src/services/traceProcessor.js`)

What `POST /api/trace` actually returns today (primitive programs; heap/containers arrive in later phases):

```jsonc
{
  "schema": 1,
  "status": "ok | compile_error | runtime_error | timeout | truncated | internal_error",
  "message": null,                       // human sentence for every non-ok status
  "exitCode": 0, "signal": null, "crashLine": null,
  "limits": { "maxSteps": 5000, "stepsRecorded": 41, "truncated": false },
  "droppedRecords": 0,                   // tracer records rejected by validation (should be 0)
  "compileErrors": [ { "line": 3, "column": 13, "severity": "error", "message": "…" } ],
  "compileOutput": null,                 // raw compiler/linker text, only for compile_error
  "stdout": "…", "stderr": "…",          // whole-run text, capped at 1 MB
  "keyframeEvery": 50,
  "steps": [ {
      "n": 12, "line": 8, "fn": "main", "event": "step | call | return",
      "depth": 2,                        // live frames; frames beyond depth are gone
      "stdoutLen": 0,                    // see limitation below
      "keyframe": false,                 // true: `frames` lists every frame; false: only changed frames
      "frames": [ { "id": "f1", "fn": "fact", "line": 8,
                    "vars": { "n": { "kind": "int", "type": "int", "value": "3" } } } ],
      "changes": ["f1.vars.n"],          // frame index = stack position, main is f0
      "returned": null,                  // or { "fn": "fact", "kind": "int", "type": "int", "value": "6" }: what the call
                                         //   that just returned handed back (primitives only; void/struct/main: null)
      "skipped": null                    // or { "line": 4, "reason": "insn_cap" }: a one-line loop was run
  } ]                                    //   at full speed to the next line (not stepped)
}
```

Value `kind` today: `int float bool char enum ptr raw unavailable` (`raw` = GDB's printer text for anything
not yet modelled: arrays, structs, STL; Phases 5–9 replace it with structured kinds). `ptr` carries `addr`.

Rules enforced and tested: tracer output is untrusted (every record validated, strings clipped, frames ≤ 64,
vars ≤ 200/frame, identifier-only names stored on null-prototype objects); a local is shown only after its
declaring line has run (arguments from the start); a program killed by a signal is never `ok`.

`stdoutLen` (bytes of stdout visible at a step): measured before Phase 4, with plain `'\n'` output it stayed 0 for
every step (`0,0,0,0,0,0,0,0,0`), because stdout is a file and libc fully buffers it. The traced program now runs with
`LD_PRELOAD=/opt/unbuf.so` (`bk/runner/unbuf.c`, D-026), so each write lands when its statement runs (same program:
`0,0,7,7,14,14,21,21,21`). Measured exception: after `std::ios::sync_with_stdio(false)` `cout` has its own buffer and
`stdoutLen` stays 0 until exit (the panel then shows everything at the last step).

A step ends when a function returns into user code (D-025), so every call and every return is a step, also for
functions written on one source line. Known limitations (see RESEARCH.md): a one-line `main` is still one step;
callbacks invoked from library code (comparators passed to `std::sort`, …) are not stepped into; trace speed is
~400 steps/s with full frame snapshots.

## Visualization JSON (original draft v0, kept for the data-structure phases)

Design rules: the tracer emits facts; every value is tagged; unknown is `unavailable`; steps are deltas; ids are
stable across steps so the frontend can animate. Values below are synthetic.

```jsonc
{
  "schema": 0,
  "status": "ok | compile_error | runtime_error | timeout | truncated",
  "limits": { "maxSteps": 5000, "stepsRecorded": 41, "truncated": false },
  "compileErrors": [],
  "stdout": "…full text…",
  "keyframeEvery": 50,
  "steps": [
    {
      "n": 12, "line": 8, "event": "step | call | return | exception | skipped",
      "stdoutLen": 6,                             // how much of stdout is visible at this step
      "frames": [                                 // full list at keyframes; otherwise only changed frames
        { "id": "f2", "fn": "sum", "line": 8,
          "vars": { "i": { "kind":"int", "type":"int", "value":"3" },
                    "p": { "kind":"ptr", "type":"Node*", "addr":"0x5581…", "target":"h1" } } }
      ],
      "heap": { "h1": { "addr":"0x5581…", "size":16, "type":"Node", "live":true,
                        "value": { "kind":"struct", "type":"Node",
                          "fields":[ {"name":"val","value":{"kind":"int","value":"7"}},
                                     {"name":"next","value":{"kind":"ptr","addr":null,"target":null}} ] } } },
      "changes": ["f2.vars.i", "heap.h1.value.fields.next"],
      "skipped": null                             // or { "iterations": 99990, "lines": [5,6] }
    }
  ]
}
```

Value kinds: `int | float | bool | char | enum | ptr | ref | array | struct | container | string | unavailable`.
`container` carries `container: "vector|map|set|…"`, `size`, and `elems`/`entries`.
Derived by the post-processor only: `shape: "list|dlist|tree"` on heap nodes.

This is a **draft**; it is frozen as `schema: 1` with JSON Schema validation once Phase 2 produces real traces.

## Trust boundaries

1. Browser → backend: untrusted JSON. Validate type, size, count.
2. Backend → runner: source is hostile. Docker with limits; the only host mount is a fresh temp dir holding the
   source (and stdin), read-only. Nothing is read back from any host path.
3. Runner → backend: the result frames are **untrusted data** (the user program shares the container and may
   forge or flood stdout). Hard 8 MB cap on the stream; parse by explicit lengths; schema-validate every record
   and every field of the end record; never `eval`; the frontend must render stdout/stderr/compiler text as text
   (never `innerHTML`) and treat variable names as data (`__proto__`).
4. Backend → LLM (later): only validated trace slices.

## Failure model

Every failure yields a typed `status` with a human message; the UI never shows a stack trace. Compile errors and
crashes (signal + last line) are *results*, not HTTP 500s.
