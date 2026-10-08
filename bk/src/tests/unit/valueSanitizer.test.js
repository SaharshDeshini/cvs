const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeValue, sanitizeHeapDelta } = require("../../services/valueSanitizer");
const { buildTrace } = require("../../services/traceProcessor");
const { LIMITS } = require("../../utils/limits");

const int = (value) => ({ kind: "int", type: "int", value: String(value) });
const pointer = (addr, extra = {}) => ({ kind: "ptr", type: "Node *", value: addr, addr, to: "Node", state: "heap", block: addr, ...extra });
const struct = (fields) => ({ kind: "struct", type: "Node", fields });
const block = (value, extra = {}) => ({ kind: "block", size: 16, live: true, ty: "Node", v: value, ...extra });

test("keeps a scalar and rejects an unknown kind", () => {
  assert.deepEqual(sanitizeValue(int(5)), { kind: "int", type: "int", value: "5" });
  assert.equal(sanitizeValue({ kind: "wizard", type: "int", value: "1" }), null);
  assert.equal(sanitizeValue(null), null);
  assert.equal(sanitizeValue("5"), null);
});

test("an array keeps its items as plain strings and its window metadata", () => {
  const clean = sanitizeValue({ kind: "array", type: "int [9]", len: 9, elem: "int", elemSize: 4, elemKind: "int", items: ["1", "2"], more: 7 });
  assert.deepEqual(clean.items, ["1", "2"]);
  assert.equal(clean.len, 9);
  assert.equal(clean.more, 7);
  assert.equal(clean.elemKind, "int");
});

test("an oversized items list is cut to the window the tracer promises", () => {
  const items = Array.from({ length: LIMITS.maxItems + 50 }, (_, index) => String(index));
  const clean = sanitizeValue({ kind: "array", type: "int [200]", len: 200, elem: "int", elemSize: 4, items });
  assert.equal(clean.items.length, LIMITS.maxItems);
});

test("a struct field called __proto__ stays plain data and pollutes nothing", () => {
  const clean = sanitizeValue(struct([{ name: "__proto__", v: int(1) }, { name: "constructor", v: int(2) }]));
  assert.deepEqual(clean.fields.map((field) => field.name), ["__proto__", "constructor"]);
  assert.equal(Object.getPrototypeOf(clean.fields[0]), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(clean.fields[0]).sort(), ["name", "v"]);
});

test("forged pointer fields are re-derived: bad address and bad state are dropped", () => {
  const clean = sanitizeValue(pointer("0xZZ", { state: "owned-by-me", block: "javascript:alert(1)", text: 7 }));
  assert.equal(clean.addr, undefined);
  assert.equal(clean.state, null);
  assert.equal(clean.block, undefined);
  assert.equal(clean.text, undefined);
});

test("nesting deeper than the limit collapses instead of recursing without bound", () => {
  let nested = int(1);
  for (let level = 0; level < 5000; level += 1) nested = struct([{ name: "x", v: nested }]);
  const clean = sanitizeValue(nested);
  let depth = 0;
  for (let cursor = clean; cursor.kind === "struct"; cursor = cursor.fields[0].v) depth += 1;
  assert.ok(depth <= 10, `kept ${depth} levels`);
});

test("one step cannot hold more entries than the budget, however it is shaped", () => {
  const wide = struct(Array.from({ length: LIMITS.maxFields }, (_, index) => ({ name: `f${index}`, v: struct(Array.from({ length: LIMITS.maxFields }, (_, inner) => ({ name: `g${inner}`, v: int(inner) }))) })));
  const budget = { left: 100 };
  const clean = sanitizeValue(wide, budget);
  const count = (value) => 1 + (value.fields ?? []).reduce((sum, field) => sum + count(field.v), 0);
  assert.ok(count(clean) <= 100, `kept ${count(clean)} entries`);
  assert.equal(budget.left, 0, "the budget is spent exactly, never overdrawn");
});

test("heap delta: only valid hex addresses and block entries survive", () => {
  const delta = sanitizeHeapDelta({
    set: { "0x5000": block(struct([])), "__proto__": block(struct([])), "not-hex": block(struct([])), "0x6000": { kind: "int" } },
    del: ["0x7000", "evil"],
  });
  assert.deepEqual([...delta.set.keys()], ["0x5000"]);
  assert.deepEqual(delta.del, ["0x7000"]);
  assert.equal(sanitizeHeapDelta({ set: {}, del: [] }), null);
  assert.equal(sanitizeHeapDelta("x"), null);
});

