const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTrace, parseCompileErrors } = require("../../services/traceProcessor");
const { LIMITS } = require("../../utils/limits");

const variable = (value, kind = "int") => ({ kind, type: "int", value: String(value) });
const stepRecord = (n, line, vars, extra = {}) => ({
  t: "step", n, line, fn: "main", depth: 1, stdoutLen: 0, event: "step",
  frames: [{ fn: "main", line, vars }], ...extra,
});
const toJsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n");
const endRecord = (overrides = {}) => ({ t: "end", status: "exited", exitCode: 0, signal: null, line: null, ...overrides });
const rawRun = (records, overrides = {}) => ({
  compileExitCode: 0, compileOutput: "", traceText: toJsonl(records), stdout: "", stderr: "", timedOut: false, ...overrides,
});

test("maps an exited run to status ok with the exit code", () => {
  const trace = buildTrace(rawRun([stepRecord(0, 3, { a: variable(1) }), endRecord({ exitCode: 3 })]));
  assert.equal(trace.status, "ok");
  assert.equal(trace.exitCode, 3);
  assert.equal(trace.schema, 1);
  assert.equal(trace.steps.length, 1);
});

test("maps a crash to runtime_error with signal and line", () => {
  const trace = buildTrace(rawRun([stepRecord(0, 4, {}), endRecord({ status: "crashed", signal: "SIGSEGV", line: 4 })]));
  assert.equal(trace.status, "runtime_error");
  assert.equal(trace.signal, "SIGSEGV");
  assert.equal(trace.crashLine, 4);
});

test("a program killed without a crash signal (OOM) is a runtime_error, never ok", () => {
  const trace = buildTrace(rawRun([stepRecord(0, 4, {}), endRecord({ status: "killed", exitCode: null })]));
  assert.equal(trace.status, "runtime_error");
  assert.match(trace.message, /killed/);
});

test("maps tracer limits to truncated and timeout", () => {
  assert.equal(buildTrace(rawRun([stepRecord(0, 1, {}), endRecord({ status: "step_limit" })])).status, "truncated");
  const loop = buildTrace(rawRun([stepRecord(0, 1, {}), endRecord({ status: "line_timeout", line: 4 })]));
  assert.equal(loop.status, "timeout");
  assert.match(loop.message, /Line 4/);
});

test("a killed run with no end record keeps its steps and reports timeout", () => {
  const trace = buildTrace(rawRun([stepRecord(0, 1, {}), stepRecord(1, 2, {})], { timedOut: true }));
  assert.equal(trace.status, "timeout");
  assert.equal(trace.steps.length, 2);
  assert.equal(trace.limits.truncated, true);
});

test("an empty trace without a timeout is an internal_error, never a fake success", () => {
  assert.equal(buildTrace(rawRun([])).status, "internal_error");
});

test("a half-written last line is dropped and counted, earlier steps survive", () => {
  const text = `${toJsonl([stepRecord(0, 1, {})])}\n{"t":"step","n":1,"li`;
  const trace = buildTrace(rawRun([], { traceText: text, timedOut: true }));
  assert.equal(trace.steps.length, 1);
  assert.equal(trace.droppedRecords, 1);
});

test("compile failure returns diagnostics and no steps", () => {
  const output = "/tmp/main.cpp: In function 'int main()':\n/tmp/main.cpp:3:13: error: invalid conversion from 'const char*' to 'int'\n/tmp/main.cpp:4:5: error: 'undefined_function' was not declared in this scope";
  const trace = buildTrace(rawRun([], { compileExitCode: 1, compileOutput: output, traceText: null }));
  assert.equal(trace.status, "compile_error");
  assert.equal(trace.steps.length, 0);
  assert.deepEqual(trace.compileErrors.map((e) => [e.line, e.column, e.severity]), [[3, 13, "error"], [4, 5, "error"]]);
});

test("a compile timeout (exit 124) is reported as such", () => {
  const trace = buildTrace(rawRun([], { compileExitCode: 124, compileOutput: "", traceText: null }));
  assert.equal(trace.status, "compile_error");
  assert.match(trace.message, /timed out/);
});

