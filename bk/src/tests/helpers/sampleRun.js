// Realistic schema-1 traces for the AI tests, built through the REAL buildTrace from raw tracer records (so the shapes can never
// drift from what the runner produces): a program with a heap node, a call and a return, a free, and stdout.
const { buildTrace } = require("../../services/traceProcessor");

const SAMPLE_CODE = [
  "#include <iostream>",
  "struct Node { int val; Node* next; };",
  "int twice(int n) {",
  "    return n * 2;",
  "}",
  "int main() {",
  "    Node* head = new Node{7, nullptr};",
  "    int total = twice(head->val);",
  "    delete head;",
  "    std::cout << \"total = \" << total << std::endl;",
  "    return 0;",
  "}",
  "",
].join("\n");

const ADDRESS = "0x5000";
const int = (value) => ({ kind: "int", type: "int", value: String(value) });
const pointer = (state) => ({
  kind: "ptr", type: "Node*", value: state === "null" ? "0x0" : ADDRESS, addr: state === "null" ? "0x0" : ADDRESS,
  to: "Node", state, ...(state === "null" ? {} : { block: ADDRESS }),
});
const node = (live) => ({
  kind: "block", size: 16, live, ty: "Node",
  v: { kind: "struct", type: "Node", fields: [{ name: "val", v: int(7) }, { name: "next", v: pointer("null") }] },
});

const mainFrame = (line, vars) => ({ fn: "main", line, vars });
const step = (n, line, fn, frames, extra = {}) => ({ t: "step", n, line, fn, event: "step", stdoutLen: 0, frames, ...extra });

const RECORDS = [
  step(0, 7, "main", [mainFrame(7, {})]),
  step(1, 8, "main", [mainFrame(8, { head: pointer("heap") })], { heap: { set: { [ADDRESS]: node(true) }, del: [] } }),
  step(2, 4, "twice", [mainFrame(8, { head: pointer("heap") }), { fn: "twice", line: 4, vars: { n: int(7) } }], { event: "call" }),
  step(3, 8, "main", [mainFrame(8, { head: pointer("heap") })], { event: "return", returned: { fn: "twice", ...int(14) } }),
  step(4, 9, "main", [mainFrame(9, { head: pointer("heap"), total: int(14) })]),
  step(5, 10, "main", [mainFrame(10, { head: pointer("freed"), total: int(14) })], { heap: { set: { [ADDRESS]: node(false) }, del: [] } }),
  step(6, 11, "main", [mainFrame(11, { head: pointer("freed"), total: int(14) })], { stdoutLen: 11 }),
  { t: "end", status: "exited", exitCode: 0, signal: null, line: null },
];

const rawRun = (records, overrides = {}) => ({
  compileExitCode: 0, compileOutput: "", traceText: records.map((record) => JSON.stringify(record)).join("\n"),
  stdout: "", stderr: "", timedOut: false, ...overrides,
});

/** What the runner hands to buildTrace for the sample program (HTTP tests stub runnerService.runTrace with it). */
const sampleRawRun = () => rawRun(RECORDS, { stdout: "total = 14\n" });

/** A finished, successful run of SAMPLE_CODE: 7 steps. */
const sampleTrace = () => buildTrace(sampleRawRun());

/** The same run cut short by a segfault on line 8. */
const crashedTrace = () => buildTrace(rawRun([...RECORDS.slice(0, 3), { t: "end", status: "crashed", exitCode: null, signal: "SIGSEGV", line: 8 }]));

/** A program that did not compile: diagnostics, no steps. */
const compileErrorTrace = () => buildTrace(rawRun([], {
  compileExitCode: 1, traceText: null,
  compileOutput: "/tmp/main.cpp:8:9: error: 'totl' was not declared in this scope\n/tmp/main.cpp:8:9: note: suggested alternative: 'total'",
}));

module.exports = { SAMPLE_CODE, ADDRESS, sampleRawRun, sampleTrace, crashedTrace, compileErrorTrace };