test("a freed block keeps no contents, an orphan stays marked", () => {
  const delta = sanitizeHeapDelta({ set: { "0x5000": { kind: "block", size: 4, live: false, ty: "int" }, "0x6000": block(struct([]), { orphan: true }) }, del: [] });
  assert.equal(delta.set.get("0x5000").v, undefined);
  assert.equal(delta.set.get("0x5000").live, false);
  assert.equal(delta.set.get("0x6000").orphan, true);
});

// ── the processor: heap deltas become keyframe tables and per-step changes ─────────────────────────────────────────
const stepRecord = (n, heap) => ({ t: "step", n, line: n + 1, fn: "main", depth: 1, stdoutLen: 0, event: "step", frames: [{ fn: "main", line: n + 1, vars: {} }], ...(heap ? { heap } : {}) });
const run = (records) => buildTrace({
  compileExitCode: 0, compileOutput: "", traceText: [...records, { t: "end", status: "exited", exitCode: 0, signal: null, line: null }].map((r) => JSON.stringify(r)).join("\n"),
  stdout: "", stderr: "", timedOut: false,
});

test("processor: a heap change appears on its step, unchanged steps carry none", () => {
  const trace = run([stepRecord(0), stepRecord(1, { set: { "0x5000": block(struct([])) }, del: [] }), stepRecord(2)]);
  assert.equal(trace.steps[0].heap, null);
  assert.deepEqual(Object.keys(trace.steps[1].heap.set), ["0x5000"]);
  assert.equal(trace.steps[1].heap.full, false);
  assert.equal(trace.steps[2].heap, null);
});

test("processor: a keyframe after the heap was built carries the whole table, so a viewer can start there", () => {
  const records = [stepRecord(0), stepRecord(1, { set: { "0x5000": block(struct([])), "0x6000": block(struct([])) }, del: [] })];
  for (let n = 2; n < LIMITS.keyframeEvery; n += 1) records.push(stepRecord(n, n === 5 ? { set: {}, del: ["0x6000"] } : undefined));
  records.push(stepRecord(LIMITS.keyframeEvery));
  const trace = run(records);
  const keyframe = trace.steps[LIMITS.keyframeEvery];
  assert.equal(keyframe.keyframe, true);
  assert.equal(keyframe.heap.full, true);
  assert.deepEqual(Object.keys(keyframe.heap.set), ["0x5000"], "the deleted block is gone from the table");
});

test("processor: a trace without any heap activity stays free of heap data", () => {
  const trace = run([stepRecord(0), stepRecord(1)]);
  assert.ok(trace.steps.every((step) => step.heap === null));
});

// ── findings from the security review: bounds a forged stream must not escape ─────────────────────────────────────
test("plain-text cells are charged to the budget, so many small arrays cannot slip past the cap", () => {
  const cells = Array.from({ length: LIMITS.maxItems }, (_, index) => String(index));
  const array = { kind: "array", type: "int [64]", len: 64, elem: "int", elemSize: 4, items: cells };
  const budget = { left: 40 };
  const clean = sanitizeValue(array, budget);
  assert.ok(clean.items.length <= 40, `kept ${clean.items.length} cells on a budget of 40`);
  assert.ok(budget.left <= 0);
});

test("struct field names cannot carry the characters that separate diagram keys", () => {
  const clean = sanitizeValue(struct([{ name: "a.b[0]/c", v: int(1) }]));
  assert.equal(clean.fields[0].name, "a_b_0__c");
});

test("the heap table is capped like the honest tracer's: a forged stream cannot grow it or the keyframes", () => {
  const records = [stepRecord(0)];
  for (let n = 1; n <= LIMITS.keyframeEvery + 5; n += 1) { // far enough to reach the next keyframe
    const set = {};
    for (let i = 0; i < 100; i += 1) set[`0x${(n * 1000 + i).toString(16)}`] = block(struct([]));
    records.push(stepRecord(n, { set, del: [] })); // 100 new blocks per step, never freed: 5,500 in total
  }
  const trace = run(records);
  const keyframe = trace.steps.find((step, index) => index > 0 && step.keyframe);
  assert.ok(Object.keys(keyframe.heap.set).length <= LIMITS.maxHeapBlocks, `keyframe carried ${Object.keys(keyframe.heap.set).length} blocks`);
});
