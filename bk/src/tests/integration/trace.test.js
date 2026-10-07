// Integration tests: real Express app + real Docker runner (image cvis-runner:2, see bk/runner/Dockerfile).
// Run: npm run test:integration   (Docker Desktop must be running)
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const app = require("../../app");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.cpp`), "utf8");

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function postTrace(body, { raw = false } = {}) {
  const response = await fetch(`${baseUrl}/api/trace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const traceFixture = (name, extra = {}) => postTrace({ code: fixture(name), ...extra });
const lastFrameVars = (trace) => trace.steps.at(-1).frames.at(-1)?.vars ?? {};
const allVarNames = (trace) => new Set(trace.steps.flatMap((s) => s.frames.flatMap((f) => Object.keys(f.vars))));

test("hello world: ok, stdout captured, steps recorded", async () => {
  const { status, body } = await traceFixture("hello");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.stdout, "Hello\n");
  assert.equal(body.exitCode, 0);
  assert.ok(body.steps.length >= 3);
  assert.equal(body.steps[0].keyframe, true);
});

test("a line with several library calls is one step, not one per call", async () => {
  const { body } = await traceFixture("hello"); // line 3: cout << "Hello" << endl  (three library calls)
  assert.equal(body.steps.filter((s) => s.line === 3).length, 1);
});

test("variables: int, float, bool, char are tagged and updated", async () => {
  const { body } = await traceFixture("variables");
  assert.equal(body.status, "ok");
  const kinds = {};
  for (const step of body.steps) {
    for (const frame of step.frames) {
      for (const [name, v] of Object.entries(frame.vars)) kinds[name] = v.kind;
    }
  }
  assert.deepEqual([kinds.a, kinds.d, kinds.flag, kinds.c], ["int", "float", "bool", "char"]);
  const changeSeen = body.steps.some((s) => s.changes.includes("f0.vars.a"));
  assert.ok(changeSeen, "a = a + 1 must show up as a change");
});

test("variables are not shown before their declaration line", async () => {
  const { body } = await traceFixture("variables");
  const first = body.steps[0];
  assert.equal(first.line, 3);
  assert.equal(Object.keys(first.frames[0].vars).length, 0, "no variable is alive at the first line");
});

test("loop: final value is correct and the loop variable goes out of scope", async () => {
  const { body } = await traceFixture("loop");
  assert.equal(body.status, "ok");
  assert.equal(body.stdout, "10\n");
  assert.ok(allVarNames(body).has("i"));
  assert.equal(lastFrameVars(body).i, undefined);
});

test("recursion: depth reaches main + 4 frames with call and return events", async () => {
  const { body } = await traceFixture("recursion");
  assert.equal(body.status, "ok");
  assert.equal(body.stdout, "24\n");
  assert.equal(Math.max(...body.steps.map((s) => s.depth)), 5);
  const events = new Set(body.steps.map((s) => s.event));
  assert.ok(events.has("call") && events.has("return"));
});

test("recursion unwinds one frame at a time: every return is a step", async () => {
  const { body } = await traceFixture("recursion");
  const depths = body.steps.map((s) => s.depth);
  const peak = depths.indexOf(Math.max(...depths));
  const unwinding = depths.slice(peak);
  for (let i = 1; i < unwinding.length; i += 1) {
    assert.ok(unwinding[i - 1] - unwinding[i] <= 1, `depth jumped ${unwinding[i - 1]} -> ${unwinding[i]}: ${depths}`);
  }
  assert.equal(unwinding.at(-1), 1);
});

const returnedValues = (trace) => trace.steps.filter((s) => s.returned).map((s) => `${s.returned.fn}:${s.returned.kind}:${s.returned.value}`);

test("recursion: each call's return value is reported, innermost first", async () => {
  const { body } = await traceFixture("recursion");
  assert.deepEqual(returnedValues(body), ["fact:int:1", "fact:int:2", "fact:int:6", "fact:int:24"]);
});

test("return values are read per type (int, double, bool, char); void returns nothing", async () => {
  const { body } = await traceFixture("returns");
  assert.equal(body.status, "ok");
  assert.deepEqual(returnedValues(body), ["half:float:2.5", "isEven:bool:true", "grade:char:65 'A'"]);
  const afterHello = body.steps.find((s) => s.event === "return" && s.line === 19);
  assert.ok(afterHello, "a return step for hello() exists");
  assert.equal(afterHello.returned, null);
});