test("parseCompileErrors ignores noise and caps the count", () => {
  const many = Array.from({ length: 80 }, (_, i) => `main.cpp:${i + 1}:1: error: boom`).join("\n");
  assert.equal(parseCompileErrors(many).length, 50);
  assert.deepEqual(parseCompileErrors("random text\nnot a diagnostic"), []);
  assert.deepEqual(parseCompileErrors(null), []);
});

test("delta encoding: keyframe has all frames, later steps only changes", () => {
  const trace = buildTrace(rawRun([
    stepRecord(0, 3, { a: variable(1), b: variable(2) }),
    stepRecord(1, 4, { a: variable(1), b: variable(5) }),
    endRecord(),
  ]));
  const [first, second] = trace.steps;
  assert.equal(first.keyframe, true);
  assert.deepEqual(first.changes, ["f0"]);
  assert.equal(second.keyframe, false);
  assert.deepEqual(second.changes, ["f0.vars.b"]);
  assert.equal(second.frames.length, 1);
});

test("an unchanged step carries no frames and no changes", () => {
  const same = { a: variable(1) };
  const trace = buildTrace(rawRun([stepRecord(0, 3, same), stepRecord(1, 3, same), endRecord()]));
  assert.deepEqual(trace.steps[1].frames, []);
  assert.deepEqual(trace.steps[1].changes, []);
});

test("a variable that goes out of scope is reported as a change", () => {
  const trace = buildTrace(rawRun([stepRecord(0, 3, { i: variable(1) }), stepRecord(1, 5, {}), endRecord()]));
  assert.deepEqual(trace.steps[1].changes, ["f0.vars.i"]);
});

test("recursion: every frame is addressed by stack index and depth is recorded", () => {
  const deep = {
    t: "step", n: 1, line: 2, fn: "fact", depth: 2, stdoutLen: 0, event: "call",
    frames: [{ fn: "main", line: 7, vars: {} }, { fn: "fact", line: 2, vars: { n: variable(3) } }],
  };
  const trace = buildTrace(rawRun([stepRecord(0, 7, {}), deep, endRecord()]));
  assert.equal(trace.steps[1].depth, 2);
  assert.ok(trace.steps[1].changes.includes("f1"));
  assert.equal(trace.steps[1].frames[0].id, "f1");
});

test("a skip record attaches to the next step", () => {
  const trace = buildTrace(rawRun([
    stepRecord(0, 4, {}), { t: "skip", line: 4, reason: "insn_cap" }, stepRecord(1, 6, {}), endRecord(),
  ]));
  assert.deepEqual(trace.steps[1].skipped, { line: 4, reason: "insn_cap" });
  assert.equal(trace.steps[0].skipped, null);
});

test("hostile tracer output cannot pollute prototypes or smuggle bad values", () => {
  const vars = JSON.parse('{"__proto__":{"kind":"int","type":"int","value":"1"},"ok":{"kind":"int","type":"int","value":"2"},"bad name":{"kind":"int","type":"int","value":"3"},"evil":{"kind":"script","type":"x","value":"4"}}');
  const trace = buildTrace(rawRun([stepRecord(0, 1, vars), endRecord()]));
  const cleaned = trace.steps[0].frames[0].vars;
  // "__proto__" is a legal C++ identifier: it is kept as plain data on a null-prototype object.
  assert.deepEqual(Object.keys(cleaned).sort(), ["__proto__", "ok"]);
  assert.equal(Object.getPrototypeOf(cleaned), null);
  assert.equal(({}).kind, undefined, "Object.prototype must not be polluted");
  assert.equal(Object.keys(JSON.parse(JSON.stringify(cleaned))).includes("__proto__"), true);
});

test("invalid records are dropped, not trusted", () => {
  const bad = [
    { t: "step", n: -1, line: 1, frames: [] },
    { t: "step", n: 0, line: "9", frames: [] },
    { t: "step", n: 0, line: 1, frames: "nope" },
    { t: "mystery" },
    stepRecord(0, 2, { x: { kind: "ptr", type: "int *", value: "0x1", addr: "javascript:alert(1)" } }),
    endRecord(),
  ];
  const trace = buildTrace(rawRun(bad));
  assert.equal(trace.steps.length, 1);
  assert.equal(trace.droppedRecords, 4);
  assert.equal(trace.steps[0].frames[0].vars.x.addr, undefined);
});

