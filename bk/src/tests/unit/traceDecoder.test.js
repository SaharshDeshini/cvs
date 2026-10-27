// The backend decoder must agree with the frontend's reconstruct.js on the same trace: they are two copies of one algorithm.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { decodeTrace, stdoutAt } = require("../../services/ai/traceDecoder");
const { sampleTrace, crashedTrace } = require("../helpers/sampleRun");

const FRONTEND_RECONSTRUCT = path.join(__dirname, "..", "..", "..", "..", "fe", "src", "lib", "reconstruct.js");
const loadFrontend = () => import(pathToFileURL(FRONTEND_RECONSTRUCT).href); // fe/package.json is "type": "module"

test("decodes one complete view per step, with the heap and the stack carried forward", () => {
  const views = decodeTrace(sampleTrace());
  assert.equal(views.length, 7);
  assert.deepEqual(views[2].frames.map((frame) => frame.fn), ["main", "twice"]);
  assert.equal(views[3].frames.length, 1); // twice has returned
  assert.equal(views[3].returned.value, "14");
  assert.equal(views[1].heap["0x5000"].live, true);
  assert.equal(views[5].heap["0x5000"].live, false); // freed, and still in the table
});

test("agrees with fe/src/lib/reconstruct.js on every step of both sample runs", async () => {
  const frontend = await loadFrontend();
  for (const trace of [sampleTrace(), crashedTrace()]) {
    assert.deepEqual(decodeTrace(trace), frontend.reconstruct(trace));
  }
});

test("stdoutAt agrees with the frontend, including a character cut in half", async () => {
  const frontend = await loadFrontend();
  const trace = { ...sampleTrace(), stdout: "héllo wörld\n" };
  const views = decodeTrace(trace).map((view, index) => ({ ...view, stdoutLen: index * 2 }));
  for (let index = 0; index < views.length; index += 1) {
    assert.equal(stdoutAt(trace, views, index), frontend.stdoutAt(trace, views, index), `step ${index}`);
  }
});

test("does not mutate the trace it decodes", () => {
  const trace = sampleTrace();
  const before = JSON.stringify(trace);
  decodeTrace(trace);
  assert.equal(JSON.stringify(trace), before);
});