test("return values: float, negative, 64-bit, unsigned char, enum class and pointer are exact; struct, reference and a throw report none", async () => {
  const { body } = await traceFixture("returns_types");
  assert.equal(body.status, "ok");
  assert.equal(body.stdout, `${["1.5", "-3", "5000000000", "200", "2", "7", "1", "7", "1"].join("")}\n`);
  const returned = body.steps.filter((s) => s.returned).map((s) => s.returned);
  assert.deepEqual(returned.map((r) => r.fn), ["third", "negative", "big", "byteValue", "pick", "addressOf"]);
  const byFn = Object.fromEntries(returned.map((r) => [r.fn, r]));
  assert.deepEqual([byFn.third.kind, byFn.third.value], ["float", "1.5"]);
  assert.deepEqual([byFn.negative.kind, byFn.negative.value], ["int", "-3"]);
  assert.deepEqual([byFn.big.kind, byFn.big.value], ["int", "5000000000"]);
  assert.equal(byFn.byteValue.kind, "char");
  assert.match(byFn.byteValue.value, /^200 /, `unsigned char text: ${byFn.byteValue.value}`);
  assert.deepEqual([byFn.pick.kind, byFn.pick.value], ["enum", "Color::Blue"]);
  assert.equal(byFn.addressOf.kind, "ptr");
  const pointerInMain = body.steps.flatMap((s) => s.frames).find((f) => f.fn === "main" && f.vars.p)?.vars.p;
  assert.ok(pointerInMain, "main's own pointer variable p was traced");
  assert.equal(byFn.addressOf.value, pointerInMain.value, "the returned pointer is the pointer main then holds");
});

test("recursion written on one source line still unwinds step by step with return values", async () => {
  const { body } = await traceFixture("recursion_oneline");
  assert.equal(body.status, "ok");
  assert.equal(body.stdout, "6\n");
  const depths = body.steps.map((s) => s.depth);
  const peak = depths.indexOf(Math.max(...depths));
  const unwinding = depths.slice(peak);
  for (let i = 1; i < unwinding.length; i += 1) {
    assert.ok(unwinding[i - 1] - unwinding[i] <= 1, `depth jumped ${unwinding[i - 1]} -> ${unwinding[i]}: ${depths}`);
  }
  assert.equal(unwinding.at(-1), 1, `trace ended before unwinding: ${depths}`);
  assert.deepEqual(returnedValues(body), ["fact:int:1", "fact:int:2", "fact:int:6"]);
});

test("stdout grows as the program prints, even without std::endl", async () => {
  const { body } = await traceFixture("stdout_newline");
  assert.equal(body.stdout, "line 0\nline 1\nline 2\n");
  const lengths = body.steps.map((s) => s.stdoutLen);
  // each "line N\n" is 7 bytes: the panel must be able to show them one at a time, not all at the very end
  assert.ok(lengths.includes(7) && lengths.includes(14), `stdoutLen per step: ${lengths}`);
});

test("a function's arguments are never shown before the prologue has stored them", async () => {
  const { body } = await traceFixture("recursion"); // fact(4) .. fact(1)
  const shown = [];
  for (const step of body.steps) {
    const frames = step.keyframe ? step.frames : step.frames.filter((f) => f.id === `f${step.depth - 1}`);
    for (const frame of frames) if (frame.fn === "fact" && frame.vars.n) shown.push(frame.vars.n.value);
  }
  assert.ok(shown.length > 0);
  assert.ok(shown.every((value) => ["1", "2", "3", "4"].includes(value)), `garbage argument values: ${shown}`);
});

test("compile error: a result with diagnostics, not an HTTP error", async () => {
  const { status, body } = await traceFixture("compile_error");
  assert.equal(status, 200);
  assert.equal(body.status, "compile_error");
  assert.deepEqual(body.steps, []);
  const lines = body.compileErrors.map((e) => e.line);
  assert.ok(lines.includes(3) && lines.includes(4), `diagnostic lines: ${lines}`);
});

test("missing main is reported as a compile (link) error", async () => {
  const { body } = await traceFixture("nomain");
  assert.equal(body.status, "compile_error");
  assert.match(body.compileOutput, /main/);
});

test("whitespace-only source is a compile error, not a crash", async () => {
  const { status, body } = await postTrace({ code: "   \n  " });
  assert.equal(status, 200);
  assert.equal(body.status, "compile_error");
});

test("empty main: ok with at least one step", async () => {
  const { body } = await traceFixture("emptymain");
  assert.equal(body.status, "ok");
  assert.ok(body.steps.length >= 1);
});

test("segmentation fault: runtime_error with signal and the faulting line", async () => {
  const { status, body } = await traceFixture("segv");
  assert.equal(status, 200);
  assert.equal(body.status, "runtime_error");
  assert.equal(body.signal, "SIGSEGV");
  assert.equal(body.crashLine, 4);
  assert.equal(body.steps.at(-1).frames[0].vars.p.value, "0x0");
});

test("infinite one-line loop: timeout naming the line, steps kept", async () => {
  const { body } = await traceFixture("infinite");
  assert.equal(body.status, "timeout");
  assert.match(body.message, /Line 3/);
  assert.ok(body.steps.length >= 1);
  assert.equal(body.limits.truncated, true);
});

test("huge legitimate one-line loop completes with a skipped marker, not thousands of steps", async () => {
  const { body } = await traceFixture("bigloop");
  assert.equal(body.status, "ok");
  assert.equal(body.stdout, "4499998500000\n");
  assert.ok(body.steps.length < 20, `steps: ${body.steps.length}`);
  assert.ok(body.steps.some((s) => s.skipped && s.skipped.line === 4));
});