test("oversized strings are clipped and frame depth is bounded", () => {
  const long = "x".repeat(5000);
  const tooDeep = Array.from({ length: LIMITS.maxFramesPerStep + 1 }, () => ({ fn: "f", line: 1, vars: {} }));
  const trace = buildTrace(rawRun([
    stepRecord(0, 1, { s: { kind: "raw", type: "t", value: long } }),
    { t: "step", n: 1, line: 1, fn: "f", frames: tooDeep },
    endRecord(),
  ]));
  assert.equal(trace.steps.length, 1);
  assert.equal(trace.steps[0].frames[0].vars.s.value.length, LIMITS.maxTextLength);
  assert.equal(trace.droppedRecords, 1);
});

test("stdout and stderr pass through; missing files become empty strings", () => {
  const trace = buildTrace(rawRun([stepRecord(0, 1, {}), endRecord()], { stdout: "hi\n", stderr: null }));
  assert.equal(trace.stdout, "hi\n");
  assert.equal(trace.stderr, "");
});

test("a tracer failure is internal_error, never ok", () => {
  const trace = buildTrace(rawRun([stepRecord(0, 4, {}), endRecord({ status: "tracer_error" })]));
  assert.equal(trace.status, "internal_error");
});

test("every field of a forged end record is re-validated", () => {
  const forged = { t: "end", status: "crashed", exitCode: "<script>", signal: "<img src=x onerror=alert(1)>".repeat(100), line: { a: 1 } };
  const trace = buildTrace(rawRun([stepRecord(0, 1, {}), forged]));
  assert.equal(trace.status, "runtime_error");
  assert.equal(trace.signal, null);
  assert.equal(trace.exitCode, null);
  assert.equal(trace.crashLine, null);
  assert.ok(!trace.message.includes("<"), "message must not echo forged text");
  assert.ok(buildTrace(rawRun([stepRecord(0, 1, {}), { ...forged, signal: "SIGSEGV", exitCode: 9999 }])).exitCode === null);
});

test("stdoutLen above the cap is clamped, not reset to zero", () => {
  const trace = buildTrace(rawRun([stepRecord(0, 1, {}, { stdoutLen: LIMITS.maxOutputBytes * 5 }), endRecord()]));
  assert.equal(trace.steps[0].stdoutLen, LIMITS.maxOutputBytes);
});

test("stdout truncation is exposed to the client", () => {
  const trace = buildTrace(rawRun([stepRecord(0, 1, {}), endRecord()], { stdoutTruncated: true }));
  assert.equal(trace.limits.stdoutTruncated, true);
  assert.equal(buildTrace(rawRun([stepRecord(0, 1, {}), endRecord()])).limits.stdoutTruncated, false);
});

test("a return value is attached to the step that follows the return; other steps carry null", () => {
  const returned = { fn: "fact", kind: "int", type: "int", value: "6" };
  const trace = buildTrace(rawRun([stepRecord(0, 3, {}), stepRecord(1, 5, {}, { event: "return", returned }), endRecord()]));
  assert.equal(trace.steps[0].returned, null);
  assert.deepEqual(trace.steps[1].returned, returned);
});

test("a forged return value is re-validated, clipped or dropped", () => {
  const badKind = buildTrace(rawRun([stepRecord(0, 1, {}, { returned: { fn: "f", kind: "<script>", type: "int", value: "1" } }), endRecord()]));
  assert.equal(badKind.steps[0].returned, null);
  const notObject = buildTrace(rawRun([stepRecord(0, 1, {}, { returned: "6" }), endRecord()]));
  assert.equal(notObject.steps[0].returned, null);
  const long = buildTrace(rawRun([stepRecord(0, 1, {}, { returned: { fn: "f", kind: "raw", type: "t", value: "x".repeat(5000) } }), endRecord()]));
  assert.ok(long.steps[0].returned.value.length <= LIMITS.maxTextLength);
});

test("a forged trace with far too many records is cut off instead of fully parsed", () => {
  const many = Array.from({ length: LIMITS.maxSteps * 4 }, (_, n) => ({ t: "mystery", n }));
  const trace = buildTrace(rawRun(many, { timedOut: true }));
  assert.ok(trace.droppedRecords <= LIMITS.maxSteps * 2 + 10);
});
