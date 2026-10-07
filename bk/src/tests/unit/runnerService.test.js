// runnerService without Docker: child_process is mocked, so failure paths and the concurrency counter are testable.
const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const runnerService = require("../../services/runnerService");
const { LIMITS } = require("../../utils/limits");

const { buildDockerArgs, interpretRun, runTrace, getActiveRuns, RunnerError } = runnerService;
const frame = (name, data) => `\u0001CVIS ${name} ${data.length} ${data.length}\n${data}`;
const dockerResult = (overrides = {}) => ({ code: 0, timedOut: false, overflow: false, stderr: "", stdout: Buffer.alloc(0), ...overrides });

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function mockDocker(t, onSpawn) {
  const children = [];
  t.mock.method(childProcess, "spawn", () => {
    const child = fakeChild();
    children.push(child);
    if (onSpawn) onSpawn(child);
    return child;
  });
  t.mock.method(childProcess, "execFile", (...args) => args.at(-1)());
  return children;
}

const finishRun = (child, frames = frame("compile.rc", "0")) => {
  child.stdout.emit("data", Buffer.from(frames));
  child.emit("close", 0);
};

test("docker args carry every isolation flag and expose only the source, read-only", () => {
  const args = buildDockerArgs("cvis-test", "C:\\Users\\x\\Temp\\cvis-abc");
  const joined = args.join(" ");
  for (const flag of ["--network none", "--read-only", "--cap-drop ALL", "no-new-privileges", "--pids-limit 64", "--ulimit core=0"]) {
    assert.ok(joined.includes(flag), `missing ${flag}`);
  }
  assert.ok(!joined.includes("--privileged"));
  assert.ok(args.includes("type=bind,src=C:/Users/x/Temp/cvis-abc,dst=/src,readonly"));
  assert.equal(args.filter((a) => a.includes("type=bind")).length, 1, "only the source may be bind-mounted");
  assert.ok(args.some((a) => a.startsWith("/out:rw,noexec,nosuid,size=")), "results dir must be a size-limited tmpfs");
});

test("interpretRun builds the raw result from frames", () => {
  const raw = interpretRun(dockerResult({
    stdout: Buffer.from(frame("compile.rc", "0") + frame("trace.jsonl", "{}") + frame("stdout.txt", "out")),
  }));
  assert.equal(raw.compileExitCode, 0);
  assert.equal(raw.traceText, "{}");
  assert.equal(raw.stdout, "out");
  assert.equal(raw.stderr, null);
});

test("no frames and no timeout is RUNNER_FAILED with a generic message and the detail kept aside", () => {
  assert.throws(() => interpretRun(dockerResult({ code: 1, stderr: "C:\\secret\\path boom" })), (err) => {
    assert.ok(err instanceof RunnerError);
    assert.equal(err.code, "RUNNER_FAILED");
    assert.ok(!err.message.includes("secret"), "client message must not leak paths");
    assert.match(err.detail, /secret/);
    return true;
  });
});

test("a stopped Docker daemon is RUNNER_UNAVAILABLE", () => {
  assert.throws(() => interpretRun(dockerResult({ code: 125, stderr: "x" })), { code: "RUNNER_UNAVAILABLE" });
  assert.throws(() => interpretRun(dockerResult({ code: 1, stderr: "Cannot connect to the Docker daemon at npipe" })), { code: "RUNNER_UNAVAILABLE" });
});

test("a forged oversized stream is rejected", () => {
  assert.throws(() => interpretRun(dockerResult({ overflow: true })), { code: "RUNNER_FAILED" });
});

test("a timed-out run with no frames is a result, not an error", () => {
  const raw = interpretRun(dockerResult({ timedOut: true }));
  assert.equal(raw.timedOut, true);
  assert.equal(raw.compileExitCode, null);
});

test("a non-numeric compile status is treated as missing, not as a compile error", () => {
  assert.throws(() => interpretRun(dockerResult({ stdout: Buffer.from(frame("compile.rc", "abc")) })), { code: "RUNNER_FAILED" });
});

test("runTrace returns the parsed result and releases its slot", async (t) => {
  mockDocker(t, (child) => setImmediate(() => finishRun(child, frame("compile.rc", "0") + frame("stdout.txt", "hi"))));
  const raw = await runTrace({ code: "int main(){}", stdin: "" });
  assert.equal(raw.stdout, "hi");
  assert.equal(getActiveRuns(), 0);
});

test("a spawn error is RUNNER_UNAVAILABLE and the slot is released", async (t) => {
  mockDocker(t, (child) => setImmediate(() => child.emit("error", new Error("spawn docker ENOENT"))));
  await assert.rejects(runTrace({ code: "x", stdin: "" }), { code: "RUNNER_UNAVAILABLE" });
  assert.equal(getActiveRuns(), 0);
});

test("the concurrency cap rejects surplus runs with BUSY and frees slots afterwards", async (t) => {
  const children = mockDocker(t);
  const running = Array.from({ length: LIMITS.maxConcurrentRuns }, () => runTrace({ code: "x", stdin: "" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(getActiveRuns(), LIMITS.maxConcurrentRuns);
  await assert.rejects(runTrace({ code: "x", stdin: "" }), { code: "BUSY" });
  children.forEach((child) => finishRun(child));
  await Promise.all(running);
  assert.equal(getActiveRuns(), 0);
});

test("a docker that ignores the kill cannot hold a slot forever", async (t) => {
  const children = mockDocker(t);
  const run = runTrace({ code: "x", stdin: "" }, { wallClockMs: 20, killGraceMs: 20 });
  await assert.rejects(run, { code: "RUNNER_FAILED" });
  assert.equal(children[0].killed, true);
  assert.equal(getActiveRuns(), 0);
});

test("a runner that floods stdout is killed and rejected", async (t) => {
  const children = mockDocker(t, (child) => setImmediate(() => {
    child.stdout.emit("data", Buffer.alloc(LIMITS.maxRunnerStdoutBytes + 1));
    child.emit("close", 137);
  }));
  await assert.rejects(runTrace({ code: "x", stdin: "" }), { code: "RUNNER_FAILED" });
  assert.equal(children.length, 1);
  assert.equal(getActiveRuns(), 0);
});