test("step budget: 100k iterations are truncated at the limit", { timeout: 60000 }, async () => {
  const { body } = await traceFixture("stepbudget");
  assert.equal(body.status, "truncated");
  assert.equal(body.limits.stepsRecorded, body.limits.maxSteps);
  assert.equal(body.limits.truncated, true);
});

test("stdin is delivered to the program", async () => {
  const { body } = await traceFixture("stdin", { stdin: "3 4\n" });
  assert.equal(body.status, "ok");
  assert.equal(body.stdout, "7\n");
});

test("program that reads stdin with none supplied gets EOF instead of hanging", async () => {
  const { body } = await traceFixture("stdin");
  assert.equal(body.status, "ok");
  assert.equal(body.stdout, "0\n");
});

test("non-zero exit code is reported, status stays ok", async () => {
  const { body } = await traceFixture("exitcode");
  assert.equal(body.status, "ok");
  assert.equal(body.exitCode, 3);
});

test("a variable named __proto__ is data, not a prototype hazard", async () => {
  const { status, body } = await traceFixture("protoname");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  assert.ok(allVarNames(body).has("__proto__"));
  assert.equal(({}).value, undefined);
});

test("memory bomb is contained by the container limit and answered normally", { timeout: 60000 }, async () => {
  const { status, body } = await traceFixture("membomb");
  assert.equal(status, 200);
  assert.notEqual(body.status, "internal_error");
  assert.notEqual(body.status, "ok", `memory bomb must not look successful: ${JSON.stringify(body.message)}`);
});

test("fork bomb is contained by the pid limit and answered normally", { timeout: 60000 }, async () => {
  const { status, body } = await traceFixture("forkbomb");
  assert.equal(status, 200);
  assert.notEqual(body.status, "internal_error");
});

test("a function called twice does not show its locals early on the second call", async () => {
  const { body } = await traceFixture("twocalls");
  assert.equal(body.status, "ok");
  const squareSteps = body.steps.filter((s) => s.fn === "square");
  assert.ok(squareSteps.length >= 6);
  const declarationLine = 2; // `int result = n * n;`
  const atDeclaration = squareSteps.filter((s) => s.line === declarationLine);
  assert.equal(atDeclaration.length, 2, "one step at the declaration line per call");
  for (const step of atDeclaration) {
    const vars = step.keyframe ? step.frames.at(-1).vars : (step.frames.find((f) => f.id === `f${step.depth - 1}`)?.vars ?? {});
    assert.equal(vars.result, undefined, `result must not be visible before its declaration ran (step ${step.n})`);
  }
});

test("a program that replaces result files with a symlink and a FIFO cannot read or hang the host", async () => {
  const { status, body } = await traceFixture("forgefiles");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.stderr, "", "a symlinked stderr must not be returned");
  assert.ok(!JSON.stringify(body).includes("root:"), "no /etc/passwd content may appear");
});

test("a disk bomb is contained by the size-limited results tmpfs", { timeout: 90000 }, async () => {
  const { status, body } = await traceFixture("diskbomb");
  assert.equal(status, 200);
  assert.notEqual(body.status, undefined);
});

test("large stdout is truncated, flagged, and the run still answers", { timeout: 60000 }, async () => {
  const { status, body } = await traceFixture("bigstdout");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  assert.ok(Buffer.byteLength(body.stdout) <= 1024 * 1024);
  assert.equal(body.limits.stdoutTruncated, true);
});

test("infinite recursion ends with a typed status and a bounded stack depth", { timeout: 120000 }, async () => {
  const { status, body } = await traceFixture("deeprecursion");
  assert.equal(status, 200);
  assert.ok(["truncated", "timeout", "runtime_error"].includes(body.status), `status: ${body.status}`);
  assert.ok(Math.max(...body.steps.map((s) => s.depth)) <= 64);
});

test("malformed requests get 4xx JSON errors", async () => {
  assert.equal((await postTrace({})).status, 400);
  assert.equal((await postTrace({ code: 5 })).status, 400);
  assert.equal((await postTrace([1, 2])).status, 400);
  assert.equal((await postTrace("{not json", { raw: true })).status, 400);
  assert.equal((await postTrace({ code: "a".repeat(101 * 1024) })).status, 400);
  assert.equal((await postTrace({ code: "x", stdin: "y".repeat(11 * 1024) })).status, 400);
});

test("a body over the parser limit is rejected with 413", async () => {
  const { status } = await postTrace({ code: "a".repeat(600 * 1024) });
  assert.equal(status, 413);
});

test("concurrency cap: surplus simultaneous runs get 429 and the rest still succeed", { timeout: 90000 }, async () => {
  const results = await Promise.all([1, 2, 3, 4].map(() => traceFixture("hello")));
  const codes = results.map((r) => r.status).sort();
  assert.ok(codes.includes(429), `statuses: ${codes}`);
  assert.ok(results.filter((r) => r.status === 200).every((r) => r.body.status === "ok"));
});

test("no runner containers are left behind", () => {
  const out = execFileSync("docker", ["ps", "-a", "--filter", "name=cvis-", "--format", "{{.Names}}"]).toString().trim();
  assert.equal(out, "", `leftover containers: ${out}`);
});
