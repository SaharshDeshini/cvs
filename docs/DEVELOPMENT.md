# Development

## Prerequisites (this machine)

- Node v22 (present), npm.
- **Docker Desktop must be running** for anything involving the runner (start it from the Start menu or
  `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`; ready in ~10 s). If the first
  `docker build` fails with `EOF`, the engine was still restarting: wait and retry.
- Runner image (needed for `POST /api/trace` and the integration tests): `cd bk/runner && docker build -t cvis-runner:2 .`
  Override the tag with `RUNNER_IMAGE`.
- Local MinGW `g++ 6.3` and `gdb 7.6.1` exist but are **not** the target toolchain: this GDB has no Python
  support. Do not develop the tracer against them.

## Backend (existing)

```bash
cd bk
npm install
npm run dev            # nodemon server.js
```

The server listens on `PORT` (default 5000). `bk/.env` is git-ignored and currently empty.

Existing endpoint (plain run via Judge0, not tracing):

```bash
curl -X POST http://localhost:5000/api/code/run -H "Content-Type: application/json" \
  -d '{"code":"#include <iostream>\nint main(){std::cout<<\"hi\";}"}'
```

Env vars: `PORT`, `JUDGE0_URL` (default `https://ce.judge0.com/submissions?base64_encoded=false&wait=true`).
Note: with `base64_encoded=false` Judge0 returns HTTP 400 if program output is not valid UTF-8.

## Tests

Node's built-in runner, no extra dependency. From `bk/`:

```bash
npm test                    # unit tests (55, no Docker, ~2 s)
npm run test:integration    # 29 tests, real app + real runner container (needs Docker + the image; ~90 s)
```

C++ inputs live in `bk/src/tests/fixtures/*.cpp` (real files, not strings, to avoid shell/JS escaping bugs).
Case status: `docs/TEST_PLAN.md`. Tracer experiments: `bk/runner/spike/` (`runcase.sh <name>` runs one fixture-like
program through the production image and leaves `cases/<name>/out/trace.jsonl` for inspection).

## Trace API

```bash
curl -X POST http://localhost:5000/api/trace -H "Content-Type: application/json" \
  -d '{"code":"int main(){int a=1; a=a+1; return 0;}","stdin":""}'
```

200 for every program outcome (`status`: ok | compile_error | runtime_error | timeout | truncated);
400 invalid request, 413 body too large, 429 runner busy, 502/503 runner failed/unavailable.
Schema: `docs/ARCHITECTURE.md`. Frontend note: variable names are user-controlled (`__proto__` is legal C++), so
never assign `vars[name] = …` on a plain object — use `Map` or `Object.create(null)`.

## Conventions

See `CLAUDE.md`: CommonJS only; routes → controllers → services; tests for every feature; docs updated with code.

## Frontend (`fe/`)

```bash
cd fe
npm install
npm run dev      # http://localhost:5173 — open exactly this (or http://127.0.0.1:5173); backend must be on :5000
npm test         # 36 unit tests (vitest): trace decoder, playback reducer, status mapping, normaliser
npm run build    # production bundle in fe/dist (about 211 kB gzipped)
npm run e2e      # 14 checks in real Chrome with screenshots in fe/e2e/shots (needs: Docker, runner image,
                 # backend `npm run dev` in bk/, `npm run dev` here; Chrome path via CHROME_PATH)
```

Env: `VITE_API_URL` (default `http://localhost:5000`); backend `FRONTEND_ORIGIN` (comma-separated allow-list, default
both loopback spellings of `:5173`). Layout: `src/lib` = pure logic with tests (`reconstruct`, `playerReducer`,
`status`, `normalize`, `api`), `src/components` = presentation, `src/App.jsx` = state, playback timer and shortcuts.
Rule for the UI: program-derived text (names, values, stdout, stderr, compiler output) is only ever rendered as a
React text node, and variable names are data, not object keys on plain objects.

## AI assistant setup (added 2026-10-13)

- Key: free from https://aistudio.google.com/apikey. Put `GEMINI_API_KEY=...` in `bk/.env` (git-ignored; `bk/.env.example` lists every
  option) and restart the backend: the settings are read on the first request after a start. No key = the assistant is off, and
  `GET /api/ai/status` says why.
- Testing without a key: `cd bk && npm test` (a fake `fetch` and a fake Gemini HTTP server); `cd fe && npm run e2e:assistant` (a mock
  backend on :5000, so the real backend must be stopped first).
- Dev ports: the backend only accepts the `localhost:5173` / `127.0.0.1:5173` origins. A dev server on another port needs
  `FRONTEND_ORIGIN=http://localhost:PORT` on the backend. Check what answers on 5173 first: it may be a different project.
- A server restart forgets the runs it traced; the panel then says "Press Run again".
